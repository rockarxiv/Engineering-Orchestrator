import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * That the registry is the only reader of the developer constants
 * (KAN-124).
 *
 * `BUILTIN_ROLES`, `BUILTIN_ACTIONS`, `BUILTIN_RESULTS`,
 * `BUILTIN_SIDE_EFFECTS` and `SCHEMAS_BY_ACTION` stay exported from `packages/core`, because the
 * main process still types its runners and its prompt files on them and
 * because they are what the developer pack will contribute (KAN-144).
 * What this story changes is who is allowed to *read* them: inside the
 * two pure packages, nothing but the module that turns them into a
 * registry; in the renderer, nothing at all, since it is handed the
 * registry over `registry:get`. A lookup that reached for one directly
 * would answer for the developer pack whatever packs were installed —
 * the closed-set problem wearing a registry's clothes — and nothing at
 * the type level would notice.
 *
 * Here rather than beside the registry because `packages/core` forbids
 * `node:*` even in its tests, and this is a sweep over source text — the
 * way `reachable.test.ts` reads the renderer, because the failure is a
 * line somebody writes rather than anything that fails to link.
 * Comments are stripped first: a pointer saying "this moved to
 * `BUILTIN_ROLES`" is exactly what the files that used to hold them
 * should say.
 */
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..", "..");
const coreSrc = join(repoRoot, "packages", "core", "src");
const engineSrc = join(repoRoot, "packages", "engine", "src");
const rendererSrc = join(here, "..", "renderer", "src");
const registryModule = join(coreSrc, "registry");

const CONSTANTS = ["BUILTIN_ROLES", "BUILTIN_ACTIONS", "BUILTIN_RESULTS", "BUILTIN_SIDE_EFFECTS", "SCHEMAS_BY_ACTION"] as const;

function sourceFilesUnder(root: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root)) {
    const path = join(root, entry);
    if (statSync(path).isDirectory()) {
      files.push(...sourceFilesUnder(path));
      continue;
    }
    if (/\.tsx?$/.test(entry)) files.push(path);
  }
  return files;
}

/** The file with every comment removed, so a mention in prose is not a read. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

function readersOf(constant: string, files: string[]): string[] {
  const identifier = new RegExp(`\\b${constant}\\b`);
  return files.filter((file) => identifier.test(withoutComments(readFileSync(file, "utf8")))).map((file) => relative(repoRoot, file));
}

describe("the developer constants", () => {
  const pureOutsideTheRegistry = [...sourceFilesUnder(coreSrc), ...sourceFilesUnder(engineSrc)].filter((file) => !file.startsWith(registryModule));
  const renderer = sourceFilesUnder(rendererSrc);

  it.each(CONSTANTS)("%s is read by nothing in core or engine outside the registry module", (constant) => {
    // If this names a file you have added a direct read. Take the value
    // from the registry instead — `registry.builtins`, `registry.roles`,
    // `schemaByAction` — and pass the registry in from whoever has it.
    expect(readersOf(constant, pureOutsideTheRegistry)).toEqual([]);
  });

  it.each(CONSTANTS)("%s is read by no renderer file, which has registry:get instead", (constant) => {
    expect(readersOf(constant, renderer)).toEqual([]);
  });

  it("are still read by the registry module, so the checks above are known to be able to fail", () => {
    const insideTheRegistry = sourceFilesUnder(registryModule);
    for (const constant of CONSTANTS) expect(readersOf(constant, insideTheRegistry), constant).not.toEqual([]);
  });
});
