import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const mainSrcRoot = join(here, "..");

/**
 * The directory the implementation is allowed to live in, and the only
 * one allowed to import from it.
 *
 * It does not exist yet — the adapter is a later story. The rule is
 * written first on purpose: an invariant added after the code it
 * constrains is an invariant that has to be argued for against working
 * software, and this one is the point of the whole feature rather than
 * a tidiness preference.
 */
const IMPLEMENTATION_DIR = join(mainSrcRoot, "repositoryIntelligence", "codewiki");

/**
 * This file, excluded from its own scan.
 *
 * Unavoidable and worth stating plainly: the self-test below writes
 * fixtures that are literally the import it forbids, so a scanner that
 * read this file would report itself. `db/architecturalInvariants.test.ts`
 * sidesteps the same problem by skipping every `.test.ts`; this one
 * excludes exactly one file instead, because a test that reaches past
 * the port is a real violation — it is how a provider-specific
 * assumption gets written down, and from there copied into the
 * production code that has to satisfy it.
 */
const THIS_FILE = fileURLToPath(import.meta.url);

/**
 * The composition root, and the only production file allowed past the
 * rule (EO-149).
 *
 * Something has to call the constructor. A port keeps every *consumer*
 * ignorant of what is underneath, which is the property this whole
 * subsystem exists to protect, but it cannot make the object appear —
 * so the only real question is whether the concrete name is written in
 * one file you can point at or in a habit spread through the tree.
 * `db/architecturalInvariants.test.ts` answers the same question
 * identically: one named file may write `items.stepId`, and the
 * exemption is what makes the rule enforceable rather than aspirational.
 *
 * The exemption is deliberately a *file*, not a directory. A directory
 * would grow.
 */
const COMPOSITION_ROOT = join(mainSrcRoot, "repositoryIntelligence", "composition.ts");

/**
 * Every module specifier in a file, however it was reached.
 *
 * Specifiers rather than occurrences of the word, which is the
 * distinction that makes this check worth having. A gate that stores
 * `"codewiki"` as the configured provider id, or a comment naming the
 * first implementation, is not a violation — those are data and prose.
 * Reaching the module is. The four spellings are the four ways to do
 * it: a named or default import, a side-effect import, a dynamic
 * import, and `require` for the one native-module case this codebase
 * still has.
 *
 * `export ... from` is covered by the `from` branch, which matters more
 * than it looks: re-exporting the implementation from a barrel outside
 * its directory would put it in reach of everyone while no file
 * appeared to import it.
 */
function moduleSpecifiers(source: string): string[] {
  const pattern = /\bfrom\s*["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']|\bimport\s+["']([^"']+)["']|\brequire\s*\(\s*["']([^"']+)["']/g;
  return [...source.matchAll(pattern)].flatMap((match) => match.slice(1).filter((specifier): specifier is string => specifier !== undefined));
}

/**
 * Every extension the main process runs code from.
 *
 * `.ts` is not the whole of it and never was: `mcp/eoServer.mjs` and
 * `modules/moduleHost.mjs` are both spawned as real Node processes, and
 * a scanner that only read TypeScript would have let either import the
 * implementation in full view of a passing test. The rest are here
 * pre-emptively — an invariant that has to be remembered when somebody
 * adds a `.cjs` is an invariant that will be forgotten.
 */
const MODULE_EXTENSIONS = new Set([".ts", ".mts", ".cts", ".js", ".mjs", ".cjs"]);

/**
 * The extensions that are data rather than code.
 *
 * Named so the completeness check below can tell "not scanned because
 * nothing executes it" from "not scanned because nobody updated the
 * list".
 *
 * `.snap` is a Vitest snapshot — what a test recorded, under
 * `__snapshots__/` beside it (`providers/claude.snapshot.test.ts` was
 * the first). Nothing executes it; a tool id in one would be the test's
 * own fixture, which the test file already contains.
 */
const DATA_EXTENSIONS = new Set([".sql", ".json", ".md", ".snap"]);

function walkFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkFiles(full));
    } else if (entry.isFile()) {
      files.push(full);
    }
  }
  return files;
}

function walkModuleFiles(dir: string): string[] {
  return walkFiles(dir).filter((file) => MODULE_EXTENSIONS.has(extname(file)));
}

