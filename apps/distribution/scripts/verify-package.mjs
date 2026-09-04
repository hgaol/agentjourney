import { builtinModules } from "node:module";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageDocument = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
const failures = [];

async function filesUnder(directory, prefix = "") {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relativePath = path.posix.join(prefix, entry.name);
    if (entry.isDirectory()) files.push(...await filesUnder(path.join(directory, entry.name), relativePath));
    else if (entry.isFile()) files.push(relativePath);
  }
  return files;
}

const distDirectory = path.join(packageRoot, "dist");
const distFiles = await filesUnder(distDirectory);
for (const required of ["cli.js", "web/index.html"]) {
  if (!distFiles.includes(required)) failures.push(`missing ${required}`);
}
if (packageDocument.name !== "agentjourney") failures.push("package name must be agentjourney");
if (!String(packageDocument.version).match(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u)) failures.push("package version is not semver-like");
if (JSON.stringify(packageDocument).includes("workspace:")) failures.push("packed package metadata contains a workspace protocol");

const cli = await readFile(path.join(distDirectory, "cli.js"), "utf8");
if (!cli.startsWith("#!/usr/bin/env node")) failures.push("CLI is missing its node shebang");
const javascriptFiles = distFiles.filter((file) => file.endsWith(".js") && !file.startsWith("web/"));
const declaredRuntimePackages = new Set([
  ...Object.keys(packageDocument.dependencies ?? {}),
  ...Object.keys(packageDocument.optionalDependencies ?? {})
]);
const builtins = new Set([...builtinModules, ...builtinModules.map((name) => `node:${name}`), "node:sqlite"]);
const externalPackages = new Set();
for (const relativePath of javascriptFiles) {
  const source = await readFile(path.join(distDirectory, relativePath), "utf8");
  if (/from ["']@agentjourney\//u.test(source) || /import\(["']@agentjourney\//u.test(source)) {
    failures.push(`${relativePath} imports a private workspace package`);
  }
  if (source.includes("workspace:*")) failures.push(`${relativePath} embeds a workspace protocol`);
  if (source.includes(process.cwd())) failures.push(`${relativePath} embeds the build working directory`);
  for (const match of source.matchAll(/(?:from\s*|import\()["']([^"']+)["']/gu)) {
    const specifier = match[1];
    if (!specifier || specifier.startsWith(".") || specifier.startsWith("/") || builtins.has(specifier)) continue;
    const packageName = specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0];
    externalPackages.add(packageName);
  }
}
for (const packageName of externalPackages) {
  if (!declaredRuntimePackages.has(packageName)) failures.push(`undeclared runtime package import: ${packageName}`);
}
if (javascriptFiles.length === 0) failures.push("runtime bundle is missing");
if (!javascriptFiles.some((file) => file !== "cli.js")) failures.push("runtime must remain lazy so --help and --version avoid host initialization");

const webIndex = await readFile(path.join(distDirectory, "web", "index.html"), "utf8");
for (const match of webIndex.matchAll(/(?:src|href)="\/(assets\/[^"?]+|favicon\.svg)"/gu)) {
  if (!distFiles.includes(`web/${match[1]}`)) failures.push(`Web index references missing ${match[1]}`);
}
for (const relativePath of distFiles) {
  if (relativePath.endsWith(".map") && relativePath.startsWith("web/")) failures.push(`Web source map should not ship: ${relativePath}`);
  if (/(^|\/)(?:\.env|auth\.json|local-auth-token|archive\.sqlite)$/u.test(relativePath)) failures.push(`forbidden sensitive file: ${relativePath}`);
}
const totalBytes = (await Promise.all(distFiles.map(async (file) => (await stat(path.join(distDirectory, file))).size)))
  .reduce((total, size) => total + size, 0);
if (totalBytes > 8 * 1024 * 1024) failures.push(`dist exceeds 8 MiB (${totalBytes} bytes)`);

if (failures.length) {
  throw new Error(`Distribution verification failed:\n- ${failures.join("\n- ")}`);
}
console.log(`verified ${distFiles.length} distribution files (${(totalBytes / 1024 / 1024).toFixed(2)} MiB)`);
