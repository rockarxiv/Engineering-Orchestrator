import { win32 } from "node:path";

/**
 * Where Windows keeps its own tar (EO-389).
 *
 * `%SystemRoot%\System32\tar.exe` is bsdtar: it reads ZIP files and takes
 * drive-letter paths. A bare `tar.exe` is resolved through PATH instead,
 * and Git for Windows ships a GNU tar in its `usr\bin` — ahead of
 * System32 for any process started from Git Bash. GNU tar reads `C:\...`
 * as a remote `host:path` and fails with "Cannot connect to C: resolve
 * failed". So the system tar is named by its absolute path and PATH is
 * never consulted.
 *
 * `win32.join` rather than `join`, so the answer is the same string on
 * every platform and the test for it needs no Windows to run.
 *
 * Here rather than beside the zip reader that uses it, because the
 * runtime installer's test fixtures need the same answer and may not
 * reach into a pack for it.
 */
export const DEFAULT_SYSTEM_ROOT = "C:\\Windows";

export function windowsSystemTar(env: NodeJS.ProcessEnv = process.env): string {
  return windowsSystemExecutable("tar.exe", env);
}

/**
 * Any of Windows' own programs under System32, by absolute path, for the
 * same reason: PATH is the caller's to narrow — a Git Bash, a test's
 * `vi.stubEnv("PATH", …)` — and whether EO can find or end a process tree
 * (`processTree.ts`) must not hang on it.
 */
export function windowsSystemExecutable(relative: string, env: NodeJS.ProcessEnv = process.env): string {
  // Windows environment variable names are case-insensitive, and
  // `process.env` honours that on Windows only. An env object that was
  // copied (or a test's literal) may carry either spelling.
  const configured = env.SystemRoot ?? env.SYSTEMROOT ?? "";
  // An unset variable and an empty one are the same absence. A relative
  // value would put the lookup back at the mercy of the working
  // directory, which is the kind of ambiguity this exists to remove.
  const root = win32.isAbsolute(configured) ? configured : DEFAULT_SYSTEM_ROOT;
  return win32.join(root, "System32", relative);
}
