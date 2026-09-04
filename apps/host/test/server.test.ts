import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { zipSync } from "fflate";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteJourneyArchive } from "@agentjourney/archive";
import { builtInAdapters } from "@agentjourney/builtin-adapters";
import { fixturePath } from "@agentjourney/test-fixtures";
import { PluginRegistry, withPluginIntegrity } from "@agentjourney/plugin-runtime";
import { LocalAuth } from "../src/auth.js";
import { CaptureCoordinator } from "../src/capture-coordinator.js";
import { EventHub } from "../src/event-hub.js";
import { createServer } from "../src/server.js";
import { SettingsStore } from "../src/settings.js";

const temporaryRoots: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("loopback host", () => {
  it("requires consent, captures a native source, and serves the Journey", async () => {
    const dataRoot = await mkdtemp(path.join(os.tmpdir(), "agentjourney-host-"));
    temporaryRoots.push(dataRoot);
    const archive = await SqliteJourneyArchive.open(path.join(dataRoot, "archive"));
    const settings = new SettingsStore(path.join(dataRoot, "settings.json"));
    await settings.load();
    const auth = await LocalAuth.load(dataRoot);
    const events = new EventHub();
    const coordinator = new CaptureCoordinator(builtInAdapters, archive, settings, events);
    const pluginRegistry = new PluginRegistry(dataRoot);
    await pluginRegistry.load();
    let exportedQuality: string | undefined;
    let exportedBrowser: string | undefined;
    const app = await createServer({
      archive,
      settings,
      auth,
      events,
      coordinator,
      pluginRegistry,
      videoExporter: {
        async exportReplay(input) {
          exportedQuality = input.options.quality;
          exportedBrowser = input.options.browser;
          return {
            bytes: new Uint8Array([0, 0, 0, 16, 102, 116, 121, 112]),
            fileName: "fixture.mp4",
            frameCount: 2,
            durationMs: 1000
          };
        }
      },
      logger: false
    });

    const denied = await app.inject({ method: "GET", url: "/api/v1/journeys", headers: { host: "localhost" } });
    expect(denied.statusCode).toBe(401);

    const bootstrap = await app.inject({
      method: "POST",
      url: "/api/v1/auth/bootstrap",
      headers: { host: "localhost", origin: "http://localhost:5173" },
      payload: { token: auth.installationSecret }
    });
    expect(bootstrap.statusCode).toBe(200);
    const setCookie = bootstrap.headers["set-cookie"];
    const cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)?.split(";")[0];
    const { csrfToken } = bootstrap.json<{ csrfToken: string }>();
    const headers = {
      host: "localhost",
      origin: "http://localhost:5173",
      cookie: cookie!,
      "x-agentjourney-csrf": csrfToken
    };

    const beforeApproval = await app.inject({
      method: "GET",
      url: "/api/v1/sources/pi/discover",
      headers
    });
    expect(beforeApproval.statusCode).toBe(400);

    const approval = await app.inject({
      method: "POST",
      url: "/api/v1/sources/pi/approve",
      headers,
      payload: { root: fixturePath("pi"), scanPolicy: "manual" }
    });
    expect(approval.statusCode).toBe(201);

    const discovery = await app.inject({ method: "GET", url: "/api/v1/sources/pi/discover", headers });
    expect(discovery.statusCode).toBe(200);
    expect(discovery.json()).toHaveLength(1);
    expect(discovery.json()[0]).toMatchObject({
      startedAt: "2026-01-01T10:00:00.000Z",
      turnCountEstimate: 2
    });
    expect(discovery.json()[0].byteSize).toBeGreaterThan(0);
    expect(new Date(discovery.json()[0].lastModifiedAt).toISOString()).toBe(discovery.json()[0].lastModifiedAt);

    const capture = await app.inject({
      method: "POST",
      url: "/api/v1/captures",
      headers,
      payload: { sourceAgent: "pi" }
    });
    expect(capture.statusCode).toBe(201);
    const result = capture.json<{ results: Array<{ journeyId: string }> }>().results[0]!;

    const list = await app.inject({ method: "GET", url: "/api/v1/journeys", headers });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toHaveLength(1);

    const detail = await app.inject({ method: "GET", url: `/api/v1/journeys/${result.journeyId}`, headers });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().stage.activities.length).toBeGreaterThan(0);

    const video = await app.inject({
      method: "POST",
      url: `/api/v1/journeys/${result.journeyId}/export/mp4`,
      headers,
      payload: {
        rendererId: "builtin.pi",
        browser: "edge",
        quality: "720p",
        speed: 2,
        fps: 30,
        streamMode: "events",
        reveal: false
      }
    });
    expect(video.statusCode).toBe(200);
    expect(video.headers["content-type"]).toContain("video/mp4");
    expect(video.headers["content-disposition"]).toContain("fixture.mp4");
    expect(exportedQuality).toBe("720p");
    expect(exportedBrowser).toBe("edge");

    const search = await app.inject({ method: "GET", url: "/api/v1/search?q=greeting&sourceAgent=pi", headers });
    expect(search.statusCode).toBe(200);
    expect(search.json().length).toBeGreaterThan(0);

    const project = await app.inject({ method: "POST", url: "/api/v1/projects", headers, payload: { name: "Acme" } });
    expect(project.statusCode).toBe(201);
    const overlay = await app.inject({
      method: "PUT",
      url: `/api/v1/journeys/${result.journeyId}/overlay`,
      headers,
      payload: { displayTitle: "Reviewed Journey", projectId: project.json().id, tags: ["audit"] }
    });
    expect(overlay.statusCode).toBe(200);

    const evidenceSearch = await app.inject({
      method: "GET",
      url: `/api/v1/journeys/${result.journeyId}/evidence/search?revisionId=${detail.json().revisionId}&q=greeting`,
      headers
    });
    expect(evidenceSearch.statusCode).toBe(200);
    expect(evidenceSearch.json().length).toBeGreaterThan(0);

    const packageExport = await app.inject({ method: "GET", url: `/api/v1/journeys/${result.journeyId}/export/package`, headers });
    expect(packageExport.statusCode).toBe(200);
    expect(packageExport.headers["content-type"]).toContain("application/vnd.agentjourney+zip");
    expect(packageExport.rawPayload.byteLength).toBeGreaterThan(100);

    const htmlExport = await app.inject({ method: "GET", url: `/api/v1/journeys/${result.journeyId}/export/html?rendererId=builtin.pi`, headers });
    expect(htmlExport.statusCode).toBe(200);
    expect(htmlExport.body).toContain("Presentation redaction enabled");

    const rawFixturePath = path.join(
      fixturePath("pi"),
      "acme",
      "2026-01-01T10-00-00-000Z_33333333-3333-4333-8333-333333333333.jsonl"
    );
    const sourceBundle = zipSync({ "manual/pi-session.jsonl": await readFile(rawFixturePath) }, { level: 0 });
    const rawImport = await app.inject({
      method: "POST",
      url: "/api/v1/imports/source-bundle/pi",
      headers: { ...headers, "content-type": "application/vnd.agentjourney.source-bundle+zip" },
      payload: Buffer.from(sourceBundle)
    });
    expect(rawImport.statusCode).toBe(201);
    expect(rawImport.json().results).toHaveLength(1);

    const verification = await app.inject({ method: "GET", url: "/api/v1/archive/verify", headers });
    expect(verification.json().issues).toEqual([]);

    const pluginPackage = withPluginIntegrity({
      formatVersion: 1,
      manifest: {
        type: "renderer",
        id: "test.renderer",
        version: "1.0.0",
        displayName: "Test Renderer",
        interfaceVersion: "^1.0.0",
        kind: "style-pack"
      },
      css: ":root { --stage-accent: #fff; }"
    });
    const installedPlugin = await app.inject({ method: "POST", url: "/api/v1/plugins/install", headers, payload: pluginPackage });
    expect(installedPlugin.statusCode).toBe(201);
    const renderers = await app.inject({ method: "GET", url: "/api/v1/plugins/renderers", headers });
    expect(renderers.json()[0].manifest.id).toBe("test.renderer");

    const rotated = await app.inject({ method: "POST", url: "/api/v1/auth/rotate", headers });
    expect(rotated.statusCode).toBe(200);
    const oldSession = await app.inject({ method: "GET", url: "/api/v1/journeys", headers });
    expect(oldSession.statusCode).toBe(401);

    await app.close();
    archive.close();
  });

  it("serves the packaged SPA and preserves authenticated bootstrap", async () => {
    const dataRoot = await mkdtemp(path.join(os.tmpdir(), "agentjourney-host-"));
    temporaryRoots.push(dataRoot);
    const webRoot = path.join(dataRoot, "web");
    await mkdir(path.join(webRoot, "assets"), { recursive: true });
    await writeFile(path.join(webRoot, "index.html"), "<!doctype html><title>Packaged AgentJourney</title><div id=\"root\"></div>");
    await writeFile(path.join(webRoot, "assets", "app.js"), "globalThis.PACKAGED_AGENTJOURNEY=true;");
    const archive = await SqliteJourneyArchive.open(path.join(dataRoot, "archive"));
    const settings = new SettingsStore(path.join(dataRoot, "settings.json"));
    await settings.load();
    const auth = await LocalAuth.load(dataRoot);
    const events = new EventHub();
    const coordinator = new CaptureCoordinator(builtInAdapters, archive, settings, events);
    const app = await createServer({ archive, settings, auth, events, coordinator, webDirectory: webRoot, logger: false });

    const entry = await app.inject({ method: "GET", url: "/", headers: { host: "localhost" } });
    expect(entry.statusCode).toBe(302);
    expect(entry.headers.location).toBe(`/?token=${encodeURIComponent(auth.installationSecret)}`);
    const deepEntry = await app.inject({
      method: "GET",
      url: `/?returnTo=${encodeURIComponent("/journeys/example?view=replay")}`,
      headers: { host: "localhost" }
    });
    expect(deepEntry.headers.location).toBe(`/journeys/example?view=replay&token=${encodeURIComponent(auth.installationSecret)}`);
    const rejectedReturn = await app.inject({
      method: "GET",
      url: `/?returnTo=${encodeURIComponent("//attacker.example/steal")}`,
      headers: { host: "localhost" }
    });
    expect(rejectedReturn.headers.location).toBe(`/?token=${encodeURIComponent(auth.installationSecret)}`);
    const bootstrappedEntry = await app.inject({ method: "GET", url: entry.headers.location!, headers: { host: "localhost" } });
    expect(bootstrappedEntry.statusCode).toBe(200);
    expect(bootstrappedEntry.body).toContain("Packaged AgentJourney");

    const asset = await app.inject({ method: "GET", url: "/assets/app.js", headers: { host: "localhost" } });
    expect(asset.statusCode).toBe(200);
    expect(asset.body).toContain("PACKAGED_AGENTJOURNEY");
    const spaRoute = await app.inject({ method: "GET", url: "/journeys/example", headers: { host: "localhost" } });
    expect(spaRoute.statusCode).toBe(200);
    expect(spaRoute.body).toContain("Packaged AgentJourney");
    const missingApi = await app.inject({ method: "GET", url: "/api/v1/not-real", headers: { host: "localhost" } });
    expect(missingApi.statusCode).toBe(401);

    await app.close();
    archive.close();
  });

  it("rejects DNS-rebinding host headers", async () => {
    const dataRoot = await mkdtemp(path.join(os.tmpdir(), "agentjourney-host-"));
    temporaryRoots.push(dataRoot);
    const archive = await SqliteJourneyArchive.open(path.join(dataRoot, "archive"));
    const settings = new SettingsStore(path.join(dataRoot, "settings.json"));
    await settings.load();
    const auth = await LocalAuth.load(dataRoot);
    const events = new EventHub();
    const coordinator = new CaptureCoordinator(builtInAdapters, archive, settings, events);
    const app = await createServer({ archive, settings, auth, events, coordinator, logger: false });

    const response = await app.inject({ method: "GET", url: "/api/v1/health", headers: { host: "attacker.example" } });
    expect(response.statusCode).toBe(403);

    await app.close();
    archive.close();
  });
});
