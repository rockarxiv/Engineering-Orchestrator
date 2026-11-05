import { CODEWIKI_HOOK_MARKER } from "./hooks.js";

/**
 * A stand-in for the CodeWiki binary, shared by the tests that need one
 * (EO-146, EO-154).
 *
 * Beside the code rather than under a `__fixtures__` directory, for the
 * reason `db/testHelpers.ts` sits beside the database it opens: a
 * helper that only tests import is still source, and burying it makes it
 * the thing nobody updates when the code it stands in for moves.
 *
 * It lives in *this* directory and nowhere else because it is a
 * CodeWiki-shaped fake — it knows the subcommands, the summary lines and
 * the habit of installing git hooks — and
 * `architecturalInvariants.test.ts` says who is allowed to know that.
 * A shared fixture one directory up would be the invariant leaking out
 * through the test suite, which is exactly the route an invariant leaks
 * by.
 */

/**
 * A stand-in for CodeWiki v0.2.1, in Node.
 *
 * `process.execPath` runs it rather than a shebang, for `run.test.ts`'s
 * reason: Windows cannot spawn a shebang script and this suite runs
 * there. Its index is a JSON file at the path the real one keeps a
 * SQLite database, because what the provider knows about that file is
 * that it exists and that the tool can describe it.
 *
 * `EO_SHIM_HOOKS` picks how it installs git hooks: `git` asks git where
 * they go, exactly as upstream does; `repository` writes straight into
 * `<root>/.git/hooks` and ignores the environment, which is the
 * containment breach EO has to detect; `none` installs none.
 * `EO_SHIM_LOG` collects every invocation so a test can assert what was
 * run rather than infer it, and `EO_SHIM_VERSION` replaces what it
 * answers `--version` with — which is how a configured binary gets to
 * say something EO should refuse to store.
 *
 * `query` and `files` answer in v0.2.1's own fixed-column tables, down
 * to the `No matches.` sentence and the `N file(s) total.` footer
 * (EO-173), because what the provider does with them is parse them. The
 * matching is loose on purpose: the real one ranks near misses, and the
 * whole of EO-173 is the caller learning to tell a near miss from an
 * answer.
 */
