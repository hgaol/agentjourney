import { access, cp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workspaceRoot = path.resolve(packageRoot, "../..");
const source = path.join(workspaceRoot, "apps", "web", "dist");
const distributionDirectory = path.join(packageRoot, "dist");
const destination = path.join(distributionDirectory, "web");

// esbuild's builtin table predates node:sqlite and strips its node: prefix.
// Restore the explicit builtin specifier and fail closed if the output shape changes.
let sqliteImportCount = 0;
for (const entry of await readdir(distributionDirectory, { withFileTypes: true })) {
  if (!entry.isFile() || !entry.name.endsWith(".js")) continue;
  const filePath = path.join(distributionDirectory, entry.name);
  const sourceText = await readFile(filePath, "utf8");
  const patchedText = sourceText.replaceAll('from "sqlite"', 'from "node:sqlite"');
  if (patchedText !== sourceText) {
    sqliteImportCount += 1;
    await writeFile(filePath, patchedText);
  }
}
if (sqliteImportCount !== 1) throw new Error(`Expected one bundled node:sqlite import, found ${sqliteImportCount}`);

await access(path.join(source, "index.html"));
await rm(destination, { recursive: true, force: true });
await cp(source, destination, { recursive: true });

async function removeSourceMaps(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filePath = path.join(directory, entry.name);
    if (entry.isDirectory()) await removeSourceMaps(filePath);
    else if (entry.isFile() && entry.name.endsWith(".map")) await rm(filePath);
  }
}

await removeSourceMaps(destination);
console.log(`staged Web assets in ${path.relative(workspaceRoot, destination)}`);
