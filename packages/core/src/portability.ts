/**
 * Whether a module would survive being exported to another machine
 * (EO-80).
 *
 * ## Why this is still a text scan
 *
 * `moduleHost.mjs` used to answer two questions with one set of regular
 * expressions over a module's source, and conflating them is what made
 * its conservatism so expensive.
 *
 * The first is *enforcement*: stop this module reaching a package. That
 * has an exact answer and now gets one — the loader hook in
 * `moduleHost.mjs` sees every specifier the real ESM loader resolves, so
 * prose is never mistaken for a statement and no way of writing an
 * import is a way past.
 *
 * The second is this: warn an author that a module is not portable. That
 * genuinely wants to be static, and the loader cannot do it. The point
 * is to know about a dynamic `import()` sitting in a branch nobody has
 * taken yet — a module that deploys fine for a month and then, on the
 * one failure path that reaches for `node-fetch`, does not. A hook only
 * ever sees the branches that were taken; a module's tests only prove
 * the branches they reach. Reading the text is the only way to hear about the
 * rest of the file.
 *
 * ## So it is allowed to be over-eager
 *
 * These patterns are the ones that misread a docstring — `[\s\S]+?`
 * spans any distance and any content, and every module contains
 * `export default`, so a comment saying one thing differed `from` a
 * quoted phrase looked exactly like an import of a package called "CI is
 * unhappy". Kept as they are, deliberately. Split from enforcement,
 * being wrong in this direction costs an author a rewritten sentence
 * while they are writing or approving; it was only ever expensive
 * because it also refused production runs. Tightening them would trade
 * that cheap noise for the expensive silence this scan exists to
 * prevent — a shape a narrower pattern did not anticipate, unreported.
 *
 * Advice, never a gate. Nothing here refuses a save, an approval or a
 * run: the loader decides what a module may reach, and this only tells
 * somebody what it looks like it will.
 *
 * ## Why it lives in `core` rather than beside the host
 *
 * Two places read it and they read different code. The main process
 * scans what is *saved*, so a module card and the architect's approval
 * card can say the same thing without either asking for it; the module
 * editor scans the draft in the textarea, because an author who only
 * hears this after saving hears it one screen too late — and the draft
 * exists nowhere but the renderer. One copy, imported by both, for the
 * same reason `ModuleManifestSchema` is: two readings of the same text
 * that could disagree are worse than either.
 */

import type { PortabilityWarning } from "./schemas/modules.js";

/**
 * `import ... from "x"`, `import "x"`, `export ... from "x"`, `import("x")`.
 *
 * `[\s\S]` rather than `\s` after the keyword: a comment is whitespace to
 * the tokenizer and not to `\s`, so an import with a block comment
 * between the keyword and the braces slid past a `\s`-anchored pattern
 * entirely.
 */
const PATTERNS = [
  /\bimport[\s\S]+?\bfrom\s*["']([^"']+)["']/g,
  /\bimport\s*["']([^"']+)["']/g,
  /\bexport[\s\S]+?\bfrom\s*["']([^"']+)["']/g,
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
];

/**
 * Builtins a module may not have, restated here rather than imported.
 *
 * `moduleHost.mjs` is a `.mjs` launched as a subprocess and deliberately
 * not bundled — importing it from the main process is what would make
 * Rollup try. The list is small, and the two copies answer different
 * questions: that one decides, this one describes.
 */
const BLOCKED_BUILTINS = new Set(["node:child_process", "node:module", "node:worker_threads", "node:vm", "node:v8", "node:inspector", "node:repl"]);

