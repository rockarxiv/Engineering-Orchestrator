import { describe, expect, it } from "vitest";
import { portabilityWarnings } from "./portability.js";

/**
 * The half of the old import check that stayed a text scan (EO-80).
 *
 * Two questions used to be answered by one set of patterns. What a
 * module may *reach* is now asked of the loader in `moduleHost.mjs`,
 * exactly — `runModule.test.ts` covers that end to end. What is left
 * here is the other one: would this module survive being exported to
 * another machine? That question genuinely wants to be static, because
 * the answer it exists for is a dynamic `import()` down a branch nobody
 * has taken yet, which no run and no loader hook will ever surface.
 *
 * So these assert two things together: that it finds what an author
 * needs to know, and that it is still allowed to be wrong in the cheap
 * direction. A test pinning the false positives is not an accident being
 * ratified — it is the trade being written down, so that anyone who
 * later "fixes" one has to decide, on purpose, to trade this noise for
 * the silence the scan exists to prevent.
 */
describe("portability advice", () => {
  it("says nothing about a module that imports nothing", () => {
    expect(portabilityWarnings(`export default async function run(ctx) { return { ok: true, result: "ok" }; }`)).toEqual([]);
  });

  it("says nothing about node: builtins", () => {
    const code = ['import { sep } from "node:path";', 'import "node:os";', 'export { x } from "node:util";', 'export default async () => import("node:fs");'].join("\n");
    expect(portabilityWarnings(code)).toEqual([]);
  });

  // A subpath of a permitted builtin is a permitted builtin. Weighing
  // the whole string against a list that only held the roots would have
  // reported every one of these as unportable.
  it("says nothing about a builtin reached through a subpath", () => {
    const code = ['import { readFile } from "node:fs/promises";', 'import "node:stream/web";', 'import { setTimeout as wait } from "node:timers/promises";'].join("\n");
    expect(portabilityWarnings(code)).toEqual([]);
  });

  /**
   * Spelled like a builtin, and not one (EO-80 review).
   *
   * The prefix was the whole test, so anything beginning `node:` was
   * described to its author as fine. Nothing resolves this — the loader
   * refuses it and the run never starts — so advice that said nothing
   * about it was advice agreeing with a prefix rather than with Node.
   */
  it("names a node: specifier that is not a builtin at all", () => {
    const code = ['import { thing } from "node:does-not-exist";', "export default async function run() {}"].join("\n");
    expect(portabilityWarnings(code)).toContainEqual({ specifier: "node:does-not-exist", line: 1 });
  });

  // Electron's own builtin, which resolves in EO's host and on no other
  // machine. Exactly the thing this scan is for, and the reason the host
  // asking the runtime is not enough on its own.
  it("names a builtin only EO's own runtime has", () => {
    expect(portabilityWarnings(`import "node:original-fs";\nexport default async function run() {}`)).toContainEqual({ specifier: "node:original-fs", line: 1 });
  });

  it("names a package and the line it is on", () => {
    const code = ["// a comment", 'import fetch from "node-fetch";', "export default async function run() {}"].join("\n");
    expect(portabilityWarnings(code)).toEqual([{ specifier: "node-fetch", line: 2 }]);
  });

  it("names a side-effect import", () => {
    expect(portabilityWarnings(`import "dotenv/config";\nexport default async function run() {}`)).toContainEqual({ specifier: "dotenv/config", line: 1 });
  });

  it("names a re-export", () => {
    expect(portabilityWarnings(`export { helper } from "some-package";\nexport default async function run() {}`)).toContainEqual({ specifier: "some-package", line: 1 });
  });

  /**
   * The case this scan exists for, and the reason it is not the loader's
   * job.
   *
   * The module deploys perfectly in front of the person approving it,
   * because that run never takes the failure branch. The loader is never
   * asked about `node-fetch`, so it never refuses it. Nothing but a read
   * of the text says this module will not work on somebody else's
   * machine — and by then it is a step that parks an item.
   */
  it("names an import down a branch a run need not take", () => {
    const code = [
      "export default async function run(ctx) {",
      '  const built = await ctx.exec("pnpm", ["build"]);',
      "  if (built.code !== 0) {",
      '    const { notify } = await import("node-fetch");',
      "    await notify();",
      "  }",
      '  return { ok: true, result: "deployed" };',
      "}",
    ].join("\n");
    expect(portabilityWarnings(code)).toContainEqual({ specifier: "node-fetch", line: 4 });
  });

  // A specifier assembled at run time is unreadable by construction, so
  // the advice names the shape rather than pretending to a package name.
  it("reports a specifier the module builds for itself", () => {
    const code = ["export default async function run() {", '  const half = "node-";', '  await import(half + "fetch");', "}"].join("\n");
    expect(portabilityWarnings(code)).toEqual([{ specifier: "a specifier built while the module runs", line: 3 }]);
  });

  // `startsWith("node:")` reads these as ordinary builtins, and they are
  // not: `module` reaches `createRequire`, which loads npm packages from
  // the worktree and ends portability outright.
  it.each(["node:child_process", "node:module", "node:worker_threads", "node:vm"])("names %s, which is a builtin a module may not have", (specifier) => {
    expect(portabilityWarnings(`import * as m from "${specifier}";\nexport default async function run() {}`)).toContainEqual({ specifier, line: 1 });
  });

  // A subpath is the same builtin wearing a different name. Matched on
  // the whole string, `node:inspector` was withheld and its promises
  // half was not.
  it("names a withheld builtin reached through its subpath", () => {
    const code = 'import { Session } from "node:inspector/promises";\nexport default async function run() {}';
    expect(portabilityWarnings(code)).toContainEqual({ specifier: "node:inspector/promises", line: 1 });
  });

  // A comment is whitespace to the tokenizer and not to `\s`, so an
  // import written this way once slid past the patterns entirely.
  it("sees an import with a block comment inside it", () => {
    expect(portabilityWarnings(`import/*x*/{ a } from "node-fetch";\nexport default async function run() {}`)).toContainEqual({ specifier: "node-fetch", line: 1 });
  });

  /**
   * The false positive that refused a production run, kept — and now
   * harmless.
   *
   * `[\s\S]+?` spans any distance and any content and every module
   * contains `export default`, so the first quoted phrase after the word
   * `from` anywhere in the rest of the file is read as a package name.
   * This module imports nothing whatsoever.
   *
   * As enforcement that cost a deploy. As advice it costs a rewritten
   * sentence, which is why the patterns were left alone rather than
   * narrowed: a pattern careful enough never to misread prose is careful
   * enough to miss the branch case above.
   */
  it("still misreads a sentence, which is the price of the shapes it does catch", () => {
    const code = [
      "/**",
      " * Tags the release.",
      " *",
      ' * One important detail: it differs from "CI is unhappy" in that it',
      " * does not reach for anything at all.",
      " */",
      'export default async function run() { return { ok: true, result: "ok" }; }',
    ].join("\n");
    expect(portabilityWarnings(code)).toContainEqual({ specifier: "CI is unhappy", line: 4 });
  });

  it("does not report the same specifier on the same line twice", () => {
    const warnings = portabilityWarnings(`import fetch from "node-fetch";\nexport default async function run() {}`);
    expect(warnings.filter((warning) => warning.specifier === "node-fetch")).toHaveLength(1);
  });

  it("reports in the order an author reads the file", () => {
    const code = ['import a from "alpha";', "", 'import b from "beta";'].join("\n");
    expect(portabilityWarnings(code).map((warning) => warning.line)).toEqual([1, 3]);
  });
});
