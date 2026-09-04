import { randomUUID } from "node:crypto";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import { unzipSync } from "fflate";
import { compareInterpretations } from "@agentjourney/activity-graph";
import type { JourneyArchive, ReviewOverlayUpdate, SearchOptions } from "@agentjourney/archive";
import { builtInStylePacks, rendererForSourceAgent } from "@agentjourney/builtin-renderers";
import { renderPresentationHtml } from "@agentjourney/portability";
import type { CaptureCoordinator } from "./capture-coordinator.js";
import type { EventHub } from "./event-hub.js";
import type { LocalAuth } from "./auth.js";
import type { SettingsStore } from "./settings.js";
import type { AutomaticScanner } from "./automatic-scanner.js";
import { evaluateRenderer, type PluginRegistry } from "@agentjourney/plugin-runtime";
import { assertRendererTreeDocument, assertStageDocument } from "@agentjourney/contracts/validate";
import { FilesystemSource } from "./filesystem-source.js";
import {
  validateReplayVideoOptions,
  type ReplayVideoExporter
} from "./replay-video-exporter.js";

export interface ServerDependencies {
  archive: JourneyArchive;
  coordinator: CaptureCoordinator;
  events: EventHub;
  auth: LocalAuth;
  settings: SettingsStore;
  automaticScanner?: AutomaticScanner;
  pluginRegistry?: PluginRegistry;
  videoExporter?: ReplayVideoExporter;
  webDirectory?: string;
  version?: string;
  logger?: boolean;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}

function safeReturnPath(value: unknown): string {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//")) return "/";
  try {
    const parsed = new URL(value, "http://agentjourney.local");
    return parsed.origin === "http://agentjourney.local"
      ? `${parsed.pathname}${parsed.search}${parsed.hash}`
      : "/";
  } catch {
    return "/";
  }
}

function bootstrapLocation(base: string, returnTo: unknown, secret: string): string {
  const target = new URL(safeReturnPath(returnTo), base);
  target.searchParams.set("token", secret);
  return base === "http://agentjourney.local"
    ? `${target.pathname}${target.search}${target.hash}`
    : target.toString();
}

function assertRendererTreeBudget(value: unknown): void {
  const root = (value as { root?: unknown } | null)?.root;
  const stack: Array<{ value: unknown; depth: number }> = [{ value: root, depth: 1 }];
  let nodes = 0;
  while (stack.length > 0) {
    const current = stack.pop()!;
    nodes += 1;
    if (nodes > 10_000) throw new Error("Renderer tree exceeds 10,000 nodes");
    if (current.depth > 64) throw new Error("Renderer tree exceeds 64 levels");
    if (!current.value || typeof current.value !== "object" || Array.isArray(current.value)) continue;
    const children = (current.value as { children?: unknown }).children;
    if (Array.isArray(children)) {
      for (const child of children) stack.push({ value: child, depth: current.depth + 1 });
    }
  }
}

function sourceBundleFiles(bytes: Uint8Array): Array<{ relativePath: string; bytes: Uint8Array }> {
  let declaredExpandedBytes = 0;
  const entries = unzipSync(bytes, {
    filter(file) {
      if (!file.name || file.name.startsWith("/") || file.name.includes("\\") || file.name.split("/").includes("..")) {
        throw new Error(`Unsafe source bundle path: ${file.name}`);
      }
      declaredExpandedBytes += file.originalSize;
      if (declaredExpandedBytes > 2 * 1024 * 1024 * 1024) throw new Error("Source Bundle exceeds the 2 GB expanded limit");
      return true;
    }
  });
  let total = 0;
  return Object.entries(entries)
    .filter(([entry]) => !entry.endsWith("/"))
    .map(([entry, content]) => {
      if (!entry || entry.startsWith("/") || entry.includes("\\") || entry.split("/").includes("..")) {
        throw new Error(`Unsafe source bundle path: ${entry}`);
      }
      total += content.byteLength;
      if (total > 2 * 1024 * 1024 * 1024) throw new Error("Source Bundle exceeds the 2 GB expanded limit");
      return { relativePath: entry, bytes: content };
    });
}

