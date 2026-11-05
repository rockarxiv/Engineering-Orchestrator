import { readServerConfig } from "./config.js";
import { ROTATE_FLAG, rotateSecretsCommand } from "./rotateCommand.js";
import { startServer } from "./start.js";

/**
 * The organisation server's entry point, and nothing else (EO-319,
 * `ARCHITECTURE.md`, "The server"
 * phase 7a).
 *
 * The exact counterpart of `main/index.ts`, which is the Electron entry
 * and is also nothing else. Between them they are what phase 7a set out
 * to prove: one composition root and two machines it can be composed on.
 *
 * What is true only of a server launch is here — reading the
 * configuration out of the environment and refusing to start without a
 * token — and the composing is `start.ts`'s, which is a module a test
 * can import without launching anything.
 *
 * It is also where the one thing this binary does *instead* of serving
 * lives: `--rotate-secrets` re-encrypts every stored value under a new
 * key and exits (EO-320, `rotateCommand.ts`). Checked before the
 * configuration is read, because rotation wants no token and no port —
 * it is the same program only in the sense that it is the only program
 * that knows the layout of this data directory.
 *
 * Run it with `pnpm build && pnpm --filter @eo/desktop build:server`,
 * then `pnpm --filter @eo/desktop start:server`, or as a container with
 * `EO_SERVER_TOKEN`, `EO_SERVER_DATA` and `EO_SERVER_SECRET_KEY` set.
 * Those three are the whole of what it needs — the third since EO-320,
 * because a host with no keyring has to be handed the key its secrets
 * are encrypted under, and EO will not invent one. The app it serves is
 * the `out/renderer` beside the `out/server` it was loaded from, found
 * the same way its migrations are, so an admin opening the address sees
 * EO without anybody having
 * configured that. `pnpm build` is named first because that is what
 * writes the renderer. See config.ts for every variable and its
 * default.
 *
 * ### Why it is here, and not in `apps/server`
 *
 * The story left the choice open and asked for the reason to be written
 * down, so: **this is the desktop's own main process, so it lives in the
 * desktop's own main process.** That is not a layout convenience, it is
 * the claim phase 7a makes.
 *
 * A workspace package would have to reach `@eo/desktop`'s `src/main`,
 * which is private, has no exports entry, and is built by electron-vite
 * as an Electron bundle. Giving it one means either building those 214
 * files twice or depending on another app's sources across a package
 * boundary — and "two builds of one main process" is the precise thing
 * `startMain` was extracted to avoid.
 *
 * `apps/desktop/src/server/` — the story's own fallback — is closer, and
 * costs a fourth tsconfig, a third vitest project, a lint entry and a
 * line in the coverage scope, for code whose every import is `../main/`.
 * It also sits *outside* `platform/electronConfinement.test.ts`, which
 * walks `src/main` and allows Electron nowhere but `index.ts` and
 * `platform/`. The server is the one code in this repository that must
 * never load Electron; under `src/main` the invariant that says so
 * already covers it, and that test names these files explicitly.
 *
 * When the server becomes its own image, moving a directory is a rename.
 * The decision that costs something — which process this is — is made.
 */
const argv = process.argv.slice(2);

if (argv.includes(ROTATE_FLAG)) {
  const outcome = rotateSecretsCommand(process.env, argv);
  for (const line of outcome.lines) (outcome.ok ? console.log : console.error)(`[eo] ${line}`);
  process.exit(outcome.ok ? 0 : 1);
}

const result = readServerConfig(process.env, argv);

if (!result.ok) {
  // A sentence and a non-zero exit, which is the whole of what a
  // container orchestrator can read. No stack trace: nothing here is a
  // programmer error, it is an environment missing something.
  console.error(`[eo] ${result.problem}`);
  process.exit(1);
}

const started = startServer(result.config);

if (!started.ok) {
  // The same shape as the refusals above, and for the same kind of
  // reason: something about this host is not as the operator believes —
  // here, that nothing else is using this data directory.
  console.error(`[eo] ${started.problem}`);
  process.exit(1);
}
