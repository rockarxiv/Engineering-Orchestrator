// Lets `node` run this repository's TypeScript, with nothing fetched
// (EO-155).
//
// The reporting scripts here are TypeScript because they import the code
// that ships — the classifier, the arithmetic — rather than a second
// copy of it that could drift. Running TypeScript usually means reaching
// for a runner, and `pnpm dlx tsx` reaches for the network: on a machine
// that has not cached it, the documented way to run a report EO promises
// is local began with `GET https://registry.npmjs.org/tsx`. For a story
// whose acceptance criterion is "nothing is transmitted anywhere", that
// is not a detail.
//
// So the report runs on Node and nothing else. Node has stripped types
// since 22.6 and does it by default since 22.18, which leaves exactly
// one gap between "valid TypeScript" and "a file Node can execute", and
// this closes it. Node builtins only — there is nothing here to install
// and nothing to fetch.
//
//   node --experimental-strip-types --disable-warning=ExperimentalWarning \
//        --import ./scripts/local-typescript.mjs scripts/index-benefit.mts
//
// which is what `pnpm report:index-benefit` runs.
//
// **It is not a build step and not a bundler.** It rewrites one kind of
// specifier and hands everything else straight back to Node. Type
// stripping is Node's; module resolution is Node's; this only answers
// the one question Node answers wrongly for a repository laid out like
// this one.
//
// It does assume the workspace packages are built, because `@eo/core`
// resolves to its `dist/`. Any checkout that has run `pnpm typecheck`,
// `pnpm lint`, `pnpm test` or `pnpm build` has one, and a checkout that
// has not gets Node's own error naming the missing file. Building that
// automatically was considered and rejected: it would mean running
// `turbo` inside a report whose entire promise is that running it
// transmits nothing, and turbo has telemetry of its own.

import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";

/**
 * The gap: `./thing.js` when the file on disk is `./thing.ts`.
 *
 * The `.js` extension in a relative import is not a mistake and cannot
 * be changed — TypeScript's NodeNext resolution requires it, and every
 * import in `apps/desktop/src/main` is written that way. Node takes the
 * specifier literally, finds no such file, and fails. So: when a
 * relative `.js` specifier does not exist and its `.ts` twin does, the
 * twin is what was meant.
 *
 * Only when the `.js` is genuinely absent, so a directory holding both
 * a compiled file and its source keeps resolving to the compiled one,
 * which is what Node would have done unaided.
 */
function typeScriptTwin(specifier, parentURL) {
  if (!specifier.startsWith("./") && !specifier.startsWith("../")) return null;
  if (!specifier.endsWith(".js") && !specifier.endsWith(".mjs")) return null;
  if (parentURL === undefined) return null;

  const asWritten = new URL(specifier, parentURL);
  if (existsSync(fileURLToPath(asWritten))) return null;

  for (const extension of [".ts", ".mts"]) {
    const source = new URL(specifier.replace(/\.m?js$/, extension), parentURL);
    if (existsSync(fileURLToPath(source))) return source.href;
  }
  return null;
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    const twin = typeScriptTwin(specifier, context.parentURL);
    return nextResolve(twin ?? specifier, context);
  },
});
