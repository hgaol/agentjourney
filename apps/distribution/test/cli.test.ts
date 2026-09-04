import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseCliArguments } from "../src/cli.js";

describe("AgentJourney CLI", () => {
  it("parses one local foreground platform invocation", () => {
    expect(parseCliArguments([
      "start",
      "--port", "4318",
      "--data-dir", "./archive",
      "--no-open"
    ], {})).toEqual({
      command: "start",
      dataDirectory: path.resolve("archive"),
      port: 4318,
      openBrowser: false
    });
  });

  it("supports help and version without accepting unsafe ports", () => {
    expect(parseCliArguments(["--help"], {}).command).toBe("help");
    expect(parseCliArguments(["--version"], {}).command).toBe("version");
    expect(() => parseCliArguments(["--port", "0"], {})).toThrow(/Invalid port/u);
    expect(() => parseCliArguments(["--host", "0.0.0.0"], {})).toThrow(/Unknown argument/u);
  });
});
