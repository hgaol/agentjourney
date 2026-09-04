import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  canAutoPlayReplay,
  deriveReplayFrames,
  replayFrameDelay,
  type ReplayFrame
} from "@agentjourney/activity-graph";
import type {
  ReplayVideoExportOptionsDocument,
  StageDocument
} from "@agentjourney/contracts";
import type { RendererPlugin } from "@agentjourney/plugin-sdk";
import { buildStageSource, projectStageDocument } from "@agentjourney/portability";
import { chromium, webkit, type Browser, type Page } from "playwright-core";

const MAX_UNIQUE_FRAMES = 5_000;
const MAX_DURATION_MS = 2 * 60 * 60 * 1_000;

const QUALITY = {
  "720p": { width: 1280, height: 720, crf: 23, preset: "veryfast" },
  "1080p": { width: 1920, height: 1080, crf: 20, preset: "medium" },
  "1440p": { width: 2560, height: 1440, crf: 18, preset: "slow" }
} as const;

export type ReplayVideoProgressPhase =
  | "preparing"
  | "rendering"
  | "encoding"
  | "finalizing"
  | "completed";

export interface ReplayVideoProgress {
  phase: ReplayVideoProgressPhase;
  percent: number;
  message: string;
  completed?: number;
  total?: number;
}

export interface ReplayVideoExportInput {
  stage: StageDocument;
  renderer: RendererPlugin;
  options: ReplayVideoExportOptionsDocument;
  onProgress?: (progress: ReplayVideoProgress) => void;
}

export interface ReplayVideoExportResult {
  bytes: Uint8Array;
  fileName: string;
  frameCount: number;
  durationMs: number;
}

export interface ReplayVideoExporter {
  exportReplay(input: ReplayVideoExportInput): Promise<ReplayVideoExportResult>;
}

export interface ReplayVideoFramePlan {
  frames: ReplayFrame[];
  durationsMs: number[];
  durationMs: number;
  hasSimulatedInputPaste: boolean;
}

function publishProgress(input: ReplayVideoExportInput, progress: ReplayVideoProgress): void {
  try {
    input.onProgress?.({
      ...progress,
      percent: Math.max(0, Math.min(100, Math.round(progress.percent)))
    });
  } catch {
    // Progress reporting must never abort a local export.
  }
}

export function validateReplayVideoOptions(value: unknown): ReplayVideoExportOptionsDocument {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Video export options are required");
  const input = value as Record<string, unknown>;
  const browser = input.browser ?? "auto";
  const quality = input.quality;
  const speed = input.speed;
  const fps = input.fps;
  const streamMode = input.streamMode;
  if (typeof input.rendererId !== "string" || !input.rendererId) throw new Error("Renderer is required");
  if (!(["auto", "chromium", "chrome", "edge", "webkit"] as const).includes(browser as never)) throw new Error("Unsupported rendering engine");
  if (!(["720p", "1080p", "1440p"] as const).includes(quality as never)) throw new Error("Unsupported video quality");
  if (!([0.5, 1, 2, 4, 8, 16] as const).includes(speed as never)) throw new Error("Unsupported video speed");
  if (fps !== 30 && fps !== 60) throw new Error("Unsupported frame rate");
  if (!(["events", "recorded", "simulated"] as const).includes(streamMode as never)) throw new Error("Unsupported streaming mode");
  if (input.promptTyping !== undefined && typeof input.promptTyping !== "boolean") throw new Error("Prompt typing selection must be boolean");
  const typingSpeed = input.typingSpeed ?? 1;
  if (!([0.5, 1, 2, 4] as const).includes(typingSpeed as never)) throw new Error("Unsupported typing speed");
  if (typeof input.reveal !== "boolean") throw new Error("Video redaction selection is required");
  return {
    rendererId: input.rendererId,
    ...(typeof input.exportId === "string" && input.exportId ? { exportId: input.exportId } : {}),
    browser: browser as NonNullable<ReplayVideoExportOptionsDocument["browser"]>,
    quality: quality as ReplayVideoExportOptionsDocument["quality"],
    speed: speed as ReplayVideoExportOptionsDocument["speed"],
    fps,
    streamMode: streamMode as ReplayVideoExportOptionsDocument["streamMode"],
    promptTyping: input.promptTyping !== false,
    typingSpeed: typingSpeed as NonNullable<ReplayVideoExportOptionsDocument["typingSpeed"]>,
    reveal: input.reveal,
    ...(typeof input.revisionId === "string" ? { revisionId: input.revisionId } : {}),
    ...(typeof input.interpretationId === "string" ? { interpretationId: input.interpretationId } : {})
  };
}