export const CODEWIKI_SHIM = `
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";

const MARKER = ${JSON.stringify(CODEWIKI_HOOK_MARKER)};
const HOOK_BLOCK = "#!/bin/sh\\n" + MARKER + "\\n( codewiki sync & )\\n# <<< codewiki sync hook <<<\\n";
const argv = process.argv.slice(2);
const command = argv[0];
const marker = argv.indexOf("--path");
const root = marker === -1 ? null : argv[marker + 1];
const mode = process.env.EO_SHIM_HOOKS || "git";

function record(entry) {
  if (process.env.EO_SHIM_LOG) appendFileSync(process.env.EO_SHIM_LOG, JSON.stringify(entry) + "\\n");
}

record({ argv: argv });

if (command === "--version") {
  process.stdout.write((process.env.EO_SHIM_VERSION || "codewiki 0.2.1") + "\\n");
  process.exit(0);
}
if (!root) {
  process.stderr.write("no --path given\\n");
  process.exit(2);
}

const indexDir = join(root, ".codewiki");
const dbFile = join(indexDir, "codewiki.db");

function walk(dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === ".git" || entry.name === ".codewiki") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...walk(full));
    else if (entry.isFile()) found.push(full);
  }
  return found;
}

function symbolsIn(text) {
  const found = [];
  const pattern = /\\b(?:function|class|const|let|var|interface|type|struct|enum)\\s+([A-Za-z_$][A-Za-z0-9_$]*)/g;
  let match = pattern.exec(text);
  while (match !== null) {
    if (found.indexOf(match[1]) === -1) found.push(match[1]);
    match = pattern.exec(text);
  }
  return found;
}

function scan() {
  const files = {};
  const symbols = {};
  for (const file of walk(root)) {
    const body = readFileSync(file);
    const name = relative(root, file);
    files[name] = createHash("sha1").update(body).digest("hex");
    symbols[name] = symbolsIn(body.toString("utf8"));
  }
  return { files: files, symbols: symbols };
}

function readIndex() {
  try {
    return JSON.parse(readFileSync(dbFile, "utf8"));
  } catch {
    return null;
  }
}

function writeIndex(scanned) {
  writeFileSync(dbFile, JSON.stringify(scanned));
}

function installHooks() {
  if (mode === "none") return;
  let target = null;
  if (mode === "repository") {
    target = join(root, ".git", "hooks");
    if (!existsSync(target)) return;
  } else {
    let answer = "";
    try {
      answer = execFileSync("git", ["rev-parse", "--git-path", "hooks"], { cwd: root, encoding: "utf8" }).trim();
    } catch {
      return;
    }
    if (!answer) return;
    target = isAbsolute(answer) ? answer : join(root, answer);
    mkdirSync(target, { recursive: true });
  }
  for (const name of ["post-commit", "post-merge", "post-checkout"]) {
    const file = join(target, name);
    const base = existsSync(file) ? readFileSync(file, "utf8").trimEnd() + "\\n\\n" : "";
    writeFileSync(file, base + HOOK_BLOCK);
  }
  record({ installedHooksIn: target });
}

function reportIndexed(files) {
  const count = Object.keys(files).length;
  process.stdout.write("Indexed " + count + " files, " + count * 2 + " nodes, " + count + " edges in 0.0s\\n");
}

if (command === "init") {
  if (existsSync(dbFile)) {
    process.stdout.write("Already initialized at " + root + "\\n");
    process.exit(0);
  }
  mkdirSync(indexDir, { recursive: true });
  writeIndex({ files: {}, symbols: {} });
  installHooks();
  if (argv.includes("--no-index")) {
    process.stdout.write("Initialized (--no-index: skipped indexing).\\n");
    process.exit(0);
  }
  const scanned = scan();
  writeIndex(scanned);
  reportIndexed(scanned.files);
  process.exit(0);
}

if (command === "index") {
  if (!existsSync(indexDir)) {
    process.stderr.write("no index found at " + dbFile + "; run \`codewiki init\` first\\n");
    process.exit(1);
  }
  const scanned = scan();
  writeIndex(scanned);
  reportIndexed(scanned.files);
  process.exit(0);
}

if (command === "status") {
  const index = readIndex();
  if (index === null) {
    process.stderr.write("no index found at " + dbFile + "; run \`codewiki init\` first\\n");
    process.exit(1);
  }
  const count = Object.keys(index.files).length;
  process.stdout.write(
    "CodeWiki Index Status\\n  Root:              " + root + "\\n  Nodes:             " + count * 2 + "\\n  Edges:             " + count + "\\n  Files:             " + count + "\\n",
  );
  process.exit(0);
}

if (command === "sync") {
  const index = readIndex();
  if (index === null) {
    process.stderr.write("no index found at " + dbFile + "; run \`codewiki init\` first\\n");
    process.exit(1);
  }
  const current = scan();
  let added = 0;
  let modified = 0;
  let removed = 0;
  for (const file of Object.keys(current.files)) {
    if (!(file in index.files)) added += 1;
    else if (index.files[file] !== current.files[file]) modified += 1;
  }
  for (const file of Object.keys(index.files)) if (!(file in current.files)) removed += 1;
  writeIndex(current);
  if (added + modified + removed === 0) process.stdout.write("Nothing to sync — index is up to date.\\n");
  else process.stdout.write("Sync complete: " + added + " added, " + modified + " modified, " + removed + " removed (2 ms)\\n");
  process.exit(0);
}

function column(text, width) {
  const padded = String(text);
  return padded.length >= width ? padded + " " : padded.padEnd(width);
}

function requireIndex() {
  const index = readIndex();
  if (index === null) {
    process.stderr.write("no index found at " + dbFile + "; run \`codewiki init\` first\\n");
    process.exit(1);
  }
  return index;
}

if (command === "query") {
  // Loosely, exactly like the real one: v0.2.1 ranks and returns near
  // matches, so \`quota\` comes back with \`QuotaEvent\` in the list. A
  // stand-in that matched exactly would agree with every caller and
  // prove nothing about the one that has to reject a loose hit.
  const index = requireIndex();
  const wanted = String(argv[1] || "").toLowerCase();
  const rows = [];
  for (const file of Object.keys(index.symbols)) {
    for (const symbol of index.symbols[file]) {
      if (symbol.toLowerCase().indexOf(wanted) !== -1) rows.push([symbol, join(root, file)]);
    }
  }
  if (rows.length === 0) {
    process.stdout.write("No matches.\\n");
    process.exit(0);
  }
  process.stdout.write(column("KIND", 13) + column("LANGUAGE", 13) + column("NAME", 41) + "LOCATION\\n");
  process.stdout.write("-".repeat(80) + "\\n");
  for (const row of rows) {
    process.stdout.write(column("function", 13) + column("typescript", 13) + column(row[0], 41) + row[1] + ":1\\n");
  }
  process.exit(0);
}

if (command === "files") {
  const index = requireIndex();
  const names = Object.keys(index.files);
  if (names.length === 0) {
    process.stdout.write("No files indexed.\\n");
    process.exit(0);
  }
  process.stdout.write(column("LANGUAGE", 17) + column("SIZE", 5) + column("NODES", 7) + "PATH\\n");
  process.stdout.write("-".repeat(60) + "\\n");
  for (const name of names) {
    process.stdout.write(column("TypeScript", 17) + column("128", 5) + column("1", 7) + join(root, name) + "\\n");
  }
  process.stdout.write("\\n" + names.length + " file(s) total.\\n");
  process.exit(0);
}

if (command === "serve") {
  // The query side, as an agent reaches it: line-delimited JSON-RPC over
  // stdio. Enough of it to ask one question and be answered, which is
  // what a test proving a handover sync reached the reviewer needs — the
  // real one exposes nine tools and this exposes the one that can carry
  // that proof. It deliberately does not exit: a server that ended on
  // its own would make "no process was left behind" unfalsifiable.
  const answer = (request) => {
    const reply = (result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: result }) + "\\n");
    if (request.method === "initialize") return reply({ protocolVersion: "2024-11-05", serverInfo: { name: "codewiki", version: "0.2.1" } });
    if (request.method === "tools/list") return reply({ tools: [{ name: "codewiki_search", description: "Find where a symbol is defined." }] });
    if (request.method === "tools/call") {
      // Read per call, not once at startup. \`--no-watch\` means EO's own
      // syncs are the only writes, and a server holding a snapshot from
      // the moment it started could not tell anyone about them.
      const index = readIndex();
      const params = request.params || {};
      const wanted = (params.arguments || {}).query || "";
      const symbols = (index || {}).symbols || {};
      const hits = [];
      for (const file of Object.keys(symbols)) {
        for (const symbol of symbols[file]) if (symbol === wanted) hits.push({ symbol: symbol, file: file });
      }
      return reply({ content: [{ type: "text", text: JSON.stringify(hits) }] });
    }
    return reply({});
  };

  let buffered = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buffered += chunk;
    let cut = buffered.indexOf("\\n");
    while (cut !== -1) {
      const line = buffered.slice(0, cut).trim();
      buffered = buffered.slice(cut + 1);
      if (line !== "") answer(JSON.parse(line));
      cut = buffered.indexOf("\\n");
    }
  });
} else {
  process.stderr.write("unknown command " + command + "\\n");
  process.exit(2);
}
`;
