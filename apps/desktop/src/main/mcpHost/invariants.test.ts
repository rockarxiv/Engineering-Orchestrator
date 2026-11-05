import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const hostRoot = dirname(fileURLToPath(import.meta.url));

/**
 * A database write, as against a Map one.
 *
 * The first version of this listed `.insert(`, `.update(` and `.delete(`
 * as bare substrings and immediately flagged two innocent files: a
 * `Set<Listener>` disposer and the session map's cleanup both call
 * `.delete(`. A check that fires on `sessions.delete(id)` teaches
 * everyone to ignore it, which is worse than not having it.
 *
 * So the receiver has to look like a database handle. That is what
 * Drizzle writes look like everywhere in this app — `db.insert(...)`,
 * `handle.db.delete(...)` — and it is what the invariant is actually
 * about: reaching the database directly rather than through a handler.
 */
/**
 * A query builder's write, whatever the handle happens to be called.
 *
 * Two earlier versions of this were wrong in opposite directions, and
 * both mistakes are worth keeping written down.
 *
 * The first matched the bare substrings `.insert(`, `.update(` and
 * `.delete(`, and immediately flagged a `Set<Listener>` disposer and a
 * session map's cleanup. A check that fires on `sessions.delete(id)`
 * teaches everyone to ignore it.
 *
 * The second required the receiver to be named `db`, and a review
 * demonstrated three ways around it in one sitting:
 * `database.insert(items)`, `const { db: store } = handle;
 * store.update(items)`, and any parameter named something else.
 *
 * So this matches the *shape* instead: a write verb taking a table, and
 * then a builder method chained off it. `sessions.delete(id)` has no
 * continuation and is ignored; `store.update(items).set({...})` is
 * caught however the handle was spelled.
 */
const BUILDER_WRITE = /\.\s*(?:insert|update|delete)\s*\([^)]*\)\s*(?:\.|\n\s*\.)\s*(?:values|set|where|returning|run|get|all)\b/;

/**
 * The one function whose misuse the whole architecture is arranged to
 * prevent. Named separately because a host that called it would be wrong
 * even though the call goes through a repo rather than a query builder.
 */
const TRANSITION = /\btransitionItem\b/;

/**
 * Reaching the repo layer at all.
 *
 * The likeliest real violation is not a query builder — it is
 * `createItem(db, …)` or `postComment(db, …)`, imported from
 * `db/repos`, which writes exactly as directly and matches none of the
 * patterns above. Naming every write helper would be a list to keep in
 * step with a growing module; forbidding the import is one rule that
 * cannot fall behind it.
 *
 * `db/client` is here too: it is where a handle comes from, and a file
 * that has one has already left the path this invariant describes. The
 * type-only import `import type { Db }` is deliberately still allowed —
 * a signature naming the handle it will be given is not a second door.
 */
const REPO_IMPORT = /^\s*import\s+(?!type\b)[^;]*?from\s+"[^"]*db\/(?:repos|client)[^"]*"/m;

/**
 * Source with its prose taken out.
 *
 * Comments are where an invariant gets explained, and explaining one
 * means naming what it forbids. Stripping them first is the difference
 * between a check and a trap for whoever documents it.
 */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/**
 * The MCP host reaches EO only through registered handlers.
 *
 * This is the wall around a carve-out. Everything here dispatches
 * through `ipc/registry.ts`, which means every write goes through the
 * same handler the renderer calls, which means invariant #1 holds
 * without this directory having to know what `transitionItem` is. The
 * carve-out is that a few reads a native dialog was wrapping — pipeline
 * export, most of all — are cheaper to call directly than to re-plumb,
 * and the moment one of those exists, "the host only dispatches" stops
 * being obvious from reading the imports.
 *
 * So it is asserted instead. A read reached directly is a shortcut; a
 * *write* reached directly is a second door into the database, and the
 * difference has to be something a test can see rather than something a
 * reviewer has to notice.
 *
 * Where the line is, precisely: this forbids writing EO's **domain**
 * data — items, comments, runs, pipelines. It does not forbid gate.ts
 * storing the server's own port and switches through `setSetting`,
 * because that row is this server's configuration and not something any
 * handler owns. The distinction matters, so it is written down rather
 * than left to be inferred from what the regex happens to catch: a
 * future `db.update(items)` here is the failure being guarded against,
 * and `setSetting(db, "mcp.port", 4319)` is not.
 */
function walkTsFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkTsFiles(full));
    } else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      files.push(full);
    }
  }
  return files;
}