export function planReplayVideo(
  stage: StageDocument,
  options: Pick<ReplayVideoExportOptionsDocument, "speed" | "streamMode" | "promptTyping" | "typingSpeed">
): ReplayVideoFramePlan {
  const frames = deriveReplayFrames(stage.activities, {
    streamMode: options.streamMode,
    simulateHumanInput: options.promptTyping === true
  });
  if (frames.length === 0) throw new Error("This Journey has no Activities to export");
  if (frames.length > MAX_UNIQUE_FRAMES) {
    throw new Error(`Replay contains ${frames.length} frames; choose Event steps, disable simulated prompt typing, or use a shorter Journey (maximum ${MAX_UNIQUE_FRAMES})`);
  }
  if (frames.length > 1 && !canAutoPlayReplay(frames, options.streamMode)) {
    throw new Error("This Journey has no evidenced Replay timing; choose Simulated TUI stream for MP4 export");
  }
  const durationsMs = frames.map((frame, index) => {
    const next = frames[index + 1];
    if (!next) return Math.max(250, 1_200 / options.speed);
    return replayFrameDelay(frame, next, {
      timelineSpeed: options.speed,
      streamingSpeed: options.speed,
      typingSpeed: options.typingSpeed ?? 1
    });
  });
  const durationMs = durationsMs.reduce((total, duration) => total + duration, 0);
  if (durationMs > MAX_DURATION_MS) throw new Error("Replay video would exceed the two-hour export limit; choose a faster speed");
  return {
    frames,
    durationsMs,
    durationMs,
    hasSimulatedInputPaste: frames.some(({ simulatedInputPaste }) => simulatedInputPaste)
  };
}

function stageAtFrame(
  stage: StageDocument,
  frame: ReplayFrame,
  streamMode: ReplayVideoExportOptionsDocument["streamMode"]
): StageDocument {
  const inputActivity = frame.simulatedInputTextLength !== undefined
    ? stage.activities.find(({ id }) => id === frame.activityId)
    : undefined;
  const simulatedInputDraft = inputActivity?.text !== undefined && frame.simulatedInputTextLength !== undefined
    ? {
        activityId: inputActivity.id,
        text: [...inputActivity.text].slice(0, frame.simulatedInputTextLength).join("")
      }
    : undefined;
  return projectStageDocument({
    ...stage,
    presentation: {
      ...stage.presentation,
      view: "replay",
      streamMode,
      playheadActivityId: frame.activityId,
      ...(frame.deliveryChunkIndex !== undefined ? { playheadDeliveryChunk: frame.deliveryChunkIndex } : {}),
      ...(frame.simulatedTextLength !== undefined ? { playheadSimulatedTextLength: frame.simulatedTextLength } : {}),
      ...(simulatedInputDraft ? { simulatedInputDraft } : {})
    }
  });
}

interface LaunchedBrowser {
  browser: Browser;
  label: "CHROMIUM" | "GOOGLE CHROME" | "MICROSOFT EDGE" | "WEBKIT";
}

interface BrowserCandidate {
  name: string;
  label: LaunchedBrowser["label"];
  launch: () => Promise<Browser>;
}

