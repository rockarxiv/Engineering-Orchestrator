import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { killTree } from "./process/killTree.js";
import { runCommand } from "./process/runCommand.js";
import type { SecretStore } from "./secrets/store.js";
import { createClaudeProvider, type ClaudeProviderOptions, type SearchNudge } from "./providers/claude.js";
import { createCodexProvider, type CodexProviderOptions } from "./providers/codex.js";

const THIS_FILE = fileURLToPath(import.meta.url);
const mainSrcRoot = dirname(THIS_FILE);
/** The repository, so the scan can reach `scripts/` and the rest of `apps/desktop/src`. */
const repoRoot = join(mainSrcRoot, "..", "..", "..", "..");

/**
 * The three things the core used to reach into the developer directories
 * for, now lifted out of them (KAN-126, ARCHITECTURE.md, "The package layout").
 *
 * `jira/`, `workspace/`, `forge/` and `repositoryIntelligence/` become
 * the developer pack in the fourth story of this phase. Before they can
 * move, nothing in the core may import from them — and three things
 * did: the secret store was declared in `jira/credentials.ts` and used
 * by the runtimes, the module host and the MCP host; the process-kill
 * helper was in `workspace/runCommand.ts` and used by the module host;
 * and the Claude adapter imported the search nudge from
 * `repositoryIntelligence/broadSearch.ts`.
 *
 * Two halves. The first says where each name lives now, so that a
 * future move is a deliberate edit to this file rather than a drift.
 * The second scans the tree: every code file outside the four
 * directories — tests and scripts included, because the acceptance
 * criterion says *file* and a test that imports the classifier into
 * the adapter's own suite is exactly the coupling the criterion is
 * about — and none of them imports one of the three names from inside.
 * A test that needs the shipped classifier through the adapter lives
 * on the pack's side (`repositoryIntelligence/claudeInterception.test.ts`,
 * `repositoryIntelligence/claudePrompt.snapshot.test.ts`); a test of
 * the adapter itself uses a stand-in.
 *
 * One named exception, the one the story mandates — see `ALLOWED`.
 * There was briefly a second, for `scripts/index-adoption-trial.mjs`;
 * review was right that an allowlist here cannot waive an acceptance
 * criterion, and the script's dependency is gone rather than excused.
 */
const PACK_DIRECTORIES = ["jira", "workspace", "forge", "repositoryIntelligence"] as const;

/**
 * Where those four directories live now (KAN-144).
 *
 * They moved into the developer pack in the story after this one, which
 * is what KAN-126 lifted the three names out of them *for*. The scan
 * below is unchanged in what it asserts: the specifier test still keys
 * on the directory names, because `packs/developer/workspace/git.js`
 * contains `/workspace/` just as `workspace/git.js` did, and a file that
 * reaches one of them from outside is the same offence wherever the
 * directory sits.
 */
const PACK_ROOT = join("packs", "developer");

/**
 * Files that may still import a lifted name from the pack directories,
 * by repository-relative path, and why. Each entry is a debt with a
 * story on it, and a test below fails the day an entry stops being
 * needed.
 *
 * This list is not a place to park a file that is merely inconvenient
 * to fix: the acceptance criterion admits exactly one exception, which
 * is the one the story's own scope writes down. Anything else belongs
 * in a human's decision, not here.
 */
const ALLOWED: Record<string, string> = {
  // **Scope-mandated.** The story says in as many words that the
  // composition root supplies the nudge until the developer pack does,
  // so that behaviour is unchanged before the pack exists. KAN-144
  // moves it and this entry goes.
  // **The composition root.** KAN-144 moved `repositoryIntelligence/`
  // into the developer pack, and `engine.ts` is the one file allowed to
  // reach into it — it is where the pack is folded into the supervisor's
  // options, and the Claude adapter's `searchNudge` is handed over from
  // the same place for the same reason — and the Codex adapter's, which
  // takes the same function (EO-379). The pack's own import allowlist
  // (KAN-177) records it; this entry says why it is not an offence
  // against *this* story's rule either.
  "apps/desktop/src/main/engine.ts": "the composition root folds the developer pack in, and hands the Claude and Codex adapters the pack's search nudge (KAN-144, EO-379)",
};

/** The three names, as they are imported. */
const LIFTED = ["SecretStore", "killTree", "repositorySearchNudge"] as const;

/** Everything that can hold an import statement: source, tests, scripts. */
const CODE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs"];

function codeFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "out") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...codeFiles(full));
    else if (entry.isFile() && CODE_EXTENSIONS.some((extension) => entry.name.endsWith(extension)) && !entry.name.endsWith(".d.ts")) files.push(full);
  }
  return files;
}

