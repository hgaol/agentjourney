import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(await readFile(path.join(workspaceRoot, "release", "pack-manifest.json"), "utf8"));
const tarball = path.join(workspaceRoot, "release", manifest.filename);
const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "agentjourney-package-smoke-"));
const installRoot = path.join(temporaryRoot, "install");
const dataDirectory = path.join(temporaryRoot, "data");
await mkdir(installRoot, { recursive: true });
await writeFile(path.join(installRoot, "package.json"), "{\"name\":\"agentjourney-smoke\",\"version\":\"1.0.0\",\"private\":true}\n");
await writeFile(path.join(installRoot, ".npmrc"), "fund=false\naudit=false\n");

function command(name) {
  return process.platform === "win32" ? `${name}.cmd` : name;
}

function run(executable, args, options = {}) {
  const result = spawnSync(executable, args, { encoding: "utf8", ...options });
  if (result.status !== 0) {
    throw new Error(`${executable} ${args.join(" ")} failed (${result.status ?? "unknown"})\n${result.stdout ?? ""}\n${result.stderr ?? ""}`);
  }
  return result.stdout.trim();
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function waitForHealth(url, child) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Packaged CLI exited before health became ready (${child.exitCode})`);
    try {
      const response = await fetch(`${url}/api/v1/health`);
      if (response.ok) return response.json();
    } catch {
      // Startup is still in progress.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Packaged CLI health endpoint did not become ready");
}

async function stop(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((_, reject) => setTimeout(() => reject(new Error("Packaged CLI did not stop")), 10_000))
  ]);
}

function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}

function withIntegrity(content) {
  return {
    ...content,
    integrity: `sha256-${createHash("sha256").update(canonical(content)).digest("base64url")}`
  };
}

async function authenticatedHeaders(url) {
  const token = (await readFile(path.join(dataDirectory, "local-auth-token"), "utf8")).trim();
  const response = await fetch(`${url}/api/v1/auth/bootstrap`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: url },
    body: JSON.stringify({ token })
  });
  if (!response.ok) throw new Error(`Packaged auth bootstrap failed (${response.status})`);
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
  const { csrfToken } = await response.json();
  if (!cookie || typeof csrfToken !== "string") throw new Error("Packaged auth bootstrap returned incomplete credentials");
  return { origin: url, cookie, "x-agentjourney-csrf": csrfToken };
}

async function verifyPackagedBrowser(url) {
  if (process.env.AGENTJOURNEY_SMOKE_BROWSER !== "1") return;
  const requireFromInstall = createRequire(path.join(installRoot, "package.json"));
  const playwrightPath = requireFromInstall.resolve("playwright-core");
  const playwright = await import(pathToFileURL(playwrightPath).href);
  const chromium = playwright.chromium ?? playwright.default?.chromium;
  if (!chromium) throw new Error("Packaged playwright-core did not expose Chromium");
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.goto(`${url}/`);
    await page.getByRole("heading", { name: "Revisit how the work unfolded." }).waitFor({ timeout: 15_000 });
    const deepContext = await browser.newContext();
    try {
      const deepPage = await deepContext.newPage();
      await deepPage.goto(`${url}/settings`);
      await deepPage.getByRole("heading", { name: "Archive operations" }).waitFor({ timeout: 15_000 });
      if (new URL(deepPage.url()).pathname !== "/settings") throw new Error("Packaged auth did not preserve deep navigation");
    } finally {
      await deepContext.close();
    }
    if (pageErrors.length) throw new Error(`Packaged browser errors: ${pageErrors.join(" | ")}`);
  } finally {
    await browser.close();
  }
}

async function importSmokeJourney(url, headers) {
  const requireFromInstall = createRequire(path.join(installRoot, "package.json"));
  const { strToU8, zipSync } = requireFromInstall("fflate");
  const sessionId = "99999999-9999-4999-8999-999999999999";
  const source = [
    JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: "2026-01-01T00:00:00.000Z", cwd: "/workspace/package-smoke" }),
    JSON.stringify({ type: "message", id: "user-1", parentId: null, timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "Verify the packed Journey." }] } }),
    JSON.stringify({ type: "message", id: "assistant-1", parentId: "user-1", timestamp: "2026-01-01T00:00:02.000Z", message: { role: "assistant", content: [{ type: "text", text: "Packed Journey verified." }] } })
  ].join("\n");
  const bundle = zipSync({ "smoke/session.jsonl": strToU8(`${source}\n`) }, { level: 0 });
  const response = await fetch(`${url}/api/v1/imports/source-bundle/pi`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/vnd.agentjourney.source-bundle+zip" },
    body: Buffer.from(bundle)
  });
  if (response.status !== 201) throw new Error(`Packaged Journey import failed (${response.status}): ${await response.text()}`);
  const result = await response.json();
  const journeyId = result.results?.[0]?.journeyId;
  if (!journeyId) throw new Error("Packaged Journey import returned no Journey");
  return journeyId;
}

async function verifyQuickJs(url, headers) {
  const plugin = withIntegrity({
    formatVersion: 1,
    manifest: {
      type: "renderer",
      id: "smoke.renderer",
      version: "1.0.0",
      displayName: "Smoke Renderer",
      interfaceVersion: "1.0.0",
      kind: "renderer"
    },
    javascript: "globalThis.agentJourneyRenderer={render(stage){return{root:{tag:'main',children:[{tag:'h1',text:stage.title||'Smoke'}]}}}};"
  });
  const install = async (document) => {
    const response = await fetch(`${url}/api/v1/plugins/install`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify(document)
    });
    if (response.status !== 201) throw new Error(`Packaged plugin install failed (${response.status}): ${await response.text()}`);
  };
  await install(plugin);
  const stage = {
    schemaVersion: "1.0.0",
    journeyId: "smoke",
    revisionId: "revision",
    interpretationId: "interpretation",
    sourceAgent: "pi",
    title: "Packed QuickJS",
    activities: [],
    threads: [{ id: "main" }],
    turns: [],
    annotations: [],
    fidelity: { contentKinds: [], timedKinds: [], deliveryTraces: false, agentThreads: false, causalLinks: false, terminalStream: false, knownGaps: [] },
    sensitiveFindingCount: 0,
    coverageSummary: { sourceRecords: 0, canonicalActivities: 0, unclassified: 0, malformed: 0 },
    presentation: { redacted: true, view: "review" }
  };
  const rendered = await fetch(`${url}/api/v1/plugins/renderers/smoke.renderer/render`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify(stage)
  });
  if (!rendered.ok || (await rendered.json()).root?.children?.[0]?.text !== "Packed QuickJS") {
    throw new Error(`Packaged QuickJS renderer failed (${rendered.status})`);
  }
  await install(withIntegrity({
    formatVersion: 1,
    manifest: {
      type: "source-adapter",
      id: "smoke.adapter",
      version: "1.0.0",
      displayName: "Smoke Adapter",
      interfaceVersion: "1.0.0",
      sourceAgent: "smoke-agent",
      defaultRootSegments: { posix: [".smoke-agent"], windows: [".smoke-agent"] },
      discovery: { include: ["**/*.jsonl"] }
    },
    javascript: `globalThis.agentJourneyAdapter={
      discover(input){return input.files.map(file=>({sourceAgent:'smoke-agent',nativeSessionId:file.path,relativePaths:[file.path],locator:{mainPath:file.path}}))},
      interpret(input){const file=input.files[0];return{schemaVersion:'1.0.0',adapter:{id:'smoke.adapter',version:'1.0.0'},journey:{sourceAgent:'smoke-agent',nativeSessionId:input.candidate.nativeSessionId},activities:[{id:'a1',kind:'agent-output',evidenceAnchor:file.path+'#L1',threadId:'main',sourceOrder:1,text:file.text}],threads:[{id:'main'}],coverage:{sourceRecordCount:1,dispositions:[{evidenceAnchor:file.path+'#L1',disposition:'canonical',activityIds:['a1']}],missing:[]},fidelity:{contentKinds:['agent-output'],timedKinds:[],deliveryTraces:false,agentThreads:false,causalLinks:false,terminalStream:false,knownGaps:[]}}}
    };`
  }));
}

let first;
let second;
let third;
try {
  run(command("npm"), ["install", "--ignore-scripts", "--omit=optional", "--prefix", installRoot, tarball]);
  const requireFromInstall = createRequire(path.join(installRoot, "package.json"));
  try {
    requireFromInstall.resolve("@ffmpeg-installer/ffmpeg");
    throw new Error("Package smoke expected optional FFmpeg to be omitted");
  } catch (error) {
    if (error instanceof Error && error.message === "Package smoke expected optional FFmpeg to be omitted") throw error;
  }
  const sbom = run(command("npm"), ["sbom", "--package-lock-only", "--sbom-format", "cyclonedx"], { cwd: installRoot });
  JSON.parse(sbom);
  await writeFile(path.join(workspaceRoot, "release", `agentjourney-${manifest.version}.cdx.json`), `${sbom}\n`);
  const installedPackageRoot = path.join(installRoot, "node_modules", "agentjourney");
  const cli = path.join(installedPackageRoot, "dist", "cli.js");
  const installedPackage = JSON.parse(await readFile(path.join(installedPackageRoot, "package.json"), "utf8"));
  if (installedPackage.private === true) throw new Error("Packed package must not retain private=true");
  const version = run(process.execPath, [cli, "--version"]);
  if (version !== manifest.version) throw new Error(`Version mismatch: ${version} != ${manifest.version}`);
  const npxVersion = run(command("npx"), ["--no-install", "agentjourney", "--version"], { cwd: installRoot });
  if (npxVersion !== manifest.version) throw new Error(`npx version mismatch: ${npxVersion} != ${manifest.version}`);

  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  first = spawn(process.execPath, [cli, "--no-open", "--data-dir", dataDirectory, "--port", String(port)], {
    stdio: ["ignore", "pipe", "pipe"]
  });
  const health = await waitForHealth(url, first);
  if (health.product !== "agentjourney" || health.version !== manifest.version) throw new Error(`Health identity mismatch: ${JSON.stringify(health)}`);
  const duplicate = run(process.execPath, [cli, "--no-open", "--data-dir", dataDirectory, "--port", String(port)]);
  if (!duplicate.includes("already running")) throw new Error("CLI did not recognize the existing local platform");
  const root = await fetch(`${url}/`, { redirect: "manual" });
  if (root.status !== 302 || !root.headers.get("location")?.startsWith("/?token=")) throw new Error("Packaged bootstrap redirect is missing");
  const entry = await fetch(new URL(root.headers.get("location"), url));
  const html = await entry.text();
  const assetPath = /(?:src|href)="(\/assets\/[^"]+)"/u.exec(html)?.[1];
  if (!entry.ok || !assetPath || !(await fetch(`${url}${assetPath}`)).ok) throw new Error("Packaged Web application did not load");
  await verifyPackagedBrowser(url);
  const firstHeaders = await authenticatedHeaders(url);
  await verifyQuickJs(url, firstHeaders);
  const journeyId = await importSmokeJourney(url, firstHeaders);
  const tokenBeforeRestart = await readFile(path.join(dataDirectory, "local-auth-token"), "utf8");
  await stop(first);
  first = undefined;

  second = spawn(process.execPath, [cli, "--no-open", "--data-dir", dataDirectory, "--port", String(port)], {
    stdio: ["ignore", "pipe", "pipe"]
  });
  await waitForHealth(url, second);
  const tokenAfterRestart = await readFile(path.join(dataDirectory, "local-auth-token"), "utf8");
  if (tokenAfterRestart !== tokenBeforeRestart) throw new Error("Local installation identity changed across packaged restart");
  const restartedHeaders = await authenticatedHeaders(url);
  const persistedPlugins = await fetch(`${url}/api/v1/plugins`, { headers: restartedHeaders }).then((response) => response.json());
  if (!persistedPlugins.some((plugin) => plugin.manifest?.id === "smoke.renderer")) throw new Error("Packaged renderer plugin did not persist across restart");
  if (!persistedPlugins.some((plugin) => plugin.manifest?.id === "smoke.adapter")) throw new Error("Packaged Source Adapter did not persist across restart");
  const adapterRoot = path.join(temporaryRoot, "adapter-source");
  await mkdir(adapterRoot, { recursive: true });
  await writeFile(path.join(adapterRoot, "example.jsonl"), "hello from the packed Source Adapter\n");
  const approval = await fetch(`${url}/api/v1/sources/smoke-agent/approve`, {
    method: "POST",
    headers: { ...restartedHeaders, "content-type": "application/json" },
    body: JSON.stringify({ root: adapterRoot, scanPolicy: "manual" })
  });
  if (approval.status !== 201) throw new Error(`Packaged Source Adapter approval failed (${approval.status})`);
  const discovery = await fetch(`${url}/api/v1/sources/smoke-agent/discover`, { headers: restartedHeaders });
  const candidates = await discovery.json();
  if (!discovery.ok || candidates.length !== 1) throw new Error(`Packaged Source Adapter discovery failed (${discovery.status})`);
  const persistedJourneys = await fetch(`${url}/api/v1/journeys`, { headers: restartedHeaders }).then((response) => response.json());
  if (!persistedJourneys.some((journey) => journey.id === journeyId)) throw new Error("Packaged Journey archive did not persist across restart");
  await stop(second);
  second = undefined;
  run(command("npm"), ["uninstall", "--ignore-scripts", "--prefix", installRoot, "agentjourney"]);
  const tokenAfterUninstall = await readFile(path.join(dataDirectory, "local-auth-token"), "utf8");
  if (tokenAfterUninstall !== tokenBeforeRestart) throw new Error("Uninstall changed persistent AgentJourney data");
  await readFile(path.join(dataDirectory, "archive", "archive.sqlite"));
  run(command("npm"), ["install", "--ignore-scripts", "--omit=optional", "--prefix", installRoot, tarball]);
  third = spawn(process.execPath, [cli, "--no-open", "--data-dir", dataDirectory, "--port", String(port)], {
    stdio: ["ignore", "pipe", "pipe"]
  });
  await waitForHealth(url, third);
  const reinstalledHeaders = await authenticatedHeaders(url);
  const reinstalledJourneys = await fetch(`${url}/api/v1/journeys`, { headers: reinstalledHeaders }).then((response) => response.json());
  if (!reinstalledJourneys.some((journey) => journey.id === journeyId)) throw new Error("Journey archive did not survive package reinstall");
  await stop(third);
  third = undefined;
  console.log(`package smoke passed: agentjourney@${version} on ${process.platform}/${process.arch}`);
} finally {
  if (first) await stop(first).catch(() => first.kill("SIGKILL"));
  if (second) await stop(second).catch(() => second.kill("SIGKILL"));
  if (third) await stop(third).catch(() => third.kill("SIGKILL"));
  if (!process.env.AGENTJOURNEY_KEEP_SMOKE) await rm(temporaryRoot, { recursive: true, force: true });
  else console.log(`retained smoke directory: ${temporaryRoot}`);
}
