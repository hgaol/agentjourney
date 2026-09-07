import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageRoot = path.join(workspaceRoot, "apps", "distribution");
const releaseDirectory = path.join(workspaceRoot, "release");
await mkdir(releaseDirectory, { recursive: true });
for (const file of await readdir(releaseDirectory)) {
  if (file.endsWith(".tgz") || file.endsWith(".cdx.json") || file === "pack-manifest.json") await rm(path.join(releaseDirectory, file));
}

const packageDocument = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
if (packageDocument.private === true && process.env.AGENTJOURNEY_ALLOW_PRIVATE_PACK !== "1") {
  throw new Error("Distribution package is private. Set AGENTJOURNEY_ALLOW_PRIVATE_PACK=1 only for local artifact verification.");
}

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const localArtifact = packageDocument.private === true;
const originalPackageJson = localArtifact ? `${JSON.stringify(packageDocument, null, 2)}\n` : undefined;
if (localArtifact) {
  const packableDocument = { ...packageDocument };
  delete packableDocument.private;
  await writeFile(path.join(packageRoot, "package.json"), `${JSON.stringify(packableDocument, null, 2)}\n`);
}
let packed;
try {
  packed = spawnSync(npm, ["pack", "--ignore-scripts", "--json", "--pack-destination", releaseDirectory], {
    cwd: packageRoot,
    encoding: "utf8",
    shell: process.platform === "win32",
    stdio: ["ignore", "pipe", "pipe"]
  });
} finally {
  if (originalPackageJson) await writeFile(path.join(packageRoot, "package.json"), originalPackageJson);
}
if (packed.error) throw new Error(`npm pack could not start: ${packed.error.message}`);
if (packed.status !== 0) throw new Error(`npm pack failed (${packed.status ?? "unknown"})\n${packed.stderr ?? ""}`);
const result = JSON.parse(packed.stdout)[0];
if (!result?.filename || !Array.isArray(result.files)) throw new Error("npm pack returned an unexpected manifest");
const paths = result.files.map((file) => file.path);
const failures = [];
for (const required of ["package.json", "README.md", "CHANGELOG.md", "LICENSE", "NOTICE", "THIRD_PARTY_NOTICES.md", "dist/cli.js", "dist/web/index.html"]) {
  if (!paths.includes(required)) failures.push(`missing ${required}`);
}
for (const file of paths) {
  if (/^(?:src|test|scripts)\//u.test(file)) failures.push(`development file included: ${file}`);
  if (/(?:^|\/)(?:\.env|local-auth-token|archive\.sqlite)$/u.test(file)) failures.push(`sensitive file included: ${file}`);
  if (file.startsWith("dist/web/") && file.endsWith(".map")) failures.push(`Web source map included: ${file}`);
}
if (result.unpackedSize > 8 * 1024 * 1024) failures.push(`unpacked package exceeds 8 MiB (${result.unpackedSize})`);
if (result.size > 5 * 1024 * 1024) failures.push(`tarball exceeds 5 MiB (${result.size})`);
if (failures.length) throw new Error(`Packed tarball verification failed:\n- ${failures.join("\n- ")}`);

const manifest = {
  name: result.name,
  version: result.version,
  filename: result.filename,
  size: result.size,
  unpackedSize: result.unpackedSize,
  shasum: result.shasum,
  integrity: result.integrity,
  fileCount: result.files.length
};
await writeFile(path.join(releaseDirectory, "pack-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`packed ${result.name}@${result.version}`);
console.log(`tarball: ${path.join(releaseDirectory, result.filename)}`);
console.log(`files: ${result.files.length}; ${(result.size / 1024).toFixed(1)} KiB packed; ${(result.unpackedSize / 1024 / 1024).toFixed(2)} MiB unpacked`);
