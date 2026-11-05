import * as nodeFs from "node:fs";
import { resolve, sep } from "node:path";
import type { CodexHomeFs } from "../providers/codexHome.js";

export function errno(code: string, message: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: ${message}`), { code });
}

/**
 * `node:fs` as a Windows account without admin rights or Developer Mode
 * sees it: a symbolic link of any kind fails with EPERM, and the two
 * things that need no privilege — a directory junction and a hard link —
 * work. A junction is made as a directory symlink underneath, since that
 * is the nearest thing this machine has; what is being asserted is that
 * the Windows path never asks for anything a junction or a hard link
 * cannot give it.
 */
export function windowsWithoutPrivileges(calls: string[] = [], overrides: Partial<CodexHomeFs> = {}): CodexHomeFs {
  return {
    existsSync: nodeFs.existsSync,
    linkSync: (existing, made) => {
      calls.push("link");
      nodeFs.linkSync(existing, made);
    },
    lstatSync: (path) => nodeFs.lstatSync(path),
    mkdirSync: nodeFs.mkdirSync,
    readdirSync: (path) => nodeFs.readdirSync(path),
    readlinkSync: (path) => nodeFs.readlinkSync(path),
    rmSync: nodeFs.rmSync,
    statSync: (path) => nodeFs.statSync(path, { bigint: true }),
    symlinkSync: (target, path, type) => {
      calls.push(`symlink:${type ?? "none"}`);
      if (type !== "junction") throw errno("EPERM", "operation not permitted, symlink");
      nodeFs.symlinkSync(target, path, "dir");
    },
    unlinkSync: nodeFs.unlinkSync,
    ...overrides,
  };
}

/**
 * The same account, with EO's data folder and the person's Codex home on
 * different drives: a hard link is made only for a path under
 * `sameDrive`, and fails with EXDEV anywhere else — which is what
 * Windows answers for a link that would cross volumes.
 */
export function linksOnlyWithin(sameDrive: string, calls: string[] = []): CodexHomeFs {
  const within = resolve(sameDrive) + sep;
  return windowsWithoutPrivileges(calls, {
    linkSync: (existing, made) => {
      calls.push("link");
      if (!resolve(String(made)).startsWith(within)) throw errno("EXDEV", "cross-device link not permitted");
      nodeFs.linkSync(existing, made);
    },
  });
}