/**
 * Whether a file is genuinely inside a directory, by path segments.
 *
 * `file.startsWith(dir)` is the obvious spelling and it is wrong in a
 * way this particular invariant makes easy to exploit: it compares
 * characters, so `repositoryIntelligence/codewikiCompat/consumer.ts`
 * starts with `repositoryIntelligence/codewiki` and would be waved
 * through as if it were the implementation itself. A sibling directory
 * whose name merely begins with the permitted one is outside the
 * permitted one, and creating it is not a thing anybody would have to
 * do on purpose to defeat the check.
 *
 * `relative()` answers in segments instead. A path that has to climb
 * out — `..` — or that resolves absolute is somewhere else, and the
 * empty string is the directory itself rather than a file in it.
 */
function isInside(dir: string, file: string): boolean {
  const path = relative(dir, file);
  return path !== "" && !path.startsWith("..") && !isAbsolute(path);
}

/**
 * Every file that reaches the implementation from outside its own
 * directory.
 *
 * Case-insensitive, because a specifier is a path and `CodeWiki/cli.js`
 * resolves on macOS and Windows while looking like a different word.
 */
function findImplementationImporters(root: string, implementationDir: string, exclude: string[] = []): string[] {
  return walkModuleFiles(root)
    .filter((file) => !isInside(implementationDir, file) && !exclude.includes(file))
    .filter((file) => moduleSpecifiers(readFileSync(file, "utf8")).some((specifier) => /codewiki/i.test(specifier)))
    .map((file) => relative(root, file));
}

