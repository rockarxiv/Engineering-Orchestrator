import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const mainSrcRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The two places in the main process that may name Electron.
 *
 * `index.ts` is the entry point: it builds the machine and hands it to
 * `startMain`. `platform/` is the machine — the implementation of the
 * `Platform` interface, the window it opens, the transport its pushes
 * go over. Everything else is EO, and EO does not know what it is
 * running inside.
 */
const ALLOWED = ["index.ts", `platform${sep}`];

/**
 * The packages that make a file Electron-only.
 *
 * `electron-updater` as well as `electron`, because it is the same
 * dependency wearing a different name: it reaches into the running app
 * to replace it and there is no version of it for a host that was
 * installed by a package manager.
 */
const CONFINED = ["electron", "electron-updater"];

/**
 * Every way a module dependency is spelled in this codebase — static,
 * type-only, dynamic and CJS. A type-only import counts: it is still a
 * compile-time dependency on a package that a server build has no
 * reason to have installed, and `import type { BrowserWindow }` is
 * exactly how the push transport used to sit in `ipc/`.
 */
function importsAny(source: string, packages: readonly string[]): boolean {
  return packages.some((name) => {
    const quoted = `["']${name}["']`;
    return new RegExp(`(?:from|import|require)\\s*\\(?\\s*${quoted}`).test(source);
  });
}

function walkSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walkSourceFiles(full));
    else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) files.push(full);
  }
  return files;
}

function electronImporters(): string[] {
  return walkSourceFiles(mainSrcRoot)
    .filter((file) => importsAny(readFileSync(file, "utf8"), CONFINED))
    .map((file) => relative(mainSrcRoot, file))
    .sort();
}

/**
 * The architectural invariant phase 7a exists to establish (EO-318,
 * `ARCHITECTURE.md`, "The server").
 *
 * Before this story five of 214 non-test main-process files imported
 * Electron — index.ts, ipc/handlers.ts, ipc/push.ts,
 * ipc/registerHandler.ts and notifications.ts — plus the updater, and
 * each one was a thing a server binary could not load. The count is now
 * two, and both of them are the desktop's own edge.
 *
 * Stated as an equality rather than as "no new ones", because the
 * interesting direction is both: a file that starts importing Electron
 * is a capability that has stopped being the platform's, and a file
 * here that no longer imports it is an allowance nobody needs any more.
 *
 * Test files are excluded on purpose. A test that fakes a window by
 * importing `BrowserWindow` as a type is not something a server build
 * ever loads, and forbidding it would only push the same fake into a
 * hand-written shape that can drift from the real one.
 *
 * This is about `src/main` only. The preload and the renderer are
 * Electron by definition — a server serves the renderer over HTTP
 * instead, which is a different question and a later phase's.
 */
describe("architectural invariant: Electron is confined to the platform", () => {
  it("is imported only by the entry point and the platform implementation", () => {
    const offenders = electronImporters().filter((file) => !ALLOWED.some((allowed) => file.startsWith(allowed)));

    expect(offenders).toEqual([]);
  });

  it("is imported by both of those, so neither allowance is stale", () => {
    const importers = electronImporters();

    for (const allowed of ALLOWED) {
      expect(importers.some((file) => file.startsWith(allowed))).toBe(true);
    }
  });

  it("is imported by neither the server's half of the platform nor its entry", () => {
    // The one gap the two assertions above leave (EO-319). `platform/`
    // is allowed to name Electron because it *is* the machine — but the
    // machine is implemented twice now, and the server's half is the
    // single file in this tree that must never load it. An allowance
    // written per directory cannot tell the two apart, so this names the
    // files.
    //
    // `server/**` is under no allowance at all and is already covered by
    // the sweep above; it is asserted here anyway, beside its platform,
    // because the two are one binary and a reader looking for "can the
    // server load Electron?" should find the whole answer in one place.
    const serverFiles = walkSourceFiles(mainSrcRoot)
      .map((file) => relative(mainSrcRoot, file))
      .filter((file) => file === join("platform", "server.ts") || file.startsWith(`server${sep}`));

    // Not an empty list quietly passing: the files have to be there.
    expect(serverFiles).toContain(join("platform", "server.ts"));
    expect(serverFiles).toContain(join("server", "index.ts"));

    expect(electronImporters().filter((file) => serverFiles.includes(file))).toEqual([]);
  });

  it("catches an import however it is spelled", () => {
    // The regex is the whole check, so it gets its own assertions: a
    // static import missed here is a file that would sit outside
    // `platform/` and pass.
    expect(importsAny('import { app } from "electron";', CONFINED)).toBe(true);
    expect(importsAny('import type { BrowserWindow } from "electron";', CONFINED)).toBe(true);
    expect(importsAny('const mod = await import("electron-updater");', CONFINED)).toBe(true);
    expect(importsAny('const { app } = require("electron");', CONFINED)).toBe(true);
    // And a file that merely talks about it — every doc comment in
    // `ipc/platform.ts` does — is not an importer.
    expect(importsAny("// the Electron implementation lives in platform/electron.ts", CONFINED)).toBe(false);
    expect(importsAny('import { emitPush } from "./electronish.js";', CONFINED)).toBe(false);
  });
});
