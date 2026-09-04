import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startAgentJourney } from "../src/runtime.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("AgentJourney runtime", () => {
  it("starts one loopback platform and closes it without deleting persistent data", async () => {
    const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "agentjourney-runtime-"));
    temporaryRoots.push(dataDirectory);
    const first = await startAgentJourney({
      dataDirectory,
      port: 0,
      version: "0.1.0-test",
      logger: false
    });
    expect(new URL(first.url).hostname).toBe("127.0.0.1");
    const health = await fetch(`${first.url}/api/v1/health`);
    expect(await health.json()).toEqual({ product: "agentjourney", status: "ok", version: "0.1.0-test" });
    await first.close();

    const second = await startAgentJourney({ dataDirectory, port: 0, logger: false });
    expect(await fetch(`${second.url}/api/v1/health`).then((response) => response.status)).toBe(200);
    await second.close();
  });
});
