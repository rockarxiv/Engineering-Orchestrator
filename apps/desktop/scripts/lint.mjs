// `pnpm lint` for apps/desktop (EO-737): eslint in several processes, one
// after another, so no process holds more than one TypeScript program,
// and src/main's program, the largest, is split over several passes.
//
// Type-aware rules make typescript-eslint build one program per tsconfig
// a linted file belongs to, and keep it for the life of the process along
// with every type the rules asked its checker about. A single `eslint .`
// held all four of this app's programs (src/main, src/preload,
// src/renderer, e2e) and peaked at about 4 GB of heap. src/main alone
// peaks at about 3 GB, more than `tsc` needs to check it in full (about
// 2.1 GB), because the rules' type queries are cached on top of the
// check. The cost grows with the number of files linted against the
// program, over a floor of about 0.9 GB to build it. So src/main is split
// by its top-level entries into MAIN_SHARDS passes, balanced by size.
// Each pass builds the program again and lints only its share of files.
//
// The passes partition the app by path. Each typed tree is its own pass,
// and the last pass is `.` with exactly those trees ignored. So every file
// `eslint .` would lint is linted exactly once, under the same
// eslint.config.js and the same rules. src/main/lintPasses.test.ts checks this.
//
// `--plan` prints the passes as JSON and lints nothing. Any other
// arguments (`--fix`, `--format json`) are passed to every pass.

import { spawnSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

/**
 * Every pass's heap cap, in MB. A pass that reaches it fails loudly
 * rather than growing into the machine: agents lint several worktrees at
 * once on one machine. When a shard of `src/main` reaches it, raise
 * MAIN_SHARDS, not this.
 */
const HEAP_MB = 2560;

/**
 * How many passes src/main is linted in. Four peaked at about 1.85 GB
 * each when this was written (EO-737). Three peaked at about 2.1 GB,
 * because src/main/ipc alone takes about 1.7 GB. Each extra pass costs a
 * few seconds to build the program again.
 */
const MAIN_SHARDS = 4;

/** The trees a type-aware config in eslint.config.js covers, each with its own tsconfig. */
const TYPED_TREES = [
  { name: "preload", paths: ["src/preload"] },
  { name: "renderer", paths: ["src/renderer"] },
  { name: "e2e", paths: ["e2e", "playwright.config.ts"] },
];

/** What eslint lints of a directory's files under this config: JavaScript and TypeScript. */
const LINTED_EXTENSIONS = new Set([".js", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts"]);

const appRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Bytes of TypeScript under a path: the weight a shard is balanced by. */
function weightOf(path) {
  const stat = statSync(path);
  if (!stat.isDirectory()) return stat.size;
  let total = 0;
  for (const entry of readdirSync(path, { recursive: true, withFileTypes: true })) {
    if (entry.isFile() && LINTED_EXTENSIONS.has(extname(entry.name))) total += statSync(join(entry.parentPath, entry.name)).size;
  }
  return total;
}

/**
 * `src/main`'s top-level entries in `shards` groups of about equal size:
 * heaviest first, each to the lightest group so far. Files eslint would
 * not lint are left out, because naming one explicitly makes eslint warn
 * about it.
 */
function shardMain(root, shards) {
  const mainDir = join(root, "src", "main");
  const entries = readdirSync(mainDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() || LINTED_EXTENSIONS.has(extname(entry.name)))
    .map((entry) => ({ path: `src/main/${entry.name}`, weight: weightOf(join(mainDir, entry.name)) }))
    .sort((a, b) => b.weight - a.weight || a.path.localeCompare(b.path));
  const groups = Array.from({ length: shards }, () => ({ weight: 0, paths: [] }));
  for (const entry of entries) {
    const lightest = groups.reduce((min, group) => (group.weight < min.weight ? group : min));
    lightest.weight += entry.weight;
    lightest.paths.push(entry.path);
  }
  return groups.filter((group) => group.paths.length > 0).map((group) => [...group.paths].sort());
}

/** The passes `pnpm lint` runs, in order: each a name and the arguments eslint is given. */
function lintPasses(root = appRoot) {
  const main = shardMain(root, MAIN_SHARDS).map((paths, index, all) => ({
    name: `main ${index + 1}/${all.length}`,
    // A directory with nothing eslint lints in it is not an error here:
    // `eslint .` would have passed over it the same way.
    args: [...paths, "--no-error-on-unmatched-pattern"],
  }));
  const typed = TYPED_TREES.map((tree) => ({ name: tree.name, args: [...tree.paths] }));
  const ownTrees = ["src/main", ...TYPED_TREES.flatMap((tree) => tree.paths)];
  // Directories as `dir/**`: a flat-config ignore pattern is relative to
  // this directory and matches at that path only.
  const rest = {
    name: "rest",
    args: [".", ...ownTrees.flatMap((path) => ["--ignore-pattern", extname(path) === "" ? `${path}/**` : path])],
  };
  return [...main, ...typed, rest];
}

function run() {
  const passes = lintPasses();
  const forwarded = process.argv.slice(2);
  if (forwarded.includes("--plan")) {
    process.stdout.write(`${JSON.stringify({ heapMb: HEAP_MB, passes })}\n`);
    return 0;
  }
  // Through this path rather than a resolved one: typescript-eslint only
  // treats a run as single (no watch programs) when the script it runs as
  // ends in node_modules/eslint/bin/eslint.js, outside CI.
  const eslint = join(appRoot, "..", "..", "node_modules", "eslint", "bin", "eslint.js");
  let status = 0;
  for (const pass of passes) {
    process.stderr.write(`lint ${pass.name}\n`);
    const result = spawnSync(process.execPath, [`--max-old-space-size=${HEAP_MB}`, eslint, ...pass.args, ...forwarded], {
      cwd: appRoot,
      stdio: "inherit",
    });
    // Every pass runs whatever an earlier one found, as one `eslint .` reported every file.
    if (result.status !== 0) {
      process.stderr.write(`lint ${pass.name} failed (${result.error?.message ?? result.signal ?? `exit ${result.status}`})\n`);
      status = 1;
    }
  }
  return status;
}

// Unconditionally, rather than behind an "is this the entry module" check
// comparing import.meta.url with process.argv[1]: on Windows the two can
// differ in a drive letter's case, and a check that quietly fails there
// would make `pnpm lint` lint nothing and pass. Nothing imports this file.
process.exitCode = run();
