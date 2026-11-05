import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeScratch } from "./scratch.js";

/**
 * A script for a test's child Node process, as a file to run rather than
 * source to hand `-e`: run it as `spawn(process.execPath, [nodeScript(source), ...rest])`,
 * where `rest` is `process.argv[2]` onwards in the child.
 *
 * Windows Defender reads the command line of every process started, and
 * since its October 2026 signatures (1.463.x) it refuses to start a
 * `node.exe -e` whose script itself starts processes — as
 * `Trojan:Win32/SuspExec.SE`, which Node reports as `spawn EPERM`. Path
 * exclusions do not reach that, because it is the command line and not a
 * file that is judged. A path on the command line says nothing for it to
 * judge, and the file is under TEMP, which a Windows runner should
 * exclude from scanning.
 *
 * One file per distinct source, in one directory per process, removed
 * when the process exits.
 */
export function nodeScript(source: string): string {
  const known = written.get(source);
  if (known) return known;
  if (directory === undefined) {
    const created = mkdtempSync(join(tmpdir(), "eo-node-script-"));
    directory = created;
    process.once("exit", () => removeScratch(created));
  }
  const path = join(directory, `${written.size}.cjs`);
  writeFileSync(path, source);
  written.set(source, path);
  return path;
}

const written = new Map<string, string>();
let directory: string | undefined;
