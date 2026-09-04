import type {
  ArchiveVerificationDocument,
  CaptureCommitResultDocument,
  DiscoveredJourneyDocument,
  EvidenceSearchHitDocument,
  JourneyDetailDocument,
  JourneySummaryDocument,
  PendingEvidenceDocument,
  ProjectDocument,
  RendererTreeDocument,
  ReplayVideoExportOptionsDocument,
  ReviewOverlayDocument,
  SearchHitDocument,
  SourceStatusDocument
} from "@agentjourney/contracts";
import type { RendererPlugin } from "@agentjourney/plugin-sdk";

let csrfToken = "";
const AUTH_REDIRECT_KEY = "agentjourney:auth-redirect";

export function localHostUrl(): string {
  const configured = import.meta.env.VITE_AGENTJOURNEY_HOST_ORIGIN as string | undefined;
  if (configured) return new URL("/", configured).toString();
  const host = new URL(window.location.href);
  if (import.meta.env.DEV) host.port = "4317";
  host.pathname = "/";
  host.search = "";
  host.hash = "";
  return host.toString();
}

function redirectThroughHost(): Promise<never> {
  if (window.sessionStorage.getItem(AUTH_REDIRECT_KEY) === "pending") {
    throw new Error("Local authorization redirect did not complete. Ensure the host is running and open its URL.");
  }
  window.sessionStorage.setItem(AUTH_REDIRECT_KEY, "pending");
  const host = new URL(localHostUrl());
  host.searchParams.set("returnTo", `${window.location.pathname}${window.location.search}${window.location.hash}`);
  window.location.replace(host);
  return new Promise<never>(() => {});
}

async function parseResponse<T>(response: Response): Promise<T> {
  if (response.status === 204) return undefined as T;
  const body = (await response.json()) as T & { message?: string; error?: string };
  if (!response.ok) throw new Error(body.message ?? body.error ?? `Request failed (${response.status})`);
  return body;
}

export async function initializeLocalAuth(): Promise<void> {
  const url = new URL(window.location.href);
  const token = url.searchParams.get("token");
  if (token) {
    const response = await fetch("/api/v1/auth/bootstrap", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token })
    });
    const result = await parseResponse<{ csrfToken: string }>(response);
    csrfToken = result.csrfToken;
    window.sessionStorage.removeItem(AUTH_REDIRECT_KEY);
    url.searchParams.delete("token");
    window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
    return;
  }
  const response = await fetch("/api/v1/auth/session", { credentials: "include" });
  if (response.status === 401) return redirectThroughHost();
  const result = await parseResponse<{ csrfToken: string }>(response);
  csrfToken = result.csrfToken;
  window.sessionStorage.removeItem(AUTH_REDIRECT_KEY);
}