export async function createServer(dependencies: ServerDependencies): Promise<FastifyInstance> {
  const app = Fastify({ logger: dependencies.logger ?? true, bodyLimit: 512 * 1024 * 1024 });
  for (const contentType of ["application/octet-stream", "application/vnd.agentjourney.source-bundle+zip"]) {
    app.addContentTypeParser(contentType, { parseAs: "buffer" }, (_request, body, done) => done(null, body));
  }
  await dependencies.auth.register(app);

  app.get("/api/v1/health", async () => ({ product: "agentjourney", status: "ok", version: dependencies.version ?? "0.0.0" }));
  app.get("/api/v1/sources", async () => dependencies.coordinator.listSources());

  app.post("/api/v1/sources/:sourceAgent/approve", async (request, reply) => {
    const { sourceAgent } = request.params as { sourceAgent: string };
    const body = request.body as { root?: unknown; scanPolicy?: unknown } | null;
    if (typeof body?.root !== "string" || !body.root) return reply.code(400).send({ error: "root_required" });
    const scanPolicy = body.scanPolicy === "automatic" ? "automatic" : "manual";
    try {
      const source = await FilesystemSource.open(body.root);
      await dependencies.settings.approveSourceRoot({ sourceAgent, root: source.rootId, scanPolicy });
      return reply.code(201).send({ sourceAgent, root: source.rootId, scanPolicy });
    } catch (error) {
      return reply.code(400).send({ error: "invalid_source_root", message: errorMessage(error) });
    }
  });

  app.delete("/api/v1/sources/:sourceAgent/approval", async (request, reply) => {
    const { sourceAgent } = request.params as { sourceAgent: string };
    await dependencies.settings.revokeSourceRoot(sourceAgent);
    return reply.code(204).send();
  });

  app.get("/api/v1/sources/:sourceAgent/discover", async (request, reply) => {
    const { sourceAgent } = request.params as { sourceAgent: string };
    try {
      return await dependencies.coordinator.discover(sourceAgent);
    } catch (error) {
      return reply.code(400).send({ error: "discovery_failed", message: errorMessage(error) });
    }
  });

  app.post("/api/v1/captures", async (request, reply) => {
    const body = request.body as { sourceAgent?: unknown; nativeSessionIds?: unknown } | null;
    if (typeof body?.sourceAgent !== "string") return reply.code(400).send({ error: "source_agent_required" });
    const nativeSessionIds = Array.isArray(body.nativeSessionIds)
      ? body.nativeSessionIds.filter((value): value is string => typeof value === "string")
      : undefined;
    try {
      return reply.code(201).send(await dependencies.coordinator.capture(body.sourceAgent, nativeSessionIds));
    } catch (error) {
      return reply.code(400).send({ error: "capture_failed", message: errorMessage(error) });
    }
  });

  app.post("/api/v1/automatic-scan/run", async (_request, reply) => {
    if (!dependencies.automaticScanner) return reply.code(503).send({ error: "automatic_scanner_unavailable" });
    await dependencies.automaticScanner.runCycle();
    return { status: "completed" };
  });

  app.get("/api/v1/journeys", async () => dependencies.archive.listJourneys());
  app.get("/api/v1/journeys/:journeyId", async (request, reply) => {
    const { journeyId } = request.params as { journeyId: string };
    const query = request.query as { revisionId?: string; interpretationId?: string; reveal?: string };
    const journey = await dependencies.archive.getJourney(journeyId, {
      ...(query.revisionId ? { revisionId: query.revisionId } : {}),
      ...(query.interpretationId ? { interpretationId: query.interpretationId } : {}),
      redacted: query.reveal !== "true"
    });
    return journey ?? reply.code(404).send({ error: "journey_not_found" });
  });

  app.post("/api/v1/journeys/:journeyId/reinterpret", async (request, reply) => {
    const { journeyId } = request.params as { journeyId: string };
    const body = request.body as { revisionId?: unknown } | null;
    if (typeof body?.revisionId !== "string") return reply.code(400).send({ error: "revision_required" });
    try {
      return await dependencies.coordinator.reinterpretJourney(journeyId, body.revisionId);
    } catch (error) {
      return reply.code(400).send({ error: "reinterpretation_failed", message: errorMessage(error) });
    }
  });

  app.get("/api/v1/journeys/:journeyId/compare", async (request, reply) => {
    const { journeyId } = request.params as { journeyId: string };
    const query = request.query as { beforeRevisionId?: string; beforeInterpretationId?: string; afterRevisionId?: string; afterInterpretationId?: string };
    if (!query.beforeRevisionId || !query.afterRevisionId) return reply.code(400).send({ error: "two_revisions_required" });
    const [before, after] = await Promise.all([
      dependencies.archive.getJourney(journeyId, {
        revisionId: query.beforeRevisionId,
        ...(query.beforeInterpretationId ? { interpretationId: query.beforeInterpretationId } : {}),
        redacted: true
      }),
      dependencies.archive.getJourney(journeyId, {
        revisionId: query.afterRevisionId,
        ...(query.afterInterpretationId ? { interpretationId: query.afterInterpretationId } : {}),
        redacted: true
      })
    ]);
    if (!before || !after) return reply.code(404).send({ error: "comparison_selection_not_found" });
    return compareInterpretations(before.interpretation, after.interpretation);
  });

  app.get("/api/v1/journeys/:journeyId/evidence", async (request, reply) => {
    const { journeyId } = request.params as { journeyId: string };
    const query = request.query as { revisionId?: string; path?: string; reveal?: string };
    if (!query.revisionId || !query.path) return reply.code(400).send({ error: "revision_and_path_required" });
    const journey = await dependencies.archive.getJourney(journeyId, { revisionId: query.revisionId });
    if (!journey) return reply.code(404).send({ error: "journey_not_found" });
    const bytes = await dependencies.archive.readSourceFile(query.revisionId, query.path, query.reveal !== "true");
    if (!bytes) return reply.code(404).send({ error: "evidence_file_not_found" });
    reply.type("text/plain; charset=utf-8");
    return reply.send(Buffer.from(bytes));
  });

  app.get("/api/v1/journeys/:journeyId/evidence/search", async (request, reply) => {
    const { journeyId } = request.params as { journeyId: string };
    const query = request.query as { revisionId?: string; q?: string; reveal?: string };
    if (!query.revisionId || !query.q) return reply.code(400).send({ error: "revision_and_query_required" });
    if (!(await dependencies.archive.getJourney(journeyId, { revisionId: query.revisionId }))) {
      return reply.code(404).send({ error: "journey_not_found" });
    }
    return dependencies.archive.searchEvidence(query.revisionId, query.q, query.reveal !== "true");
  });

  app.put("/api/v1/journeys/:journeyId/overlay", async (request, reply) => {
    const { journeyId } = request.params as { journeyId: string };
    try {
      return await dependencies.archive.updateReviewOverlay(journeyId, request.body as ReviewOverlayUpdate);
    } catch (error) {
      return reply.code(400).send({ error: "overlay_update_failed", message: errorMessage(error) });
    }
  });

  app.put("/api/v1/journeys/:journeyId/annotations", async (request, reply) => {
    const { journeyId } = request.params as { journeyId: string };
    const body = request.body as { evidenceAnchor?: unknown; bookmarked?: unknown; note?: unknown } | null;
    if (typeof body?.evidenceAnchor !== "string") return reply.code(400).send({ error: "evidence_anchor_required" });
    return dependencies.archive.updateReviewAnnotation(journeyId, body.evidenceAnchor, {
      bookmarked: body.bookmarked === true,
      ...(typeof body.note === "string" || body.note === null ? { note: body.note } : {})
    });
  });

  app.delete("/api/v1/journeys/:journeyId", async (request, reply) => {
    const { journeyId } = request.params as { journeyId: string };
    const query = request.query as { exclude?: string };
    return (await dependencies.archive.deleteJourney(journeyId, query.exclude !== "false"))
      ? reply.code(204).send()
      : reply.code(404).send({ error: "journey_not_found" });
  });

  app.get("/api/v1/search", async (request) => {
    const query = request.query as Record<string, string | undefined>;
    const options: SearchOptions = {
      ...(query.q ? { query: query.q } : {}),
      ...(query.sourceAgent ? { sourceAgent: query.sourceAgent } : {}),
      ...(query.kind ? { kind: query.kind } : {}),
      ...(query.capability ? { capability: query.capability } : {}),
      ...(query.projectId ? { projectId: query.projectId } : {}),
      ...(query.from ? { from: query.from } : {}),
      ...(query.until ? { until: query.until } : {}),
      ...(query.journeyId ? { journeyId: query.journeyId } : {}),
      ...(query.limit ? { limit: Number(query.limit) } : {})
    };
    return dependencies.archive.search(options);
  });

  app.get("/api/v1/projects", async () => dependencies.archive.listProjects());
  app.post("/api/v1/projects", async (request, reply) => {
    const body = request.body as { name?: unknown } | null;
    if (typeof body?.name !== "string") return reply.code(400).send({ error: "project_name_required" });
    try {
      return reply.code(201).send(await dependencies.archive.createProject(body.name));
    } catch (error) {
      return reply.code(400).send({ error: "project_create_failed", message: errorMessage(error) });
    }
  });

  app.patch("/api/v1/projects/:projectId", async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    const body = request.body as { name?: unknown } | null;
    if (typeof body?.name !== "string") return reply.code(400).send({ error: "project_name_required" });
    try {
      return await dependencies.archive.renameProject(projectId, body.name);
    } catch (error) {
      return reply.code(400).send({ error: "project_rename_failed", message: errorMessage(error) });
    }
  });
  app.post("/api/v1/projects/:projectId/merge", async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    const body = request.body as { targetProjectId?: unknown } | null;
    if (typeof body?.targetProjectId !== "string") return reply.code(400).send({ error: "target_project_required" });
    try {
      return await dependencies.archive.mergeProjects(projectId, body.targetProjectId);
    } catch (error) {
      return reply.code(400).send({ error: "project_merge_failed", message: errorMessage(error) });
    }
  });
  app.delete("/api/v1/projects/:projectId", async (request, reply) => {
    const { projectId } = request.params as { projectId: string };
    return (await dependencies.archive.deleteProject(projectId))
      ? reply.code(204).send()
      : reply.code(404).send({ error: "project_not_found" });
  });

  app.get("/api/v1/pending-evidence", async () => dependencies.archive.listPendingEvidence());
  app.post("/api/v1/pending-evidence/:id/retry", async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      return await dependencies.coordinator.retryPending(id);
    } catch (error) {
      return reply.code(400).send({ error: "pending_retry_failed", message: errorMessage(error) });
    }
  });
  app.delete("/api/v1/pending-evidence/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    await dependencies.archive.deletePendingEvidence(id);
    return reply.code(204).send();
  });

  app.get("/api/v1/capture-exclusions", async () => dependencies.archive.listCaptureExclusions());
  app.delete("/api/v1/capture-exclusions/:sourceAgent/:nativeSessionId", async (request, reply) => {
    const { sourceAgent, nativeSessionId } = request.params as { sourceAgent: string; nativeSessionId: string };
    await dependencies.archive.removeCaptureExclusion(sourceAgent, nativeSessionId);
    return reply.code(204).send();
  });

  app.get("/api/v1/retention", async () => (await dependencies.archive.getRetentionPolicy()) ?? { id: "archive", scope: "archive" });
  app.put("/api/v1/retention", async (request, reply) => {
    const body = request.body as { keepLastRevisions?: unknown } | null;
    const keep = typeof body?.keepLastRevisions === "number" ? body.keepLastRevisions : undefined;
    try {
      return await dependencies.archive.setRetentionPolicy(keep);
    } catch (error) {
      return reply.code(400).send({ error: "retention_update_failed", message: errorMessage(error) });
    }
  });
  app.post("/api/v1/retention/apply", async () => dependencies.archive.applyRetentionPolicy());

  app.get("/api/v1/journeys/:journeyId/export/package", async (request, reply) => {
    const { journeyId } = request.params as { journeyId: string };
    try {
      const bytes = await dependencies.archive.exportJourneyPackage([journeyId]);
      reply.header("content-disposition", `attachment; filename=\"${journeyId.slice(0, 12)}.agentjourney\"`);
      reply.type("application/vnd.agentjourney+zip");
      return reply.send(Buffer.from(bytes));
    } catch (error) {
      return reply.code(400).send({ error: "package_export_failed", message: errorMessage(error) });
    }
  });

  app.post("/api/v1/imports/source-bundle/:sourceAgent", async (request, reply) => {
    const { sourceAgent } = request.params as { sourceAgent: string };
    if (!Buffer.isBuffer(request.body)) return reply.code(400).send({ error: "binary_source_bundle_required" });
    try {
      return reply.code(201).send(await dependencies.coordinator.importSourceBundle(sourceAgent, sourceBundleFiles(request.body)));
    } catch (error) {
      return reply.code(400).send({ error: "source_bundle_import_failed", message: errorMessage(error) });
    }
  });

  app.post("/api/v1/imports/journey-package", async (request, reply) => {
    if (!Buffer.isBuffer(request.body)) return reply.code(400).send({ error: "binary_package_required" });
    try {
      return reply.code(201).send(await dependencies.archive.importJourneyPackage(request.body));
    } catch (error) {
      return reply.code(400).send({ error: "package_import_failed", message: errorMessage(error) });
    }
  });

  app.post("/api/v1/journeys/:journeyId/export/mp4", async (request, reply) => {
    if (!dependencies.videoExporter) return reply.code(503).send({ error: "video_export_unavailable" });
    const { journeyId } = request.params as { journeyId: string };
    const requestedExportId = request.body && typeof request.body === "object" && !Array.isArray(request.body)
      ? (request.body as Record<string, unknown>).exportId
      : undefined;
    let exportId = typeof requestedExportId === "string" && requestedExportId ? requestedExportId : randomUUID();
    try {
      const options = validateReplayVideoOptions(request.body);
      exportId = options.exportId ?? exportId;
      const journey = await dependencies.archive.getJourney(journeyId, {
        ...(options.revisionId ? { revisionId: options.revisionId } : {}),
        ...(options.interpretationId ? { interpretationId: options.interpretationId } : {}),
        redacted: !options.reveal
      });
      if (!journey) return reply.code(404).send({ error: "journey_not_found" });
      const renderers = [...builtInStylePacks, ...(dependencies.pluginRegistry?.renderers() ?? [])];
      const renderer = renderers.find(({ manifest }) => manifest.id === options.rendererId);
      if (!renderer) return reply.code(400).send({ error: "renderer_not_found" });
      const video = await dependencies.videoExporter.exportReplay({
        stage: journey.stage,
        renderer,
        options,
        onProgress(progress) {
          dependencies.events.publish({
            type: "video-export-progress",
            at: new Date().toISOString(),
            data: {
              exportId,
              journeyId,
              status: progress.phase === "completed" ? "completed" : "running",
              ...progress
            }
          });
        }
      });
      reply.header("content-disposition", `attachment; filename=\"${video.fileName}\"`);
      reply.header("content-length", String(video.bytes.byteLength));
      reply.type("video/mp4");
      return reply.send(Buffer.from(video.bytes));
    } catch (error) {
      dependencies.events.publish({
        type: "video-export-progress",
        at: new Date().toISOString(),
        data: {
          exportId,
          journeyId,
          status: "failed",
          phase: "failed",
          percent: 0,
          message: errorMessage(error)
        }
      });
      return reply.code(400).send({ error: "video_export_failed", message: errorMessage(error) });
    }
  });

  app.get("/api/v1/journeys/:journeyId/export/html", async (request, reply) => {
    const { journeyId } = request.params as { journeyId: string };
    const query = request.query as { rendererId?: string; reveal?: string; revisionId?: string; interpretationId?: string };
    const journey = await dependencies.archive.getJourney(journeyId, {
      ...(query.revisionId ? { revisionId: query.revisionId } : {}),
      ...(query.interpretationId ? { interpretationId: query.interpretationId } : {}),
      redacted: query.reveal !== "true"
    });
    if (!journey) return reply.code(404).send({ error: "journey_not_found" });
    const renderers = [...builtInStylePacks, ...(dependencies.pluginRegistry?.renderers() ?? [])];
    const selectedRenderer = renderers.find(({ manifest }) => manifest.id === query.rendererId)
      ?? rendererForSourceAgent(journey.summary.sourceAgent);
    const exportRenderer = selectedRenderer.javascript
      ? rendererForSourceAgent("neutral-fallback")
      : selectedRenderer;
    const html = renderPresentationHtml(journey.stage, exportRenderer);
    reply.header("content-disposition", `attachment; filename=\"${journeyId.slice(0, 12)}.html\"`);
    reply.type("text/html; charset=utf-8");
    return html;
  });

  app.get("/api/v1/plugins", async () =>
    dependencies.pluginRegistry?.list().map(({ document, installedAt, development }) => ({
      manifest: document.manifest,
      integrity: document.integrity,
      installedAt,
      development
    })) ?? []
  );
  app.get("/api/v1/plugins/renderers", async () => dependencies.pluginRegistry?.renderers() ?? []);
  app.get("/api/v1/plugins/diagnostics", async () => dependencies.pluginRegistry?.listDiagnostics() ?? []);
  app.post("/api/v1/plugins/renderers/:rendererId/render", async (request, reply) => {
    const { rendererId } = request.params as { rendererId: string };
    const plugin = dependencies.pluginRegistry?.rendererPackage(rendererId);
    if (!plugin?.javascript) return reply.code(404).send({ error: "executable_renderer_not_found" });
    try {
      assertStageDocument(request.body);
      const tree = await evaluateRenderer(plugin.javascript, request.body);
      assertRendererTreeBudget(tree);
      assertRendererTreeDocument(tree);
      return tree;
    } catch (error) {
      return reply.code(400).send({ error: "renderer_failed", message: errorMessage(error) });
    }
  });
  app.post("/api/v1/plugins/install", async (request, reply) => {
    if (!dependencies.pluginRegistry) return reply.code(503).send({ error: "plugin_registry_unavailable" });
    try {
      const installed = await dependencies.pluginRegistry.install(request.body);
      return reply.code(201).send({
        manifest: installed.document.manifest,
        integrity: installed.document.integrity,
        installedAt: installed.installedAt
      });
    } catch (error) {
      return reply.code(400).send({ error: "plugin_install_failed", message: errorMessage(error) });
    }
  });

  app.get("/api/v1/archive/verify", async () => dependencies.archive.verify());
  app.post("/api/v1/archive/repair", async () => dependencies.archive.repair());

  app.get("/api/v1/events", async (_request, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive"
    });
    dependencies.events.attach(reply);
  });

  if (dependencies.webDirectory) {
    await app.register(fastifyStatic, {
      root: dependencies.webDirectory,
      prefix: "/",
      index: false,
      redirect: false,
      maxAge: "1y",
      immutable: true
    });
    app.get("/", async (request, reply) => {
      const query = request.query as { token?: string; returnTo?: string };
      if (!query.token) {
        return reply.redirect(bootstrapLocation(
          "http://agentjourney.local",
          query.returnTo,
          dependencies.auth.installationSecret
        ));
      }
      return reply.sendFile("index.html", { maxAge: 0, immutable: false });
    });
    app.setNotFoundHandler(async (request, reply) => {
      const pathName = request.url.split("?")[0] ?? "/";
      const isSpaNavigation = ["GET", "HEAD"].includes(request.method)
        && !pathName.startsWith("/api/")
        && path.posix.extname(pathName) === "";
      return isSpaNavigation
        ? reply.sendFile("index.html", { maxAge: 0, immutable: false })
        : reply.code(404).send({ error: "not_found" });
    });
  } else {
    app.get("/", async (request, reply) => {
      const webOrigin = process.env.AGENTJOURNEY_WEB_ORIGIN ?? "http://127.0.0.1:5173";
      const query = request.query as { returnTo?: string };
      return reply.redirect(bootstrapLocation(webOrigin, query.returnTo, dependencies.auth.installationSecret));
    });
  }

  return app;
}