describe("architectural invariant: only the implementation's own directory knows what the implementation is", () => {
  it("no file outside repositoryIntelligence/codewiki/ imports a CodeWiki module in the real source tree", () => {
    expect(findImplementationImporters(mainSrcRoot, IMPLEMENTATION_DIR, [THIS_FILE, COMPOSITION_ROOT])).toEqual([]);
  });

  /**
   * The exemption is worth exactly one file, and this is what stops it
   * being worth two.
   *
   * Without it, the way to add a second file that knows the
   * implementation is to add a second entry above — a one-line change
   * that reads like maintenance and quietly ends the invariant. Listing
   * the exempt file here means widening the rule has to be argued for
   * in the place the rule is written down.
   */
  it("exempts exactly one production file, and it is the composition root", () => {
    const exempt = findImplementationImporters(mainSrcRoot, IMPLEMENTATION_DIR, [THIS_FILE]);
    expect(exempt).toEqual([relative(mainSrcRoot, COMPOSITION_ROOT)]);
  });

  /**
   * The scan reached the source tree at all.
   *
   * Without this, pointing `mainSrcRoot` at a directory that no longer
   * exists — a move, a rename, a build layout change — turns the check
   * above into a test that scans nothing and passes forever. That is
   * the one failure mode an invariant test must not have, and it is
   * cheaper to assert than to notice.
   */
  /**
   * The second way an implementation reaches an agent, and the one
   * EO-165 opened (EO-165).
   *
   * Every rule above is about *importing* the implementation. This is
   * about naming its tools, which is a different leak with the same
   * consequence: an interception that answers a broad `grep -rn` has to
   * name the call that would answer it — "use the index" is the advice
   * EO-164 measured as inert — and the calls are CodeWiki's. Spelled in
   * an adapter, they would be an agent trained on one provider's
   * vocabulary, which is precisely what the port exists to prevent, and
   * no import scan would ever have noticed.
   *
   * So the words leave through the port as data, the way
   * `CODEWIKI_INDEX_DIRECTORY` does, and this is what keeps the spelling
   * to the directory entitled to it. Distinct from the rule above rather
   * than a widening of it: that one is about `from "…/codewiki/…"`, and
   * the string `"codewiki"` on its own is still data and still allowed.
   */
  it("no file outside repositoryIntelligence/codewiki/ spells one of the implementation's tool ids", () => {
    const offenders = walkModuleFiles(mainSrcRoot)
      .filter((file) => !isInside(IMPLEMENTATION_DIR, file) && file !== THIS_FILE)
      // Case-sensitive, and that is the distinction rather than an
      // oversight: `codewiki_search` is a tool id a model is told to
      // call, and `CODEWIKI_INDEX_DIRECTORY` is a constant the
      // composition root is entitled to name. Only the first is the
      // agent-facing coupling this rule is about.
      .filter((file) => /\bcodewiki_[a-z]/.test(readFileSync(file, "utf8")))
      .map((file) => relative(mainSrcRoot, file));

    expect(offenders).toEqual([]);
  });

  /**
   * Non-vacuous: the tool ids exist, inside the one directory allowed to
   * say them. Without this the check above passes just as well on the
   * day somebody deletes the vocabulary entirely.
   */
  it("finds them where they are allowed to be", () => {
    const inside = walkModuleFiles(IMPLEMENTATION_DIR).filter((file) => /\bcodewiki_[a-z]/.test(readFileSync(file, "utf8")));

    expect(inside.length).toBeGreaterThan(0);
  });

  it("scans the main process source tree, not an empty directory", () => {
    expect(walkModuleFiles(mainSrcRoot).length).toBeGreaterThan(50);
  });

  /**
   * The extension list keeps up with the tree on its own.
   *
   * This is the general form of a real gap: the scanner read `.ts` only
   * while `mcp/eoServer.mjs` and `modules/moduleHost.mjs` sat in the
   * same tree being spawned as Node processes, so a CodeWiki import in
   * either was invisible to a passing test. Asserting "we also read
   * `.mjs`" would fix that one instance and nothing else. Asserting
   * that *every* extension in the tree is either scanned or knowingly
   * data means the day somebody adds the first `.cjs` to the main
   * process, this fails and says so.
   */
  it("knows about every kind of file the main process actually contains", () => {
    const unaccounted = walkFiles(mainSrcRoot)
      .map((file) => extname(file))
      .filter((extension) => extension !== "" && !MODULE_EXTENSIONS.has(extension) && !DATA_EXTENSIONS.has(extension));

    expect([...new Set(unaccounted)].sort()).toEqual([]);
  });

  it("the scanner catches every way in, and allows what is not a way in (proves it's not a tautology)", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "eo-repo-intelligence-invariant-"));
    try {
      const implementationDir = join(tempDir, "repositoryIntelligence", "codewiki");
      mkdirSync(implementationDir, { recursive: true });

      // The four ways to reach a module, all of them from outside.
      writeFileSync(join(tempDir, "named.ts"), 'import { indexRepository } from "./repositoryIntelligence/codewiki/cli.js";');
      writeFileSync(join(tempDir, "sideEffect.ts"), 'import "./repositoryIntelligence/codewiki/register.js";');
      writeFileSync(join(tempDir, "dynamic.ts"), 'const mod = await import("./repositoryIntelligence/codewiki/provider.js");');
      writeFileSync(join(tempDir, "required.ts"), 'const cw = require("./repositoryIntelligence/codewiki/binary.js");');
      // A barrel that re-exports it puts it in everyone's reach while
      // importing nothing, so it counts too.
      writeFileSync(join(tempDir, "barrel.ts"), 'export { createProvider } from "./repositoryIntelligence/codewiki/provider.js";');
      // Spelled the way a case-insensitive filesystem would still resolve.
      writeFileSync(join(tempDir, "shouted.ts"), 'import x from "./repositoryIntelligence/CodeWiki/cli.js";');
      // Not TypeScript, and every bit as executable: the main process
      // spawns `.mjs` files as real Node processes.
      writeFileSync(join(tempDir, "spawned.mjs"), 'import { run } from "./repositoryIntelligence/codewiki/cli.mjs";');
      // Data that happens to say the word. Nothing executes a migration,
      // so nothing here is a way in.
      writeFileSync(join(tempDir, "0057_codewiki.sql"), "-- import from codewiki/cli.js\nCREATE TABLE x (id text);");

      // A sibling whose name merely begins with the permitted one. It is
      // outside the permitted directory and gets no exemption — the
      // whole reason containment is checked by segment rather than by
      // string prefix.
      const lookalikeDir = join(tempDir, "repositoryIntelligence", "codewikiCompat");
      mkdirSync(lookalikeDir, { recursive: true });
      writeFileSync(join(lookalikeDir, "consumer.ts"), 'import { run } from "../codewiki/cli.js";');

      // Inside the implementation's own directory, importing itself and
      // its tool: exactly what the directory is for.
      writeFileSync(join(implementationDir, "provider.ts"), 'import { run } from "./codewikiCli.js";\nimport type { RepositoryIndexTarget } from "../port.js";');
      // Deeper inside it, too — containment is about the directory, not
      // about being an immediate child of it.
      mkdirSync(join(implementationDir, "internal"), { recursive: true });
      writeFileSync(join(implementationDir, "internal", "hooks.ts"), 'import { spawn } from "../codewikiCli.js";');
      // Ordinary code that talks to the port, which is the whole point.
      writeFileSync(join(tempDir, "innocent.ts"), 'import { createRepositoryIntelligenceService } from "./repositoryIntelligence/index.js";');
      // Naming the implementation is not reaching for it: a configured
      // provider id is data, and a comment is prose. Flagging either
      // would make the check fire on files that are behaving, which is
      // how a check gets ignored.
      writeFileSync(join(tempDir, "gate.ts"), '// The first implementation is CodeWiki (EO-141).\nconst configured = "codewiki";\n');

      const offenders = findImplementationImporters(tempDir, implementationDir);

      expect(offenders.sort()).toEqual(
        [
          "barrel.ts",
          "dynamic.ts",
          "named.ts",
          join("repositoryIntelligence", "codewikiCompat", "consumer.ts"),
          "required.ts",
          "shouted.ts",
          "sideEffect.ts",
          "spawned.mjs",
        ].sort(),
      );
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

/**
 * The other half of the same rule, and the half a scanner of imports
 * cannot see.
 *
 * The port may not *name* the implementation either — not in a type,
 * not in a method, not in a comment. A reviewer has to be able to read
 * `port.ts` end to end without learning what is underneath it, because
 * the moment the interface explains itself in terms of one tool, the
 * next tool has to pretend to be that one.
 *
 * Scoped to `port.ts` alone, deliberately. Elsewhere in this directory
 * naming the configured implementation is legitimate — a gate has to
 * store an id somewhere — and a rule that forbade the word everywhere
 * would be one that later work has to argue its way around.
 */
describe("architectural invariant: the port does not know what is underneath it", () => {
  it("port.ts contains no mention of the implementation, in any form", () => {
    expect(readFileSync(join(here, "port.ts"), "utf8")).not.toMatch(/codewiki/i);
  });
});

/**
 * The same rule one level down, and the half this file used to miss
 * (EO-163).
 *
 * The scan above is a check on *shape*: it fails when a file outside the
 * implementation's directory reaches for a module inside it. A
 * provider-specific **value** copied into the shared layer trips none of
 * it — and that is not hypothetical, it is what was found. The directory
 * the implementation writes its index into lived here as
 * `REPOSITORY_INDEX_DIR = ".codewiki"`, in the module whose whole job is
 * to be implementation-agnostic, re-exported under a neutral name and
 * imported by two checks that were careful never to write the literal
 * themselves. Every import in that chain was legal. The one string only
 * one implementation could supply had still been laundered upward, and a
 * second provider would have had to come and edit it.
 *
 * So the same assertion `port.ts` already gets, on the other file that
 * has to be readable end to end without learning what is underneath it.
 * Scoped to that file rather than swept across the tree deliberately: a
 * tree-wide scan for provider-shaped values would fire on `binary/`,
 * which is a catalogue of one implementation's release assets sitting
 * outside the implementation's directory. That is a real observation and
 * a different change from this one; pretending otherwise by exempting a
 * directory here would leave a rule that grows an exemption every time
 * it is inconvenient.
 */
describe("architectural invariant: a provider's answers do not live above it either", () => {
  it("the module that decides what an index is on disk names no implementation, in any form", () => {
    expect(readFileSync(join(here, "indexPaths.ts"), "utf8")).not.toMatch(/codewiki/i);
  });

  /**
   * And it still decides something.
   *
   * A file that had stopped naming the implementation because it had
   * stopped doing anything would pass the assertion above while the
   * checks it stands for quietly went missing.
   */
  it("still answers what an index is, from what the composition root collected", () => {
    const source = readFileSync(join(here, "indexPaths.ts"), "utf8");

    expect(source).toContain("REPOSITORY_INDEX_DIRECTORIES");
    expect(source).toContain("export function isRepositoryIndexPath");
    expect(source).toContain("export function withoutRepositoryIndex");
  });
});
