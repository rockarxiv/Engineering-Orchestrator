import * as nodeFs from "node:fs";
import type { CodexHomeFs } from "../providers/codexHome.js";

export function errno(code: string, message: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: ${message}`), { code });
}

/**
 * `node:fs` as a Windows account without admin rights or Developer Mode
 * sees it: a symbolic link of any kind fails with EPERM, and a directory
 * junction, which needs no privilege, works. A junction is made as a
 * directory symlink underneath, since that is the nearest thing this
 * machine has; what is being asserted is what the Windows path asks for.
 */
export function windowsWithoutPrivileges(calls: string[] = [], overrides: Partial<CodexHomeFs> = {}): CodexHomeFs {
  return windowsFs(calls, false, overrides);
}

/**
 * The same account with Developer Mode on (EO-774): a file symlink works
 * too, which is what a locked-down Codex agent's `auth.json` is.
 */
export function windowsWithDeveloperMode(calls: string[] = [], overrides: Partial<CodexHomeFs> = {}): CodexHomeFs {
  return windowsFs(calls, true, overrides);
}

function windowsFs(calls: string[], developerMode: boolean, overrides: Partial<CodexHomeFs>): CodexHomeFs {
  return {
    existsSync: nodeFs.existsSync,
    lstatSync: (path) => nodeFs.lstatSync(path),
    mkdirSync: nodeFs.mkdirSync,
    readdirSync: (path) => nodeFs.readdirSync(path),
    readlinkSync: (path) => nodeFs.readlinkSync(path),
    rmSync: nodeFs.rmSync,
    symlinkSync: (target, path, type) => {
      calls.push(`symlink:${type ?? "none"}`);
      if (type === "junction") return nodeFs.symlinkSync(target, path, "dir");
      if (!developerMode) throw errno("EPERM", "operation not permitted, symlink");
      nodeFs.symlinkSync(target, path, type);
    },
    unlinkSync: nodeFs.unlinkSync,
    ...overrides,
  };
}