/** Does this specifier reach into one of the pack directories, from anywhere? */
function reachesPack(specifier: string): boolean {
  return PACK_DIRECTORIES.some((directory) => new RegExp(`(?:^|/)${directory}/`).test(specifier));
}

/**
 * Every static import in a source, as the names it binds and where
 * from. Namespace imports bind everything, so they count as importing
 * every name.
 */
function imports(source: string): { names: string[]; specifier: string }[] {
  const found: { names: string[]; specifier: string }[] = [];
  const statement = /import\s+(?:type\s+)?(?:(\*\s+as\s+\w+)|(\w+)?\s*,?\s*(?:\{([^}]*)\})?)\s*from\s*["']([^"']+)["']/g;
  for (const match of source.matchAll(statement)) {
    const [, namespace, defaultName, named, specifier] = match;
    if (specifier === undefined) continue;
    const names = namespace
      ? [...LIFTED]
      : [
          ...(defaultName ? [defaultName] : []),
          ...(named ?? "")
            .split(",")
            .map((entry) => entry.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0]?.trim() ?? "")
            .filter((entry) => entry !== ""),
        ];
    found.push({ names, specifier });
  }
  return found;
}

/** The lifted names this file imports from a pack directory, if any. */
function liftedImportsFromPack(source: string): string[] {
  return imports(source)
    .filter(({ specifier }) => reachesPack(specifier))
    .flatMap(({ names }) => names.filter((name): name is (typeof LIFTED)[number] => (LIFTED as readonly string[]).includes(name)));
}

describe("the lifted utilities live where the core can import them", () => {
  it("SecretStore is declared in secrets/store.ts and nowhere in jira/", () => {
    // A type is erased at runtime, so its home is asserted on the source:
    // the declaration is here, and the file it came from now imports it
    // rather than declaring it.
    expect(readFileSync(join(mainSrcRoot, "secrets", "store.ts"), "utf8")).toMatch(/export interface SecretStore\b/);
    const credentials = readFileSync(join(mainSrcRoot, PACK_ROOT, "jira", "credentials.ts"), "utf8");
    expect(credentials).not.toMatch(/export interface SecretStore\b/);
    expect(credentials).toMatch(/import type \{ SecretStore \} from "(?:\.\.\/){3}secrets\/store\.js"/);
    // And the type is usable from its new home, which is what the
    // runtimes, the module host and the MCP host need of it.
    const store: SecretStore = {
      isEncryptionAvailable: () => true,
      encryptString: (plain) => Buffer.from(plain),
      decryptString: (encrypted) => encrypted.toString(),
    };
    expect(store.decryptString(store.encryptString("x"))).toBe("x");
  });

  it("killTree and runCommand are exported from process/, and workspace/runCommand.ts is gone", () => {
    expect(typeof killTree).toBe("function");
    expect(typeof runCommand).toBe("function");
    expect(existsSync(join(mainSrcRoot, PACK_ROOT, "workspace", "runCommand.ts"))).toBe(false);
    // The one implementation, in one place: nothing under workspace/
    // declares its own.
    for (const file of codeFiles(join(mainSrcRoot, PACK_ROOT, "workspace"))) {
      expect(readFileSync(file, "utf8"), relative(mainSrcRoot, file)).not.toMatch(/function killTree\b/);
    }
  });

  it("the search nudge is a Claude provider option, and the adapter imports nothing from repositoryIntelligence/", () => {
    // The option exists and takes the shape the pack's nudge has.
    const nudge: SearchNudge = async () => null;
    const options: ClaudeProviderOptions = { searchNudge: nudge };
    expect(typeof createClaudeProvider(options).start).toBe("function");
    // And the adapter no longer reaches for the judgement itself.
    const adapter = readFileSync(join(mainSrcRoot, "providers", "claude.ts"), "utf8");
    expect(imports(adapter).filter(({ specifier }) => reachesPack(specifier))).toEqual([]);
  });

  it("the Codex provider takes the same nudge, and neither it nor what it delivers through decides anything (EO-379)", () => {
    // One option type for both backends, so one function serves both.
    const nudge: SearchNudge = async () => null;
    const options: CodexProviderOptions = { searchNudge: nudge };
    expect(typeof createCodexProvider(options).start).toBe("function");
    // The adapter and its listener reach for no judgement of their own.
    for (const file of ["codex.ts", "codexSearchHook.ts", "searchNudge.ts"]) {
      const source = readFileSync(join(mainSrcRoot, "providers", file), "utf8");
      expect(imports(source).filter(({ specifier }) => reachesPack(specifier)), file).toEqual([]);
    }
    // And the command Codex runs is a courier: it imports one module, to
    // post with, and never looks at the call it is carrying. A second
    // classifier would have to read one of these to exist.
    const command = readFileSync(join(mainSrcRoot, "providers", "codexSearchHookCommand.mjs"), "utf8");
    const code = command
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("//"))
      .join("\n");
    expect([...code.matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1])).toEqual(["node:http"]);
    for (const field of ["tool_name", "tool_input", "command", "grep", "JSON.parse"]) expect(code, field).not.toContain(field);
  });
});

