import { access, readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageRoot = path.join(workspaceRoot, "apps", "distribution");
const packageDocument = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
const approvals = JSON.parse(await readFile(path.join(packageRoot, "release-approvals.json"), "utf8"));
const failures = [];

if (packageDocument.private === true) failures.push("set apps/distribution private=false only after all owner release gates are approved");
if (!packageDocument.license || packageDocument.license === "UNLICENSED") {
  failures.push("choose the AgentJourney project license and replace package license=UNLICENSED");
}
for (const licensePath of [path.join(workspaceRoot, "LICENSE"), path.join(packageRoot, "LICENSE")]) {
  try { await access(licensePath); } catch { failures.push(`add ${path.relative(workspaceRoot, licensePath)}`); }
}
const repositoryUrl = typeof packageDocument.repository === "string"
  ? packageDocument.repository
  : packageDocument.repository?.url;
if (!repositoryUrl || repositoryUrl.includes("<")) failures.push("set the canonical repository, bugs, and homepage package metadata");
const origin = spawnSync("git", ["remote", "get-url", "origin"], { cwd: workspaceRoot, encoding: "utf8" });
if (origin.status !== 0 || !origin.stdout.trim()) failures.push("configure the canonical Git remote named origin");
if (repositoryUrl && origin.status === 0) {
  const normalize = (value) => value.trim().replace(/^git\+/u, "").replace(/\.git$/u, "").replace(/^git@github\.com:/u, "https://github.com/");
  if (normalize(repositoryUrl) !== normalize(origin.stdout)) failures.push("make package repository metadata match the origin remote");
}
const releaseTag = process.env.GITHUB_REF_NAME || process.env.AGENTJOURNEY_RELEASE_TAG;
if (releaseTag && releaseTag !== `v${packageDocument.version}`) {
  failures.push(`release tag ${releaseTag} does not match package version v${packageDocument.version}`);
}
if (approvals.npmPackageOwnershipConfirmed !== true) failures.push("confirm npm package ownership in apps/distribution/release-approvals.json");
if (approvals.ffmpegDistributionApproved !== true) failures.push("approve or replace the optional FFmpeg distribution in apps/distribution/release-approvals.json");
if (!String(packageDocument.version).includes("-") && packageDocument.version.startsWith("0.1.0")) {
  failures.push("publish at least one alpha/beta under the next dist-tag before the first stable version");
}

if (failures.length) {
  console.error("Release is blocked by required owner decisions/setup:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`release metadata ready for agentjourney@${packageDocument.version}`);
}