function browserCandidates(preference: NonNullable<ReplayVideoExportOptionsDocument["browser"]>): BrowserCandidate[] {
  const configured = process.env.AGENTJOURNEY_BROWSER_EXECUTABLE;
  const legacyChrome = process.env.AGENTJOURNEY_CHROME_EXECUTABLE;
  const edgeExecutable = process.env.AGENTJOURNEY_EDGE_EXECUTABLE;
  const candidates: Record<Exclude<typeof preference, "auto">, BrowserCandidate[]> = {
    chromium: [
      ...(configured ? [{ name: "configured Chromium", label: "CHROMIUM" as const, launch: () => chromium.launch({ executablePath: configured, headless: true }) }] : []),
      { name: "Playwright Chromium", label: "CHROMIUM", launch: () => chromium.launch({ headless: true }) }
    ],
    chrome: [
      ...(configured || legacyChrome ? [{ name: "configured Google Chrome", label: "GOOGLE CHROME" as const, launch: () => chromium.launch({ executablePath: configured ?? legacyChrome!, headless: true }) }] : []),
      { name: "Google Chrome", label: "GOOGLE CHROME", launch: () => chromium.launch({ channel: "chrome", headless: true }) }
    ],
    edge: [
      ...(configured || edgeExecutable ? [{ name: "configured Microsoft Edge", label: "MICROSOFT EDGE" as const, launch: () => chromium.launch({ executablePath: configured ?? edgeExecutable!, headless: true }) }] : []),
      { name: "Microsoft Edge", label: "MICROSOFT EDGE", launch: () => chromium.launch({ channel: "msedge", headless: true }) },
      { name: "Microsoft Edge Beta", label: "MICROSOFT EDGE", launch: () => chromium.launch({ channel: "msedge-beta", headless: true }) },
      { name: "Microsoft Edge Dev", label: "MICROSOFT EDGE", launch: () => chromium.launch({ channel: "msedge-dev", headless: true }) },
      { name: "Microsoft Edge Canary", label: "MICROSOFT EDGE", launch: () => chromium.launch({ channel: "msedge-canary", headless: true }) }
    ],
    webkit: [
      { name: "Playwright WebKit", label: "WEBKIT", launch: () => webkit.launch({ headless: true }) }
    ]
  };
  return preference === "auto"
    ? [...candidates.chromium, ...candidates.chrome, ...candidates.edge, ...candidates.webkit]
    : candidates[preference];
}

export function replayVideoBrowserNames(
  preference: NonNullable<ReplayVideoExportOptionsDocument["browser"]>
): string[] {
  return browserCandidates(preference).map(({ name }) => name);
}

async function launchBrowser(
  preference: NonNullable<ReplayVideoExportOptionsDocument["browser"]>
): Promise<LaunchedBrowser> {
  const failures: string[] = [];
  for (const candidate of browserCandidates(preference)) {
    try {
      return { browser: await candidate.launch(), label: candidate.label };
    } catch (error) {
      failures.push(`${candidate.name}: ${error instanceof Error ? error.message.split("\n")[0] : "launch failed"}`);
    }
  }
  throw new Error(
    `No local rendering engine is available for MP4 export. Tried ${failures.map((failure) => failure.split(":")[0]).join(", ")}. `
    + "Install Microsoft Edge or Google Chrome, run 'pnpm exec playwright install chromium' (or 'webkit'), "
    + `or set AGENTJOURNEY_BROWSER_EXECUTABLE. Launch errors: ${failures.join(" | ")}`
  );
}

async function connectStage(page: Page): Promise<void> {
  await page.evaluate(() => {
    const channel = new MessageChannel();
    (window as typeof window & { agentJourneyVideoPort?: MessagePort }).agentJourneyVideoPort = channel.port1;
    channel.port1.start();
    window.postMessage({ type: "agentjourney:init" }, "*", [channel.port2]);
  });
}

