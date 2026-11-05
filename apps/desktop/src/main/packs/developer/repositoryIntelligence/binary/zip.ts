import { execFile } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { promisify } from "node:util";
import { windowsSystemTar } from "../../../../process/systemTar.js";

const execFileAsync = promisify(execFile);

/**
 * Unpacking the Windows build (A-08).
 *
 * Every other target ships a `.tar.gz`, which `runtimes/tar.ts` already
 * reads. Windows ships a `.zip`, and that reader is gzipped-tar only.
 *
 * Rather than add an archive dependency for one platform's one file,
 * this uses the bsdtar executable included with supported Windows
 * versions. It reads ZIP files directly and takes an argv array, with no
 * shell or PowerShell startup involved.
 *
 * It is named by its absolute path under the Windows system directory,
 * never as a bare `tar.exe` (EO-389). A bare name goes through PATH,
 * where Git for Windows' GNU tar sits ahead of System32 for anything
 * started from Git Bash — and GNU tar reads `C:\...` as a remote host.
 *
 * On path traversal: the archive's bytes are checked against the
 * publisher's own SHA-256 before this is called, so an entry that tried
 * to escape would mean the publisher had gone hostile — and EO is about
 * to execute their binary regardless. The checksum is the defence that
 * matters here; a second guess at what is inside the zip would not add
 * one. The tar path still runs `isSafeEntryPath` because it writes the
 * entries itself and the check is free.
 */

/** The seam `install.ts` extracts through, so its tests need no PowerShell. */
export type ZipExtractor = (archive: string, destination: string) => Promise<void>;

/** Thrown when PowerShell refuses or is not there at all. */
export class ZipError extends Error {}

/**
 * The system tar's absolute path, from `SystemRoot` with a fallback when
 * it is unset. A function of the environment so it can be asserted on
 * from any platform.
 */
export const windowsTarPath = windowsSystemTar;

/** The path `expandArchive` runs, resolved once from this process's environment. */
export const WINDOWS_TAR = windowsTarPath();

/**
 * The argument vector, separated out so it can be asserted on anywhere.
 *
 * Individual arguments are never shell-expanded, so spaces, brackets and
 * quotes in either path are ordinary path characters.
 */
export function expandArchiveArgs(archive: string, destination: string): string[] {
  return ["-xf", archive, "-C", destination];
}

/**
 * Expands `archive` into `destination`, creating it.
 *
 * Asynchronous on purpose: this runs in the Electron main process, and
 * a synchronous spawn would freeze every window for as long as a 44 MB
 * archive takes to unpack.
 */
export const expandArchive: ZipExtractor = async (archive, destination) => {
  try {
    await rm(destination, { recursive: true, force: true });
    await mkdir(destination, { recursive: true });
    await execFileAsync(WINDOWS_TAR, expandArchiveArgs(archive, destination), { windowsHide: true });
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { stderr?: string | Buffer };
    const stderr = typeof failure.stderr === "string" ? failure.stderr : Buffer.isBuffer(failure.stderr) ? failure.stderr.toString("utf8") : "";
    const detail = (stderr.trim() !== "" ? stderr : failure.message).trim();
    throw new ZipError(`${WINDOWS_TAR} could not expand ${archive}: ${detail}`);
  }
};
