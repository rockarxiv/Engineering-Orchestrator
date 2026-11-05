#!/usr/bin/env node
/**
 * Regenerates NOTICE from what the installer actually contains.
 *
 * Hand-maintained attribution files are wrong within a release or two —
 * a dependency is added, nobody remembers, and the file quietly stops
 * describing the thing it is attached to. This reads the packed
 * `app.asar` instead, so the list is whatever really shipped.
 *
 *   pnpm --filter @eo/desktop exec electron-builder --linux dir
 *   node scripts/third-party-notice.mjs
 *
 * Deliberately driven off a real build rather than the dependency tree:
 * `dependencies` in package.json and "what electron-builder collected"
 * are different questions, and the second one is the one a licence
 * obligation attaches to.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const asar = join(repoRoot, "apps/desktop/release/linux-unpacked/resources/app.asar");

if (!existsSync(asar)) {
  console.error(`No packed app at ${asar}\nBuild one first:\n  pnpm --filter @eo/desktop exec electron-builder --linux dir`);
  process.exit(1);
}

const listing = execFileSync("npx", ["asar", "list", asar], { encoding: "utf8", cwd: repoRoot });

const names = new Set();
for (const line of listing.split("\n")) {
  const parts = line.split("/");
  if (parts[1] !== "node_modules" || !parts[2]) continue;
  const name = parts[2].startsWith("@") ? (parts[3] ? `${parts[2]}/${parts[3]}` : null) : parts[2];
  // EO's own workspace packages are not third party.
  if (name && !name.startsWith("@eo/")) names.add(name);
}

/** pnpm keeps the real files in a content-addressed store, so search both. */
function readPackage(name) {
  const direct = join(repoRoot, "apps/desktop/node_modules", name, "package.json");
  if (existsSync(direct)) return JSON.parse(readFileSync(direct, "utf8"));
  const found = execFileSync("sh", ["-c", `ls -d ${repoRoot}/node_modules/.pnpm/*/node_modules/${name}/package.json 2>/dev/null | head -1`], {
    encoding: "utf8",
  }).trim();
  return found ? JSON.parse(readFileSync(found, "utf8")) : null;
}

const rows = [];
const unknown = [];
for (const name of [...names].sort()) {
  const manifest = readPackage(name);
  if (!manifest) {
    unknown.push(`${name} (not found on disk)`);
    continue;
  }
  const licence = typeof manifest.license === "string" ? manifest.license : (manifest.licenses?.[0]?.type ?? null);
  if (!licence || licence.startsWith("SEE LICENSE")) unknown.push(`${name}@${manifest.version} → ${licence ?? "no license field"}`);
  rows.push({ name, version: manifest.version ?? "?", licence: licence ?? "UNDECLARED" });
}

const header = readFileSync(join(repoRoot, "scripts/notice-header.md"), "utf8").trimEnd();
const table = [
  "| Package | Version | Licence |",
  "| --- | --- | --- |",
  ...rows.map((r) => `| \`${r.name}\` | ${r.version} | ${r.licence} |`),
].join("\n");

writeFileSync(
  join(repoRoot, "NOTICE"),
  `${header}\n\n## Bundled components\n\n${rows.length} packages are included in the application bundle.\n\n${table}\n`,
);

console.log(`NOTICE written: ${rows.length} packages.`);
if (unknown.length > 0) {
  // Loud, and non-zero: an undeclared licence in a product being sold
  // is precisely the thing this script exists to catch.
  console.error(`\nUNDECLARED OR UNCLEAR LICENCES — these need a human:\n  ${unknown.join("\n  ")}`);
  process.exit(2);
}