describe("architectural invariant: nothing outside the pack directories imports a lifted name from them", () => {
  /**
   * Every code file in the desktop app and under `scripts/`, tests
   * included, outside the four directories — and not this file, whose
   * own fixtures below are import statements written out as strings.
   * The same exemption the three scans in `repositoryIntelligence/`
   * take, for the same reason: a check that catches itself is a check
   * nobody can make pass.
   */
  const outsidePack = [...codeFiles(join(repoRoot, "apps", "desktop", "src")), ...codeFiles(join(repoRoot, "scripts"))]
    .filter((file) => file !== THIS_FILE)
    .filter((file) => !PACK_DIRECTORIES.some((directory) => file.startsWith(join(mainSrcRoot, PACK_ROOT, directory) + sep)))
    .map((file) => relative(repoRoot, file).split(sep).join("/"));

  it("scans the tree it claims to: tests, scripts and the main process are all in it", () => {
    expect(outsidePack).toContain("apps/desktop/src/main/providers/claude.test.ts");
    expect(outsidePack).toContain("apps/desktop/src/main/providers/claudeHook.live.test.ts");
    expect(outsidePack).toContain("apps/desktop/src/main/modules/runModule.ts");
    expect(outsidePack).toContain("scripts/index-adoption-trial.mjs");
    expect(outsidePack).not.toContain("apps/desktop/src/main/packs/developer/repositoryIntelligence/claudeInterception.test.ts");
    // And not this file: its fixtures are import statements as strings.
    expect(outsidePack).not.toContain("apps/desktop/src/main/liftedFromPack.test.ts");
  });

  it("no file outside jira/, workspace/, forge/ or repositoryIntelligence/ imports one, beyond the named exceptions", () => {
    const offenders = outsidePack
      .filter((file) => !(file in ALLOWED))
      .flatMap((file) => liftedImportsFromPack(readFileSync(join(repoRoot, file), "utf8")).map((name) => `${file}: ${name}`));
    expect(offenders).toEqual([]);
  });

  it("every allowed exception still needs allowing, so the list shrinks rather than lingers", () => {
    for (const [file, reason] of Object.entries(ALLOWED)) {
      expect(liftedImportsFromPack(readFileSync(join(repoRoot, file), "utf8")), `${file} is allowed (${reason}) but no longer needs to be`).not.toEqual([]);
    }
  });

  it("the scan reads every import form and ignores a mention (proves it is not a tautology)", () => {
    expect(liftedImportsFromPack('import type { SecretStore } from "../jira/credentials.js";')).toEqual(["SecretStore"]);
    expect(liftedImportsFromPack('import { storeToken, type SecretStore } from "./packs/developer/jira/credentials.js";')).toEqual(["SecretStore"]);
    expect(liftedImportsFromPack('import { killTree } from "../../workspace/runCommand.js";')).toEqual(["killTree"]);
    expect(liftedImportsFromPack('import { repositorySearchNudge } from "../repositoryIntelligence/broadSearch.js";')).toEqual(["repositorySearchNudge"]);
    expect(liftedImportsFromPack('import {\n  repositoryQueryServerFor,\n  repositorySearchNudge,\n} from "./packs/developer/repositoryIntelligence/index.js";')).toEqual(["repositorySearchNudge"]);
    expect(liftedImportsFromPack('import * as jira from "../jira/credentials.js";')).toEqual([...LIFTED]);
    expect(liftedImportsFromPack('import { repositorySearchNudge } from "../apps/desktop/src/main/repositoryIntelligence/broadSearch.js";')).toEqual(["repositorySearchNudge"]);
    // Not offences: the new homes, an unrelated name from a pack
    // directory, and prose that only mentions the old one.
    expect(liftedImportsFromPack('import type { SecretStore } from "../secrets/store.js";')).toEqual([]);
    expect(liftedImportsFromPack('import { killTree } from "../process/killTree.js";')).toEqual([]);
    expect(liftedImportsFromPack('import { git } from "../workspace/git.js";')).toEqual([]);
    expect(liftedImportsFromPack("// `killTree` used to live in `workspace/runCommand.ts`")).toEqual([]);
  });
});
