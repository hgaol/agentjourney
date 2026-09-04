import os from "node:os";
import path from "node:path";
import { startAgentJourney } from "./runtime.js";

const dataDirectory = process.env.AGENTJOURNEY_DATA_DIR
  ? path.resolve(process.env.AGENTJOURNEY_DATA_DIR)
  : path.join(os.homedir(), ".agentjourney");
const port = Number(process.env.AGENTJOURNEY_PORT ?? "4317");
const pluginDevelopmentDirectories = (process.env.AGENTJOURNEY_PLUGIN_DEV_DIRS ?? "")
  .split(path.delimiter)
  .map((value) => value.trim())
  .filter(Boolean);
const running = await startAgentJourney({
  dataDirectory,
  port,
  pluginDevelopmentDirectories,
  ...(process.env.AGENTJOURNEY_WEB_DIR ? { webDirectory: process.env.AGENTJOURNEY_WEB_DIR } : {})
});

const closeAndExit = (): void => {
  void running.close()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(`AgentJourney shutdown failed: ${error instanceof Error ? error.message : "unknown error"}`);
      process.exit(1);
    });
};
process.once("SIGINT", closeAndExit);
process.once("SIGTERM", closeAndExit);

console.log(`\nAgentJourney: ${running.url}/\n`);
