import path from "node:path";
import type { FastifyInstance } from "fastify";
import { SqliteJourneyArchive } from "@agentjourney/archive";
import { builtInAdapters } from "@agentjourney/builtin-adapters";
import { PluginRegistry, SandboxedSourceAdapter } from "@agentjourney/plugin-runtime";
import { LocalAuth } from "./auth.js";
import { AutomaticScanner } from "./automatic-scanner.js";
import { CaptureCoordinator } from "./capture-coordinator.js";
import { EventHub } from "./event-hub.js";
import { LocalReplayVideoExporter } from "./replay-video-exporter.js";
import { createServer } from "./server.js";
import { SettingsStore } from "./settings.js";

export interface StartAgentJourneyOptions {
  dataDirectory: string;
  port?: number;
  webDirectory?: string;
  version?: string;
  logger?: boolean;
  pluginDevelopmentDirectories?: string[];
}

export interface RunningAgentJourney {
  url: string;
  close(): Promise<void>;
}

export async function startAgentJourney(options: StartAgentJourneyOptions): Promise<RunningAgentJourney> {
  const dataDirectory = path.resolve(options.dataDirectory);
  const archive = await SqliteJourneyArchive.open(path.join(dataDirectory, "archive"));
  let app: FastifyInstance | undefined;
  let automaticScanner: AutomaticScanner | undefined;
  let heartbeat: NodeJS.Timeout | undefined;
  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    if (heartbeat) clearInterval(heartbeat);
    automaticScanner?.stop();
    await app?.close();
    archive.close();
  };

  try {
    const settings = new SettingsStore(path.join(dataDirectory, "settings.json"));
    await settings.load();
    const auth = await LocalAuth.load(dataDirectory);
    const events = new EventHub();
    const pluginRegistry = new PluginRegistry(dataDirectory, options.pluginDevelopmentDirectories ?? []);
    await pluginRegistry.load();
    const builtInSourceAgents = new Set(builtInAdapters.map(({ manifest }) => manifest.sourceAgent));
    const thirdPartyAdapters = pluginRegistry.sourceAdapterPackages()
      .map((plugin) => new SandboxedSourceAdapter(plugin))
      .filter(({ manifest }) => !builtInSourceAgents.has(manifest.sourceAgent));
    const coordinator = new CaptureCoordinator([...builtInAdapters, ...thirdPartyAdapters], archive, settings, events);
    automaticScanner = new AutomaticScanner(coordinator, settings);
    automaticScanner.start();
    app = await createServer({
      archive,
      settings,
      auth,
      events,
      coordinator,
      automaticScanner,
      pluginRegistry,
      videoExporter: new LocalReplayVideoExporter(),
      ...(options.webDirectory ? { webDirectory: path.resolve(options.webDirectory) } : {}),
      ...(options.version ? { version: options.version } : {}),
      ...(options.logger !== undefined ? { logger: options.logger } : {})
    });
    heartbeat = setInterval(() => events.heartbeat(), 20_000);
    heartbeat.unref();
    const url = await app.listen({ host: "127.0.0.1", port: options.port ?? 4317 });
    return { url, close };
  } catch (error) {
    await close();
    throw error;
  }
}
