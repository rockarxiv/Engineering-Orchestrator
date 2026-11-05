import {
  NEW_SERVER_SECRET_KEY_FILE_VARIABLE,
  NEW_SERVER_SECRET_KEY_VARIABLE,
  readSecretKey,
  SERVER_SECRET_KEY_FILE_VARIABLE,
  SERVER_SECRET_KEY_VARIABLE,
} from "../secrets/serverKey.js";
import { rotateServerSecrets } from "../secrets/rotateServerSecrets.js";
import { parseFlags } from "./config.js";

/**
 * The command an admin runs to replace a server's secret key (EO-320,
 * `ARCHITECTURE.md`, "The server").
 *
 * ```
 * EO_SERVER_DATA=/srv/eo \
 * EO_SERVER_SECRET_KEY_FILE=/run/secrets/eo-key \
 * EO_SERVER_NEW_SECRET_KEY_FILE=/run/secrets/eo-key-next \
 *   node out/server/index.js --rotate-secrets
 * ```
 *
 * The same binary rather than a second one, because it is the same
 * program doing the one thing only this program knows how to do: read
 * the layout of its own data directory. It runs *instead of* starting
 * the server — `index.ts` checks for the flag first — so it needs no
 * token, opens no port and touches no database.
 *
 * **The server must be stopped first**, and that is enforced rather than
 * asked for: a running server holds the data directory
 * (`dataDirectoryLock.ts`) and rotation takes the same lock, so an admin
 * who runs this against a live server is told which process has it
 * instead of being given a success over a volume that was changing
 * underneath the scan.
 *
 * Afterwards the admin swaps the new key into `EO_SERVER_SECRET_KEY`
 * (or the file that variable names) and starts the server again. EO
 * does not do that part: what a container's environment says is the
 * operator's to change, and a process that rewrote its own deployment
 * would be guessing at where they keep it.
 *
 * Nothing here calls `process.exit` or prints: it answers with lines and
 * a verdict, so a test can run a real rotation on a real directory
 * without ending the test runner. `index.ts` is where that becomes an
 * exit code.
 */

/** What tells `index.ts` this is a rotation rather than a launch. */
export const ROTATE_FLAG = "--rotate-secrets";

/**
 * What this command takes, which is not what the server takes.
 *
 * `--rotate-secrets` itself is not among them: it is the word that
 * chose this command rather than an argument to it, and the parser
 * takes every flag as `--name value`. So it is dropped before parsing,
 * and anything else left over is still a refusal — a `--token` taken
 * silently here would let somebody believe rotation had read something
 * it had not.
 */
const ROTATE_FLAGS = ["data", "secret-key-file", "new-secret-key-file"];

export interface CommandOutcome {
  ok: boolean;
  /** What to print, one line at a time, without EO's prefix. */
  lines: string[];
}

export function rotateSecretsCommand(env: NodeJS.ProcessEnv, argv: readonly string[]): CommandOutcome {
  const flags = parseFlags(
    argv.filter((argument) => argument !== ROTATE_FLAG),
    ROTATE_FLAGS,
  );
  if (!flags.ok) return { ok: false, lines: [flags.problem] };

  const directory = flags.values["data"] ?? env["EO_SERVER_DATA"] ?? "";
  if (directory.trim().length === 0) {
    return {
      ok: false,
      lines: ["Set EO_SERVER_DATA (or pass --data) to the directory whose secrets are being rotated. It is the one the server runs on."],
    };
  }

  const from = readSecretKey({
    value: env[SERVER_SECRET_KEY_VARIABLE],
    file: flags.values["secret-key-file"] ?? env[SERVER_SECRET_KEY_FILE_VARIABLE],
    names: { value: SERVER_SECRET_KEY_VARIABLE, file: SERVER_SECRET_KEY_FILE_VARIABLE, fileFlag: "secret-key-file" },
    purpose: "encrypts its secrets with today",
  });
  if (!from.ok) return { ok: false, lines: [from.problem] };

  const to = readSecretKey({
    value: env[NEW_SERVER_SECRET_KEY_VARIABLE],
    file: flags.values["new-secret-key-file"] ?? env[NEW_SERVER_SECRET_KEY_FILE_VARIABLE],
    names: { value: NEW_SERVER_SECRET_KEY_VARIABLE, file: NEW_SERVER_SECRET_KEY_FILE_VARIABLE, fileFlag: "new-secret-key-file" },
    purpose: "should encrypt its secrets with from now on",
  });
  if (!to.ok) return { ok: false, lines: [to.problem] };

  const result = rotateServerSecrets({ directory: directory.trim(), from: from.key, to: to.key });
  if (!result.ok) {
    // Every path named, because "some value somewhere failed" is not
    // something an operator can act on, and nothing was written — so
    // the old key still opens everything and there is time to look.
    return { ok: false, lines: [result.problem, ...result.unreadable.map((path) => `  unreadable: ${path}`)] };
  }

  const lines = [
    `Re-encrypted ${String(result.rotated.length)} stored value(s) under the new key.`,
    ...result.rotated.map((path) => `  ${path}`),
  ];
  if (result.alreadyRotated.length > 0) {
    // A re-run of a rotation that died between renames. Said out loud
    // rather than folded into the count, so the number an operator sees
    // is the number this run changed.
    lines.push(`${String(result.alreadyRotated.length)} value(s) were already under the new key and were left alone.`);
  }
  lines.push(
    result.rotated.length === 0 && result.alreadyRotated.length === 0
      ? `No stored values were found under ${directory.trim()}. If that is a surprise, check that it is the directory the server runs on.`
      : `Now set ${SERVER_SECRET_KEY_VARIABLE} (or the file ${SERVER_SECRET_KEY_FILE_VARIABLE} names) to the new key and start the server again. The old key no longer reads anything here.`,
  );
  return { ok: true, lines };
}
