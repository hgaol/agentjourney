#!/usr/bin/env node

import { realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import open from "open";
import packageDocument from "../package.json" with { type: "json" };

export interface CliOptions {
  command: "start" | "help" | "version";
  dataDirectory: string;
  port: number;
  openBrowser: boolean;
}

function expandHome(value: string): string {
  if (value === "~") return os.homedir();
  if (value.startsWith(`~${path.sep}`) || value.startsWith("~/") || value.startsWith("~\\")) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Invalid port: ${value}. Expected an integer from 1 to 65535.`);
  }
  return port;
}

export function parseCliArguments(
  args: readonly string[],
  environment: NodeJS.ProcessEnv = process.env
): CliOptions {
  let command: CliOptions["command"] = "start";
  let dataDirectory = environment.AGENTJOURNEY_DATA_DIR ?? path.join(os.homedir(), ".agentjourney");
  let port = parsePort(environment.AGENTJOURNEY_PORT ?? "4317");
  let openBrowser = true;
  let commandSeen = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === "start") {
      if (commandSeen) throw new Error("Only one command may be supplied.");
      commandSeen = true;
      continue;
    }
    if (argument === "--help" || argument === "-h") {
      command = "help";
      continue;
    }
    if (argument === "--version" || argument === "-v") {
      command = "version";
      continue;
    }
    if (argument === "--no-open") {
      openBrowser = false;
      continue;
    }
    if (argument === "--port" || argument.startsWith("--port=")) {
      const value = argument.includes("=") ? argument.slice(argument.indexOf("=") + 1) : args[++index];
      if (!value) throw new Error("--port requires a value.");
      port = parsePort(value);
      continue;
    }
    if (argument === "--data-dir" || argument.startsWith("--data-dir=")) {
      const value = argument.includes("=") ? argument.slice(argument.indexOf("=") + 1) : args[++index];
      if (!value) throw new Error("--data-dir requires a path.");
      dataDirectory = value;
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }

  return {
    command,
    dataDirectory: path.resolve(expandHome(dataDirectory)),
    port,
    openBrowser
  };
}

function usage(): string {
  return `AgentJourney ${packageDocument.version}

Usage:
  agentjourney [start] [options]

Options:
  --port <number>    Loopback port (default: 4317)
  --data-dir <path>  Archive/config directory (default: ~/.agentjourney)
  --no-open          Do not open the browser
  -v, --version      Print version and exit
  -h, --help         Print this help and exit`;
}

async function compatibleRunningUrl(port: number): Promise<string | undefined> {
  const url = `http://127.0.0.1:${port}`;
  try {
    const response = await fetch(`${url}/api/v1/health`, { signal: AbortSignal.timeout(500) });
    if (!response.ok) return undefined;
    const value = await response.json() as { product?: unknown; status?: unknown; version?: unknown };
    return value.product === "agentjourney" && value.status === "ok" && typeof value.version === "string" ? url : undefined;
  } catch {
    return undefined;
  }
}

async function openLocalUrl(url: string): Promise<void> {
  try {
    await open(url, { wait: false });
  } catch (error) {
    console.warn(`Could not open a browser: ${error instanceof Error ? error.message : "unknown error"}`);
  }
}

export async function runCli(args: readonly string[] = process.argv.slice(2)): Promise<void> {
  const options = parseCliArguments(args);
  if (options.command === "help") {
    console.log(usage());
    return;
  }
  if (options.command === "version") {
    console.log(packageDocument.version);
    return;
  }

  const existingUrl = await compatibleRunningUrl(options.port);
  if (existingUrl) {
    console.log(`AgentJourney is already running at ${existingUrl}/`);
    if (options.openBrowser) await openLocalUrl(existingUrl);
    return;
  }

  const webDirectory = fileURLToPath(new URL("./web/", import.meta.url));
  const { startAgentJourney } = await import("../../host/src/runtime.js");
  const running = await startAgentJourney({
    dataDirectory: options.dataDirectory,
    port: options.port,
    webDirectory,
    version: packageDocument.version
  });
  console.log(`AgentJourney ${packageDocument.version}`);
  console.log(`Local platform: ${running.url}/`);
  console.log(`Archive: ${options.dataDirectory}`);
  console.log("Press Ctrl+C to stop. The archive will be retained.");
  if (options.openBrowser) await openLocalUrl(running.url);

  let closing = false;
  const shutdown = (): void => {
    if (closing) return;
    closing = true;
    void running.close().then(() => {
      console.log("AgentJourney stopped.");
      process.exit(0);
    }).catch((error) => {
      console.error(`AgentJourney shutdown failed: ${error instanceof Error ? error.message : "unknown error"}`);
      process.exit(1);
    });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

const invokedPath = process.argv[1] ? pathToFileURL(realpathSync(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  runCli().catch((error) => {
    console.error(`AgentJourney failed to start: ${error instanceof Error ? error.message : "unknown error"}`);
    process.exitCode = 1;
  });
}