async function addExportBadge(
  page: Page,
  options: ReplayVideoExportOptionsDocument,
  rendererName: string,
  hasSimulatedInputPaste: boolean
): Promise<void> {
  const mode = options.streamMode === "simulated"
    ? "SIMULATED STREAM"
    : options.streamMode === "recorded"
      ? "RECORDED STREAM"
      : "EVENT REPLAY";
  await page.evaluate(({ label, redaction }) => {
    const badge = document.createElement("div");
    badge.id = "agentjourney-video-badge";
    badge.textContent = `${label} · ${redaction}`;
    document.body.append(badge);
  }, {
    label: `${rendererName.toUpperCase()} · ${options.quality.toUpperCase()} · ${options.fps} FPS · ${mode}${options.promptTyping ? ` · SIMULATED PROMPT TYPING ${options.typingSpeed ?? 1}×${hasSimulatedInputPaste ? " + LARGE-INPUT PASTE" : ""}` : ""} · ${options.speed}×`,
    redaction: options.reveal ? "UNREDACTED" : "REDACTED"
  });
  await page.addStyleTag({ content: "#agentjourney-video-badge{position:fixed;z-index:2147483647;top:10px;right:10px;padding:5px 7px;border:1px solid #ffffff2b;border-radius:3px;background:#090b0dcc;color:#d4d4d4;font:10px ui-monospace,monospace;letter-spacing:.06em}" });
}

async function renderStageFrame(page: Page, stage: StageDocument): Promise<void> {
  await page.evaluate((documentValue: unknown) => {
    (window as typeof window & { agentJourneyVideoPort?: MessagePort }).agentJourneyVideoPort?.postMessage({
      type: "render",
      document: documentValue
    });
  }, stage as unknown);
  await page.waitForSelector(".stage");
  await page.evaluate(async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "auto" });
  });
}

function concatPath(filePath: string): string {
  return filePath.replaceAll("\\", "/").replaceAll("'", "'\\''");
}

let ffmpegExecutablePromise: Promise<string> | undefined;

async function executableWorks(executable: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const child = spawn(executable, ["-version"], { stdio: "ignore", windowsHide: true });
    const timeout = setTimeout(() => { child.kill(); resolve(false); }, 5_000);
    child.once("error", () => { clearTimeout(timeout); resolve(false); });
    child.once("exit", (code) => { clearTimeout(timeout); resolve(code === 0); });
  });
}

async function resolveFfmpegExecutable(): Promise<string> {
  if (!ffmpegExecutablePromise) {
    ffmpegExecutablePromise = (async () => {
      const candidates = [process.env.AGENTJOURNEY_FFMPEG_EXECUTABLE, "ffmpeg"]
        .filter((value): value is string => Boolean(value));
      try {
        const installer = await import("@ffmpeg-installer/ffmpeg");
        if (installer.default.path) candidates.push(installer.default.path);
      } catch {
        // The optional package is not required for archive and review features.
      }
      for (const candidate of [...new Set(candidates)]) {
        if (await executableWorks(candidate)) return candidate;
      }
      throw new Error("MP4 export requires FFmpeg. Install ffmpeg on PATH or set AGENTJOURNEY_FFMPEG_EXECUTABLE.");
    })();
  }
  return ffmpegExecutablePromise;
}

async function runFfmpeg(
  args: string[],
  durationMs: number,
  onProgress: (percent: number) => void
): Promise<void> {
  const executable = await resolveFfmpegExecutable();
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, args, { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    let stderr = "";
    let pending = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-16_000);
      pending += chunk;
      const lines = pending.split(/\r?\n/u);
      pending = lines.pop() ?? "";
      for (const line of lines) {
        const [key, rawValue] = line.split("=", 2);
        if ((key === "out_time_ms" || key === "out_time_us") && rawValue) {
          const encodedMicroseconds = Number(rawValue);
          if (Number.isFinite(encodedMicroseconds) && durationMs > 0) {
            onProgress(Math.min(98, 82 + (encodedMicroseconds / (durationMs * 1_000)) * 16));
          }
        }
        if (key === "progress" && rawValue === "end") onProgress(98);
      }
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`FFmpeg failed (${code ?? "unknown"}): ${stderr.trim().split("\n").at(-1) ?? "unknown error"}`));
    });
  });
}

export class LocalReplayVideoExporter implements ReplayVideoExporter {
  private active = false;

