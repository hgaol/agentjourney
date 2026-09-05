import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import type { StageDocument } from "@agentjourney/contracts";
import { rendererForSourceAgent } from "@agentjourney/builtin-renderers";
import {
  LocalReplayVideoExporter,
  planReplayVideo,
  replayVideoBrowserNames,
  validateReplayVideoOptions
} from "../src/replay-video-exporter.js";

function stage(timed = true): StageDocument {
  return {
    schemaVersion: "1.0.0",
    journeyId: "journey-video-fixture",
    revisionId: "revision",
    interpretationId: "interpretation",
    sourceAgent: "pi",
    title: "Video fixture",
    workspace: "/workspace/video",
    models: ["test-model"],
    activities: [
      {
        id: "prompt",
        kind: "human-input",
        evidenceAnchor: "session#L1",
        threadId: "main",
        sourceOrder: 1,
        ...(timed ? { timestamp: "2026-01-01T00:00:00.000Z" } : {}),
        text: "Check the video export."
      },
      {
        id: "answer",
        kind: "agent-output",
        evidenceAnchor: "session#L2",
        threadId: "main",
        sourceOrder: 2,
        ...(timed ? { timestamp: "2026-01-01T00:00:01.000Z" } : {}),
        text: "Export complete."
      }
    ],
    threads: [{ id: "main" }],
    turns: [{ id: "turn", activityIds: ["prompt", "answer"], boundaryProvenance: "inferred" }],
    annotations: [],
    fidelity: {
      contentKinds: ["human-input", "agent-output"],
      timedKinds: timed ? ["human-input", "agent-output"] : [],
      deliveryTraces: false,
      agentThreads: false,
      causalLinks: false,
      terminalStream: false,
      knownGaps: []
    },
    sensitiveFindingCount: 0,
    coverageSummary: { sourceRecords: 2, canonicalActivities: 2, unclassified: 0, malformed: 0 },
    presentation: { redacted: true, view: "review" }
  };
}

const ffmpegExecutable = process.env.AGENTJOURNEY_FFMPEG_EXECUTABLE ?? "ffmpeg";
const systemFfmpegAvailable = spawnSync(ffmpegExecutable, ["-version"], { stdio: "ignore", windowsHide: true }).status === 0;

const options = validateReplayVideoOptions({
  rendererId: "builtin.pi",
  quality: "720p",
  speed: 1,
  fps: 30,
  streamMode: "events",
  promptTyping: false,
  reveal: false
});