async function request<T>(input: string, init: RequestInit = {}): Promise<T> {
  const method = init.method ?? "GET";
  const headers = new Headers(init.headers);
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  if (!["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase())) headers.set("x-agentjourney-csrf", csrfToken);
  return parseResponse<T>(await fetch(input, { ...init, method, headers, credentials: "include" }));
}

function queryString(values: Record<string, string | number | boolean | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) if (value !== undefined && value !== "") params.set(key, String(value));
  const encoded = params.toString();
  return encoded ? `?${encoded}` : "";
}

export interface SearchFilters {
  query?: string | undefined;
  sourceAgent?: string | undefined;
  kind?: string | undefined;
  capability?: string | undefined;
  projectId?: string | undefined;
  from?: string | undefined;
  until?: string | undefined;
  journeyId?: string | undefined;
}

export interface InterpretationComparison {
  unchanged: string[];
  added: string[];
  removed: string[];
  reclassified: Array<{ evidenceAnchor: string; before: string; after: string }>;
}

export interface CaptureOutcome {
  results: CaptureCommitResultDocument[];
  pending: PendingEvidenceDocument[];
  skippedExcluded: number;
}

export interface CaptureExclusion {
  sourceAgent: string;
  nativeSessionId: string;
  createdAt: string;
}

export interface RetentionPolicy {
  id: string;
  scope: "archive";
  keepLastRevisions?: number;
  createdAt?: string;
  updatedAt?: string;
}

export const api = {
  rotateLocalAuth: async () => {
    const result = await request<{ csrfToken: string }>("/api/v1/auth/rotate", { method: "POST" });
    csrfToken = result.csrfToken;
    return result;
  },
  listJourneys: () => request<JourneySummaryDocument[]>("/api/v1/journeys"),
  getJourney: (id: string, selection: { revisionId?: string | undefined; interpretationId?: string | undefined; reveal?: boolean | undefined } = {}) =>
    request<JourneyDetailDocument>(`/api/v1/journeys/${encodeURIComponent(id)}${queryString(selection)}`),
  reinterpretJourney: (id: string, revisionId: string) => request<CaptureCommitResultDocument>(`/api/v1/journeys/${encodeURIComponent(id)}/reinterpret`, {
    method: "POST",
    body: JSON.stringify({ revisionId })
  }),
  compareJourney: (id: string, selection: { beforeRevisionId: string; beforeInterpretationId?: string; afterRevisionId: string; afterInterpretationId?: string }) =>
    request<InterpretationComparison>(`/api/v1/journeys/${encodeURIComponent(id)}/compare${queryString(selection)}`),
  search: (filters: SearchFilters | string) => {
    const values = typeof filters === "string" ? { q: filters } : {
      q: filters.query,
      sourceAgent: filters.sourceAgent,
      kind: filters.kind,
      capability: filters.capability,
      projectId: filters.projectId,
      from: filters.from,
      until: filters.until,
      journeyId: filters.journeyId
    };
    return request<SearchHitDocument[]>(`/api/v1/search${queryString(values)}`);
  },
  readEvidence: async (journeyId: string, revisionId: string, relativePath: string, reveal = false) => {
    const response = await fetch(
      `/api/v1/journeys/${encodeURIComponent(journeyId)}/evidence${queryString({ revisionId, path: relativePath, reveal })}`,
      { credentials: "include" }
    );
    if (!response.ok) throw new Error(`Evidence read failed (${response.status})`);
    return response.text();
  },
  searchEvidence: (journeyId: string, revisionId: string, query: string, reveal = false) =>
    request<EvidenceSearchHitDocument[]>(
      `/api/v1/journeys/${encodeURIComponent(journeyId)}/evidence/search${queryString({ revisionId, q: query, reveal })}`
    ),
  updateOverlay: (journeyId: string, update: { displayTitle?: string | null; projectId?: string | null; rendererId?: string | null; tags?: string[] }) =>
    request<ReviewOverlayDocument>(`/api/v1/journeys/${encodeURIComponent(journeyId)}/overlay`, {
      method: "PUT",
      body: JSON.stringify(update)
    }),
  updateAnnotation: (journeyId: string, evidenceAnchor: string, bookmarked: boolean, note?: string | null) =>
    request<ReviewOverlayDocument>(`/api/v1/journeys/${encodeURIComponent(journeyId)}/annotations`, {
      method: "PUT",
      body: JSON.stringify({ evidenceAnchor, bookmarked, note })
    }),
  deleteJourney: (journeyId: string, exclude = true) =>
    request<void>(`/api/v1/journeys/${encodeURIComponent(journeyId)}${queryString({ exclude })}`, { method: "DELETE" }),
  listSources: () => request<SourceStatusDocument[]>("/api/v1/sources"),
  discover: (sourceAgent: string) =>
    request<DiscoveredJourneyDocument[]>(`/api/v1/sources/${encodeURIComponent(sourceAgent)}/discover`),
  revokeSource: (sourceAgent: string) => request<void>(`/api/v1/sources/${encodeURIComponent(sourceAgent)}/approval`, { method: "DELETE" }),
  approveSource: (sourceAgent: string, root: string, scanPolicy: "manual" | "automatic" = "manual") =>
    request<{ sourceAgent: string; root: string; scanPolicy: string }>(`/api/v1/sources/${encodeURIComponent(sourceAgent)}/approve`, {
      method: "POST",
      body: JSON.stringify({ root, scanPolicy })
    }),
  capture: (sourceAgent: string, nativeSessionIds?: string[]) =>
    request<CaptureOutcome>("/api/v1/captures", { method: "POST", body: JSON.stringify({ sourceAgent, nativeSessionIds }) }),
  runAutomaticScan: () => request<{ status: string }>("/api/v1/automatic-scan/run", { method: "POST" }),
  listProjects: () => request<ProjectDocument[]>("/api/v1/projects"),
  createProject: (name: string) => request<ProjectDocument>("/api/v1/projects", { method: "POST", body: JSON.stringify({ name }) }),
  renameProject: (id: string, name: string) => request<ProjectDocument>(`/api/v1/projects/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ name }) }),
  mergeProjects: (sourceId: string, targetProjectId: string) => request<ProjectDocument>(`/api/v1/projects/${encodeURIComponent(sourceId)}/merge`, { method: "POST", body: JSON.stringify({ targetProjectId }) }),
  deleteProject: (id: string) => request<void>(`/api/v1/projects/${encodeURIComponent(id)}`, { method: "DELETE" }),
  listPendingEvidence: () => request<PendingEvidenceDocument[]>("/api/v1/pending-evidence"),
  retryPendingEvidence: (id: string) => request<CaptureCommitResultDocument>(`/api/v1/pending-evidence/${encodeURIComponent(id)}/retry`, { method: "POST" }),
  deletePendingEvidence: (id: string) => request<void>(`/api/v1/pending-evidence/${encodeURIComponent(id)}`, { method: "DELETE" }),
  listCaptureExclusions: () => request<CaptureExclusion[]>("/api/v1/capture-exclusions"),
  removeCaptureExclusion: (sourceAgent: string, nativeSessionId: string) =>
    request<void>(`/api/v1/capture-exclusions/${encodeURIComponent(sourceAgent)}/${encodeURIComponent(nativeSessionId)}`, { method: "DELETE" }),
  getRetention: () => request<RetentionPolicy>("/api/v1/retention"),
  setRetention: (keepLastRevisions?: number) => request<RetentionPolicy>("/api/v1/retention", { method: "PUT", body: JSON.stringify({ keepLastRevisions }) }),
  applyRetention: () => request<{ deletedRevisions: number }>("/api/v1/retention/apply", { method: "POST" }),
  verifyArchive: () => request<ArchiveVerificationDocument>("/api/v1/archive/verify"),
  repairArchive: () => request<ArchiveVerificationDocument>("/api/v1/archive/repair", { method: "POST" }),
  listRendererPlugins: () => request<RendererPlugin[]>("/api/v1/plugins/renderers"),
  renderPlugin: (rendererId: string, stage: unknown) => request<RendererTreeDocument>(`/api/v1/plugins/renderers/${encodeURIComponent(rendererId)}/render`, {
    method: "POST",
    body: JSON.stringify(stage)
  }),
  listPluginDiagnostics: () => request<Array<{ filePath: string; message: string }>>("/api/v1/plugins/diagnostics"),
  listPlugins: () => request<Array<{ manifest: { id: string; version: string; displayName: string; type: string }; integrity: string; installedAt: string; development: boolean }>>("/api/v1/plugins"),
  installPlugin: (document: unknown) => request<{ manifest: { id: string; displayName: string; type: string }; integrity: string; installedAt: string }>("/api/v1/plugins/install", {
    method: "POST",
    body: JSON.stringify(document)
  }),
  exportJourneyPackage: (journeyId: string) => download(`/api/v1/journeys/${encodeURIComponent(journeyId)}/export/package`),
  exportPresentation: (journeyId: string, rendererId: string, selection: { revisionId?: string; interpretationId?: string; reveal?: boolean }) =>
    download(`/api/v1/journeys/${encodeURIComponent(journeyId)}/export/html${queryString({ rendererId, ...selection })}`),
  exportReplayVideo: (journeyId: string, options: ReplayVideoExportOptionsDocument) =>
    download(`/api/v1/journeys/${encodeURIComponent(journeyId)}/export/mp4`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(options)
    }),
  importSourceBundle: (sourceAgent: string, bytes: ArrayBuffer) => request<CaptureOutcome>(`/api/v1/imports/source-bundle/${encodeURIComponent(sourceAgent)}`, {
    method: "POST",
    headers: { "content-type": "application/vnd.agentjourney.source-bundle+zip" },
    body: bytes
  }),
  importJourneyPackage: (bytes: ArrayBuffer) => request<{ journeyIds: string[]; revisions: number; interpretations: number }>("/api/v1/imports/journey-package", {
    method: "POST",
    headers: { "content-type": "application/octet-stream" },
    body: bytes
  })
};

async function download(url: string, init: RequestInit = {}): Promise<{ blob: Blob; fileName: string }> {
  const method = init.method ?? "GET";
  const headers = new Headers(init.headers);
  if (!headers.has("content-type") && init.body) headers.set("content-type", "application/json");
  if (!["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase())) headers.set("x-agentjourney-csrf", csrfToken);
  const response = await fetch(url, { ...init, method, headers, credentials: "include" });
  if (!response.ok) {
    const body = await response.clone().json().catch(() => undefined) as { message?: string } | undefined;
    throw new Error(body?.message ?? `Export failed (${response.status})`);
  }
  const disposition = response.headers.get("content-disposition") ?? "";
  const fileName = /filename="([^"]+)"/u.exec(disposition)?.[1] ?? "agentjourney-export";
  return { blob: await response.blob(), fileName };
}

export function saveDownload(result: { blob: Blob; fileName: string }): void {
  const url = URL.createObjectURL(result.blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = result.fileName;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}