/**
 * The two files allowed to reach the settings repo.
 *
 * `gate.ts` stores this server's own port and switches, and that row is
 * not domain data — no handler owns it, and the whole reason the host
 * notices a settings change is that `gate.ts` writes it and announces
 * it. Allowlisted by name rather than by loosening the rule, which is
 * how `db/architecturalInvariants.test.ts` handles the single writer of
 * `items.stepId`: one exception a reader can see, not a pattern with a
 * hole in it.
 *
 * `aliasUse.ts` is the same kind of row on the same grounds (KAN-178):
 * which of its two names each connected client last called. Nothing in
 * EO's domain — no item, comment, run or pipeline is touched — and no
 * handler owns it either, because the fact it records exists nowhere but
 * here. It is the server's own note about the programs talking to it,
 * stored beside the server's own port, and the Servers screen reads it
 * so that the alias period is something a person is told rather than
 * something their editor discovers.
 */
const ALLOWED = ["gate.ts", "aliasUse.ts"];

function findDirectWriters(root: string): string[] {
  return walkTsFiles(root)
    .filter((file) => !ALLOWED.includes(basename(file)))
    .filter((file) => {
      const code = withoutComments(readFileSync(file, "utf8"));
      return BUILDER_WRITE.test(code) || TRANSITION.test(code) || REPO_IMPORT.test(code);
    })
    .map((file) => relative(root, file));
}

