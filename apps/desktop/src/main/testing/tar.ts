import { windowsSystemTar } from "../process/systemTar.js";

/**
 * The tar a fixture builds its archive with (EO-389).
 *
 * Five test files make a real `.tar.gz` by running tar, so that the
 * reader is tested against an archive it did not write. On Windows a
 * bare `tar` is whichever one PATH finds first, and under Git Bash that
 * is Git's GNU tar, which reads the `C:\...` output path as a remote
 * host and fails — 31 tests in one release dry run. So Windows fixtures
 * name the system tar by absolute path, the same one `zip.ts` unpacks
 * with, and pass whichever shell runs the suite.
 *
 * Everywhere else `tar` on PATH is the right one and stays as it was.
 */
export function fixtureTar(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string {
  return platform === "win32" ? windowsSystemTar(env) : "tar";
}