/**
 * The builtins Node itself ships, as Electron 45's Node 24 has them.
 *
 * Here so that `node:does-not-exist` stops being read as a builtin on
 * the strength of how it is spelled. It is not one — the loader refuses
 * it and the run never starts — and this scan calling it fine was the
 * advice agreeing with a prefix rather than with Node.
 *
 * A written list rather than `node:module`'s `isBuiltin`, because this
 * file is bundled into the renderer: the module editor scans the draft
 * in the textarea on every keystroke, and there is no Node there to ask.
 * The host, which decides, does ask — so the exact answer is used
 * exactly where exactness is what matters.
 *
 * Which means this can go stale, and it is worth being clear about which
 * way. A builtin a later Node adds is described here as unportable until
 * somebody adds it: over-eager, the cheap direction, and the direction
 * this whole scan is already allowed to be wrong in. A builtin a later
 * Node *removes* is the expensive direction — silence about something
 * the host would refuse — which is why Node's underscore aliases
 * (`_http_agent`, `_stream_readable`) are deliberately absent below:
 * they are deprecated internals, Node 26 has already dropped the
 * `_stream_*` ones, and a module reaching for one is not portable across
 * Node versions even where it currently resolves.
 *
 * Electron's own additions are absent for a plainer reason. `original-fs`
 * resolves in EO's host and on no other machine, which is exactly what
 * this scan exists to say out loud.
 */
const NODE_BUILTINS = new Set([
  "assert", "assert/strict", "async_hooks", "buffer", "child_process", "cluster", "console", "constants", "crypto", "dgram",
  "diagnostics_channel", "dns", "dns/promises", "domain", "events", "fs", "fs/promises", "http", "http2", "https", "inspector",
  "inspector/promises", "module", "net", "os", "path", "path/posix", "path/win32", "perf_hooks", "process", "punycode",
  "querystring", "readline", "readline/promises", "repl", "sea", "sqlite", "stream", "stream/consumers", "stream/promises",
  "stream/web", "string_decoder", "sys", "test", "test/reporters", "timers", "timers/promises", "tls", "trace_events", "tty",
  "url", "util", "util/types", "v8", "vm", "wasi", "worker_threads", "zlib",
]);

/**
 * Whether a specifier names a builtin a module is allowed to have.
 *
 * The blocked set is matched on the root, so `node:inspector/promises`
 * is weighed as `node:inspector` — a subpath is the same builtin wearing
 * a different name, and matching the whole string let it through.
 */
function permittedBuiltin(specifier: string): boolean {
  if (!specifier.startsWith("node:")) return false;
  const bare = specifier.slice("node:".length);
  const slash = bare.indexOf("/");
  return NODE_BUILTINS.has(bare) && !BLOCKED_BUILTINS.has(`node:${slash === -1 ? bare : bare.slice(0, slash)}`);
}

/** The 1-based line an offset falls on. */
function lineAt(code: string, offset: number): number {
  return code.slice(0, offset).split("\n").length;
}

/**
 * Every specifier this module looks like it reaches for that is not a
 * permitted Node builtin.
 *
 * Deduplicated by specifier and first line, so the same package named
 * twice on one line by two overlapping patterns is one piece of advice
 * rather than two.
 *
 * The separator in that key is written `\u0000` rather than typed. A
 * specifier can contain a space or a colon and cannot contain a NUL, so
 * NUL is the right joiner — but one typed into the source makes Git read
 * this whole file as binary and stop showing its diffs.
 */
export function portabilityWarnings(code: string): PortabilityWarning[] {
  const found: PortabilityWarning[] = [];
  const seen = new Set<string>();
  const note = (specifier: string, line: number): void => {
    const key = `${specifier}\u0000${line}`;
    if (seen.has(key)) return;
    seen.add(key);
    found.push({ specifier, line });
  };

  for (const pattern of PATTERNS) {
    for (const match of code.matchAll(pattern)) {
      const specifier = match[1];
      if (specifier === undefined) continue;
      if (permittedBuiltin(specifier)) continue;
      // The line of the *specifier*, not of the keyword that opened the
      // match. A false positive spans prose, so the two can be paragraphs
      // apart — and the quoted phrase is the part an author has to find.
      note(specifier, lineAt(code, match.index + match[0].lastIndexOf(specifier)));
    }
  }

  // Any `import(` whose argument is not a single quoted literal closing
  // immediately. `"fi" + "le://…"` satisfies none of the patterns above,
  // so a concatenated specifier is read by nothing — and it is exactly
  // the shape that passes its tests and fails on somebody else's
  // machine.
  for (const match of code.matchAll(/\bimport\s*\(/g)) {
    const rest = code.slice(match.index + match[0].length);
    if (!/^\s*(["'])[^"']*\1\s*\)/.test(rest)) note("a specifier built while the module runs", lineAt(code, match.index));
  }

  return found.sort((a, b) => a.line - b.line);
}