describe("architectural invariant: the MCP host never writes to the database", () => {
  it("no file under mcpHost/ writes directly in the real source tree", () => {
    expect(findDirectWriters(hostRoot)).toEqual([]);
  });

  it("the scanner catches a direct write and ignores one that is only described (proves it's not a tautology)", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "eo-mcp-invariant-check-"));
    try {
      writeFileSync(join(tempDir, "sneaky.ts"), 'db.update(tickets).set({ title: "x" }).run();');
      writeFileSync(join(tempDir, "transition.ts"), 'transitionItem(db, { itemId, toStepId });');
      // The three evasions a review demonstrated against the first
      // version of this scanner, each of which it passed clean.
      writeFileSync(join(tempDir, "renamed.ts"), 'database.insert(tickets).values({ id }).run();');
      writeFileSync(join(tempDir, "destructured.ts"), "const { db: store } = handle;\nstore.update(tickets).set({ title }).run();");
      writeFileSync(join(tempDir, "repoHelper.ts"), 'import {} from "../db/repos/index.js";\ncreateItem(anything, {});');

      writeFileSync(join(tempDir, "reads.ts"), "const rows = db.select().from(tickets).all();");
      writeFileSync(join(tempDir, "documented.ts"), "// This module must never call db.update( on anything.\nexport const x = 1;\n");
      // The false positives that made the first version of this useless.
      writeFileSync(join(tempDir, "maps.ts"), "sessions.delete(id);\nlisteners.delete(listener);\n");
      // A type-only import of the handle is a signature, not a door.
      writeFileSync(join(tempDir, "typeOnly.ts"), 'import type { Db } from "../db/client.js";\nexport function f(db: Db): void {}\n');
      // The false positive the shape rule exists to avoid: a Map delete
      // with no builder continuation.
      writeFileSync(join(tempDir, "mapDelete.ts"), "sessions.delete(id);\nconst all = cache.values();\n");

      expect(findDirectWriters(tempDir).sort()).toEqual([
        "destructured.ts",
        "renamed.ts",
        "repoHelper.ts",
        "sneaky.ts",
        "transition.ts",
      ]);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

/**
 * A value handed straight to the caller, as against a rendering of one.
 *
 * `text: guide.body` and `text: problem` are the answer itself: whatever
 * that value holds is what the caller reads, and nothing else in the
 * outcome is obliged to hold it too. `text: renderItems(data)`,
 * `text: \`Saved ${name}.\`` and an array joined into lines are the
 * other kind — `data` is the substance and the text is it written out,
 * so one copy of the facts is enough.
 *
 * Only the first kind can lose the answer, which is why this is the
 * shape the check keys on rather than the length of the string or the
 * name of the tool.
 */
const BARE_REFERENCE = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/;

/**
 * Source characters that are code, in order, with their bracket depth.
 *
 * Strings and template literals are stepped over rather than read: a
 * `}` inside `\`Saved ${name}.\`` closes an interpolation and a `{` in a
 * quoted message closes nothing at all, and a check that cannot tell
 * those apart mis-reads the first literal it meets. `visit` returning
 * true stops the walk.
 */
function walkCode(source: string, start: number, visit: (index: number, char: string, depth: number) => boolean): void {
  const stack: string[] = [];
  for (let i = start; i < source.length; i += 1) {
    const char = source[i]!;
    const top = stack[stack.length - 1];
    if (top === "'" || top === '"' || top === "`") {
      if (char === "\\") {
        i += 1;
      } else if (char === top) {
        stack.pop();
      } else if (top === "`" && char === "$" && source[i + 1] === "{") {
        stack.push("{");
        i += 1;
      }
      continue;
    }
    if (visit(i, char, stack.length)) return;
    if (char === "'" || char === '"' || char === "`" || char === "{" || char === "[" || char === "(") stack.push(char);
    else if (char === "}" || char === "]" || char === ")") stack.pop();
  }
}

/** One object literal, from its `{` to the `}` that closes it. */
function objectLiteralAt(source: string, open: number): string {
  let end = source.length;
  walkCode(source, open, (index, char, depth) => {
    if (char === "}" && depth === 1) {
      end = index + 1;
      return true;
    }
    return false;
  });
  return source.slice(open, end);
}

/**
 * The properties written at the top level of one object literal, as
 * source text. Shorthand counts: `{ data }` is `data: data`, and that is
 * what it means for the check below.
 */
function propertiesOf(literal: string): Record<string, string> {
  const inner = literal.slice(1, -1);
  const cuts: number[] = [];
  walkCode(inner, 0, (index, char, depth) => {
    if (char === "," && depth === 0) cuts.push(index);
    return false;
  });

  const properties: Record<string, string> = {};
  let from = 0;
  for (const cut of [...cuts, inner.length]) {
    const part = inner.slice(from, cut).trim();
    from = cut + 1;
    const named = /^([A-Za-z_$][\w$]*)\s*:\s*([\s\S]+)$/.exec(part);
    if (named !== null) properties[named[1]!] = named[2]!.trim();
    else if (/^[A-Za-z_$][\w$]*$/.test(part)) properties[part] = part;
  }
  return properties;
}

/** Whether an expression names the same value somewhere, rather than merely containing its letters. */
function mentions(expression: string, reference: string): boolean {
  return new RegExp(`(?<![\\w$.])${reference.replace(/\./g, "\\.")}(?![\\w$])`).test(expression);
}

/**
 * Every successful answer in this source whose substance reaches one
 * door only.
 *
 * `callTool` sends `text` as `content` and `data` as
 * `structuredContent`, both, on every successful call, and the spec
 * lets a client surface either — so an answer that lives in `text`
 * alone is invisible to half of them. A `channelTool` renders its text
 * from the data it is about to send and cannot drift; a hand-written
 * `run` can, and `eo_guide` did, serving `{name, title}` and no guide
 * to anything reading structured output (EO-202).
 *
 * So: where `text` is handed a value rather than a rendering, that same
 * value must appear elsewhere in the answer. Spelling it out — `data: {
 * ..., body: guide.body }` — is what satisfies this. A spread that
 * happens to carry it does not, deliberately: the check reads what is
 * written, and a rule that tried to guess what `...guide` contains
 * would be a rule nobody could predict.
 */
function answersInTextAlone(source: string): string[] {
  const code = withoutComments(source);
  const found: string[] = [];

  for (const match of code.matchAll(/\bok:\s*true\s*,/g)) {
    // Backwards to the literal this property belongs to. More than one
    // hop because a value written before `ok` can open a brace of its
    // own; bounded because an unbalanced file should end the search
    // rather than the run.
    let open = code.lastIndexOf("{", match.index);
    let properties: Record<string, string> = {};
    for (let hop = 0; open !== -1 && hop < 5; hop += 1) {
      properties = propertiesOf(objectLiteralAt(code, open));
      if (properties["ok"] === "true") break;
      open = code.lastIndexOf("{", open - 1);
    }
    if (properties["ok"] !== "true") continue;

    const text = properties["text"];
    if (text === undefined || !BARE_REFERENCE.test(text)) continue;

    const elsewhere = Object.entries(properties)
      .filter(([key]) => key !== "text")
      .map(([, value]) => value)
      .join(" ");
    if (mentions(elsewhere, text)) continue;

    const data = (properties["data"] ?? "nothing").replace(/\s+/g, " ");
    found.push(`text: ${text} (data: ${data.length > 60 ? `${data.slice(0, 60)}…` : data})`);
  }
  return found;
}

/**
 * A tool's answer reaches both doors.
 *
 * The rule is stated on `ToolOutcome`, where a hand-built tool is
 * written. This is what holds it: the catalogue is where every tool
 * built by hand lives, and the failure it is about — a guide that
 * arrived as a label — looked like a working call from the outside.
 */
describe("architectural invariant: a hand-built tool answers in both of the doors it is served through", () => {
  it("no tool in the catalogue keeps its answer in `text` alone", () => {
    expect(answersInTextAlone(readFileSync(join(hostRoot, "catalog.ts"), "utf8"))).toEqual([]);
  });

  it("catches the shape this was written for and leaves a rendering alone (proves it's not a tautology)", () => {
    // What eo_guide returned before EO-202, and what it returns now.
    expect(answersInTextAlone("return { ok: true, refused: false, data: { name: guide.name, title: guide.title }, text: guide.body };")).toEqual([
      "text: guide.body (data: { name: guide.name, title: guide.title })",
    ]);
    expect(answersInTextAlone("return { ok: true, refused: false, data: { name: guide.name, body: guide.body }, text: guide.body };")).toEqual([]);

    // A rendering: `data` is the substance and the text writes it out.
    expect(answersInTextAlone("return { ok: true, refused: false, data, text: renderSpend(report) };")).toEqual([]);
    expect(answersInTextAlone("return { ok: true, refused: false, data: { pipeline }, text: `Created ${pipeline.name}.` };")).toEqual([]);
    expect(answersInTextAlone('return { ok: true, refused: false, data: { guides }, text: ["EO\'s guides:", ...lines].join("\\n") };')).toEqual([]);

    // A refusal is an answer too, and its reason is a value: it has to
    // travel in both copies like any other.
    expect(answersInTextAlone("return { ok: true, refused: true, text: problem, data: { created: false, problem } };")).toEqual([]);
    expect(answersInTextAlone("return { ok: true, refused: true, text: problem, data: { created: false, pipeline: null } };")).toEqual([
      "text: problem (data: { created: false, pipeline: null })",
    ]);

    // A brace inside a quoted message closes nothing, and a comment
    // describing the mistake is not the mistake.
    expect(answersInTextAlone('return { ok: true, refused: false, data: { note: "a { in a string" , body }, text: body };')).toEqual([]);
    expect(answersInTextAlone("// { ok: true, data: { name }, text: guide.body }\nexport const x = 1;")).toEqual([]);

    // The type that declares the shape is not an answer in it.
    expect(answersInTextAlone("type ToolOutcome = { ok: true; text: string; data: unknown; refused: boolean };")).toEqual([]);
  });
});