  async exportReplay(input: ReplayVideoExportInput): Promise<ReplayVideoExportResult> {
    if (this.active) throw new Error("Another MP4 export is already running");
    if (input.renderer.javascript) throw new Error("MP4 export currently supports Style Pack renderers only");
    this.active = true;
    let temporaryDirectory: string | undefined;
    let browser: Browser | undefined;
    try {
      publishProgress(input, { phase: "preparing", percent: 1, message: "Planning Replay frames" });
      temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "agentjourney-video-"));
      const plan = planReplayVideo(input.stage, input.options);
      const quality = QUALITY[input.options.quality];
      publishProgress(input, {
        phase: "preparing",
        percent: 4,
        message: `Launching ${input.options.browser ?? "auto"} rendering engine`,
        completed: 0,
        total: plan.frames.length
      });
      const launched = await launchBrowser(input.options.browser ?? "auto");
      browser = launched.browser;
      const context = await browser.newContext({
        viewport: { width: quality.width, height: quality.height },
        deviceScaleFactor: 1
      });
      const page = await context.newPage();
      await page.setContent(buildStageSource(input.renderer), { waitUntil: "load" });
      await connectStage(page);
      await addExportBadge(
        page,
        input.options,
        `${input.renderer.manifest.displayName} · ${launched.label}`,
        plan.hasSimulatedInputPaste
      );
      await page.addStyleTag({ content: "*{animation:none!important;transition:none!important}html{scroll-behavior:auto!important}" });
      const imagePaths: string[] = [];
      publishProgress(input, {
        phase: "rendering",
        percent: 10,
        message: `Rendering frame 0 of ${plan.frames.length}`,
        completed: 0,
        total: plan.frames.length
      });
      for (const [index, frame] of plan.frames.entries()) {
        await renderStageFrame(page, stageAtFrame(input.stage, frame, input.options.streamMode));
        const imagePath = path.join(temporaryDirectory, `frame-${String(index).padStart(5, "0")}.png`);
        await page.screenshot({ path: imagePath, type: "png" });
        imagePaths.push(imagePath);
        const completed = index + 1;
        publishProgress(input, {
          phase: "rendering",
          percent: 10 + (completed / plan.frames.length) * 70,
          message: `Rendering frame ${completed} of ${plan.frames.length}`,
          completed,
          total: plan.frames.length
        });
      }
      const listPath = path.join(temporaryDirectory, "frames.txt");
      const list = imagePaths.flatMap((imagePath, index) => [
        `file '${concatPath(imagePath)}'`,
        `duration ${(plan.durationsMs[index]! / 1_000).toFixed(6)}`
      ]);
      list.push(`file '${concatPath(imagePaths.at(-1)!)}'`);
      await writeFile(listPath, `${list.join("\n")}\n`, "utf8");
      const outputPath = path.join(temporaryDirectory, "replay.mp4");
      publishProgress(input, { phase: "encoding", percent: 82, message: "Encoding H.264 MP4" });
      await runFfmpeg([
        "-hide_banner", "-loglevel", "error", "-y",
        "-progress", "pipe:2", "-nostats",
        "-f", "concat", "-safe", "0", "-i", listPath,
        "-vf", `fps=${input.options.fps},format=yuv420p`,
        "-an", "-c:v", "libx264", "-preset", quality.preset,
        "-crf", String(quality.crf), "-movflags", "+faststart",
        outputPath
      ], plan.durationMs, (percent) => publishProgress(input, {
        phase: "encoding",
        percent,
        message: "Encoding H.264 MP4"
      }));
      publishProgress(input, { phase: "finalizing", percent: 99, message: "Finalizing MP4 download" });
      const bytes = await readFile(outputPath);
      publishProgress(input, { phase: "completed", percent: 100, message: "MP4 export complete" });
      return {
        bytes,
        fileName: `${input.stage.journeyId.slice(0, 12)}-${input.options.quality}-${input.options.speed}x.mp4`,
        frameCount: plan.frames.length,
        durationMs: plan.durationMs
      };
    } finally {
      await browser?.close().catch(() => undefined);
      if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
      this.active = false;
    }
  }
}