describe("Replay video export", () => {
  it("validates bounded quality, speed, frame-rate, and streaming options", () => {
    expect(options).toMatchObject({ browser: "auto", quality: "720p", speed: 1, fps: 30, streamMode: "events", promptTyping: false, typingSpeed: 1 });
    const { promptTyping: _promptTyping, ...withoutPromptTyping } = options;
    expect(validateReplayVideoOptions(withoutPromptTyping).promptTyping).toBe(true);
    expect(() => validateReplayVideoOptions({ ...options, speed: 3 })).toThrow(/speed/u);
    expect(() => validateReplayVideoOptions({ ...options, quality: "4k" })).toThrow(/quality/u);
    expect(() => validateReplayVideoOptions({ ...options, promptTyping: "yes" })).toThrow(/Prompt typing/u);
    expect(() => validateReplayVideoOptions({ ...options, typingSpeed: 3 })).toThrow(/typing speed/u);
  });

  it("falls back through Chrome and Edge, with optional Safari-compatible WebKit", () => {
    const automatic = replayVideoBrowserNames("auto");
    expect(automatic).toEqual(expect.arrayContaining([
      "Playwright Chromium",
      "Google Chrome",
      "Microsoft Edge",
      "Playwright WebKit"
    ]));
    expect(automatic.indexOf("Microsoft Edge")).toBeGreaterThan(automatic.indexOf("Google Chrome"));
    expect(replayVideoBrowserNames("edge")).toContain("Microsoft Edge");
    expect(replayVideoBrowserNames("webkit")).toEqual(["Playwright WebKit"]);
  });

  it("plans faster playback without changing Replay frames", () => {
    const normal = planReplayVideo(stage(), { speed: 1, streamMode: "events" });
    const fast = planReplayVideo(stage(), { speed: 4, streamMode: "events" });
    expect(fast.frames.map(({ activityId }) => activityId)).toEqual(normal.frames.map(({ activityId }) => activityId));
    expect(fast.durationMs).toBeLessThan(normal.durationMs);
  });

  it("includes simulated prompt drafts only when explicitly selected", () => {
    const instant = planReplayVideo(stage(), { speed: 1, streamMode: "events", promptTyping: false });
    const typed = planReplayVideo(stage(), { speed: 1, streamMode: "events", promptTyping: true, typingSpeed: 1 });
    const slow = planReplayVideo(stage(), { speed: 1, streamMode: "events", promptTyping: true, typingSpeed: 0.5 });
    const fast = planReplayVideo(stage(), { speed: 1, streamMode: "events", promptTyping: true, typingSpeed: 4 });
    expect(instant.frames.some(({ simulatedInputTextLength }) => simulatedInputTextLength !== undefined)).toBe(false);
    expect(typed.frames.some(({ simulatedInputTextLength }) => simulatedInputTextLength !== undefined)).toBe(true);
    expect(typed.frames.some(({ inputSubmitted }) => inputSubmitted)).toBe(true);
    expect(slow.durationMs).toBeGreaterThan(fast.durationMs);
  });

  it("keeps MP4 planning bounded when a prompt contains a large pasted log", () => {
    const longPromptStage = stage();
    longPromptStage.activities[0] = {
      ...longPromptStage.activities[0]!,
      text: `fix CI issue.\n\n${"2026-08-23 CI output\n".repeat(4_000)}`
    };
    const plan = planReplayVideo(longPromptStage, {
      speed: 1,
      streamMode: "events",
      promptTyping: true,
      typingSpeed: 1
    });
    expect(plan.frames.length).toBeLessThan(100);
    expect(plan.hasSimulatedInputPaste).toBe(true);
    expect(plan.durationMs).toBeLessThan(10_000);
  });

  it("requires an explicit simulated stream for fully untimed histories", () => {
    expect(() => planReplayVideo(stage(false), { speed: 1, streamMode: "events" })).toThrow(/Simulated/u);
    expect(planReplayVideo(stage(false), { speed: 1, streamMode: "simulated" }).frames.length).toBeGreaterThan(1);
  });

  it.skipIf(!systemFfmpegAvailable)("encodes a playable MP4 and reports rendering/encoding progress", async () => {
    const progress: Array<{ phase: string; percent: number }> = [];
    const result = await new LocalReplayVideoExporter().exportReplay({
      stage: stage(),
      renderer: rendererForSourceAgent("pi"),
      options,
      onProgress(update) {
        progress.push(update);
      }
    });
    expect(result.frameCount).toBe(2);
    expect(result.bytes.byteLength).toBeGreaterThan(1_000);
    expect(Buffer.from(result.bytes).subarray(4, 8).toString("ascii")).toBe("ftyp");
    expect(progress[0]).toMatchObject({ phase: "preparing", percent: 1 });
    expect(progress.some(({ phase }) => phase === "rendering")).toBe(true);
    expect(progress.some(({ phase, percent }) => phase === "encoding" && percent > 82)).toBe(true);
    expect(progress.at(-1)).toMatchObject({ phase: "completed", percent: 100 });
  }, 60_000);

  it.skipIf(systemFfmpegAvailable)("reports the system FFmpeg requirement before rendering frames", async () => {
    await expect(new LocalReplayVideoExporter().exportReplay({
      stage: stage(),
      renderer: rendererForSourceAgent("pi"),
      options
    })).rejects.toThrow(/Install ffmpeg on PATH|AGENTJOURNEY_FFMPEG_EXECUTABLE/u);
  });
});
