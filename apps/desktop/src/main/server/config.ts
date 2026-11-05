import { existsSync } from "node:fs";
import { join } from "node:path";
import { resolveResourcePaths, type ResourcePaths } from "../resources.js";
import { readSecretKey, SERVER_SECRET_KEY_FILE_VARIABLE, SERVER_SECRET_KEY_VARIABLE } from "../secrets/serverKey.js";

/**
 * How an organisation server is told where it is and who may talk to it
 * (EO-319, the original design).
 *
 * "A single binary or container, one data directory, one SQLite file."
 * There is no Settings screen to read any of this from, because none of
 * it is a preference: it is how the container was started. So it arrives
 * the way a container is configured — environment first, a flag to
 * override it when somebody is running the binary by hand.
 *
 * Every knob has a default except the token, which deliberately does
 * not. See `readServerConfig`.
 */
export interface ServerConfig {
  /**
   * The interface to bind.
   *
   * Loopback by default, and that is a security decision rather than a
   * convenience one: TLS is 7b (`ARCHITECTURE.md`,
   * "The server"), so until it lands anything this process puts on a network is
   * plaintext with a bearer token in it. Binding wider is something an
   * operator does on purpose, behind their own terminator.
   */
  host: string;
  port: number;
  /**
   * The one admin token, in full.
   *
   * "A single hard-coded admin token read from the environment for now;
   * real sign-in is 7b." One shared secret is not an identity and this
   * is not pretending otherwise — the design is where
   * people and devices arrive.
   */
  token: string;
  /**
   * The key every secret on this volume is encrypted under (EO-320).
   *
   * Beside the token because it arrives the same way and for the same
   * reason — there is no keyring on a headless host and no Settings
   * screen to unlock one from — and refused the same way when it is
   * missing. `secrets/serverKey.ts` is where it is read and why EO
   * never invents one; `secrets/serverStore.ts` is what it opens.
   */
  secretKey: Buffer;
  /** The data directory: one per server, holding `eo.db` and everything beside it. */
  userDataPath: string;
  /**
   * The built renderer to serve, or `null` when the operator named one
   * and it is not there.
   *
   * **Not usually configured.** "The admin opens its address in a
   * browser and sees the same renderer the desktop has"
   * (the original design), so serving the app is what a server
   * does rather than something it is asked to do — the bundle sits in
   * `out/renderer`, beside the `out/server` this binary was loaded from,
   * and `serverRenderer` finds it there the way `serverResources` finds
   * the migrations. `EO_SERVER_RENDERER` is for a layout that puts it
   * somewhere else.
   *
   * Null survives as a real state for the one case that is real: a
   * checkout where `pnpm build` has not been run, which answers IPC
   * perfectly well with nothing to look at. What it must not do is
   * pretend, which is why `serveRenderer` says so in a page rather than
   * in a 404 — and why startup warns before anybody opens a browser.
   */
  rendererDirectory: string | null;
  /** What this process answers `app:getVersion` with. */
  version: string;
}

export type ServerConfigResult = { ok: true; config: ServerConfig } | { ok: false; problem: string };

/**
 * Loopback, for the reason `ServerConfig.host` gives.
 */
const DEFAULT_HOST = "127.0.0.1";
/** Nothing else on this machine wants it, and it is not a well-known port. */
const DEFAULT_PORT = 8765;

/**
 * Reads the configuration, or says in one sentence what is missing.
 *
 * A result rather than a throw: this is the boundary between an
 * operator's environment and EO, and a stack trace is the wrong way to
 * tell somebody they forgot a variable (the errors convention in
 * CLAUDE.md).
 *
 * The flags are the same names as the variables, lower-cased and
 * hyphenated. Both forms are here because the two ways this runs want
 * different ones: a container sets environment, and somebody trying it
 * on their laptop types a flag.
 *
 * @param env  usually `process.env`
 * @param argv usually `process.argv.slice(2)`
 */
export function readServerConfig(env: NodeJS.ProcessEnv, argv: readonly string[]): ServerConfigResult {
  const flags = parseFlags(argv);
  if (!flags.ok) return flags;

  const token = chosen(flags.values["token"], env["EO_SERVER_TOKEN"]) ?? "";
  if (token.length === 0) {
    return {
      ok: false,
      problem:
        "Set EO_SERVER_TOKEN (or pass --token) to the admin token this server will accept. " +
        "EO will not start a server that anyone can talk to.",
    };
  }

  const userDataPath = chosen(flags.values["data"], env["EO_SERVER_DATA"]) ?? "";
  if (userDataPath.length === 0) {
    return {
      ok: false,
      problem:
        "Set EO_SERVER_DATA (or pass --data) to the directory this server keeps its state in. " +
        "There is no per-user default on a server the way there is on a desktop.",
    };
  }

  const key = readSecretKey({
    value: env[SERVER_SECRET_KEY_VARIABLE],
    file: chosen(flags.values["secret-key-file"], env[SERVER_SECRET_KEY_FILE_VARIABLE]),
    names: { value: SERVER_SECRET_KEY_VARIABLE, file: SERVER_SECRET_KEY_FILE_VARIABLE, fileFlag: "secret-key-file" },
    purpose: "encrypts its secrets with",
  });
  if (!key.ok) return { ok: false, problem: key.problem };

  const rawPort = chosen(flags.values["port"], env["EO_SERVER_PORT"]);
  const port = rawPort === undefined ? DEFAULT_PORT : Number(rawPort);
  // On the shape rather than on falsiness, because 0 is a real request —
  // bind any free port, which is what the smoke test asks for — and a
  // `|| DEFAULT_PORT` would silently answer a different question.
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    return { ok: false, problem: `"${String(rawPort)}" is not a port number.` };
  }

  return {
    ok: true,
    config: {
      host: chosen(flags.values["host"], env["EO_SERVER_HOST"]) ?? DEFAULT_HOST,
      port,
      token,
      secretKey: key.key,
      userDataPath,
      // What the operator *said*, which is usually nothing. `startServer`
      // fills in the bundle's own `out/renderer` when this is null — it
      // is the one that knows where the entry was loaded from, exactly
      // as it is for `resources`.
      rendererDirectory: chosen(flags.values["renderer"], env["EO_SERVER_RENDERER"]) ?? null,
      // Stamped by whatever built the binary. "0.0.0" rather than the
      // desktop's version, because claiming one this process cannot
      // check would put a wrong number in `app:getVersion`, in the MCP
      // hosts' handshake and in the alias-retirement check.
      version: chosen(env["EO_SERVER_VERSION"]) ?? "0.0.0",
    },
  };
}

/**
 * Where the files that ship beside the bundle are, for a server.
 *
 * The same resolver the desktop uses, pointed at a layout that is not
 * Electron's: `EO_SERVER_RESOURCES` is what a packaged server sets, and
 * without it this is a checkout and the paths are the source tree's.
 * Said here rather than inside the platform because it is a fact about
 * how *this* build was laid out, which is exactly what
 * `Platform.resources` documents.
 *
 * @param entryDir the directory the server entry was loaded from —
 *   `<app>/out/server` for the bundle `pnpm build:server` writes
 */
export function serverResources(env: NodeJS.ProcessEnv, entryDir: string): ResourcePaths {
  const packagedRoot = env["EO_SERVER_RESOURCES"];
  if (packagedRoot !== undefined && packagedRoot.length > 0) {
    return resolveResourcePaths({ isPackaged: true, resourcesPath: packagedRoot, mainDir: entryDir });
  }
  // Unpackaged, the resolver answers `<mainDir>/../../src/main` — so the
  // directory to hand it is the `out/main` the desktop build writes,
  // which is the sibling of the `out/server` this bundle is in. It need
  // not exist: every path that comes back is under `src/`.
  //
  // Which is to say the unpackaged layout is the one `pnpm build:server`
  // produces, and running the entry from anywhere else wants
  // `EO_SERVER_RESOURCES` — or, as the tests do, resources of its own.
  return resolveResourcePaths({ isPackaged: false, resourcesPath: "", mainDir: join(entryDir, "..", "main") });
}

/**
 * The renderer this server serves.
 *
 * The reason this exists at all: a server whose `/` answers 503 is not
 * an organisation server, it is an API with a disappointing front page.
 * The original design asks for the opposite — "the admin opens
 * its address in a browser and sees the same renderer the desktop has.
 * There is no separate admin product to learn" — and that has to be
 * true of the binary as it actually starts, not of the binary plus an
 * environment variable somebody remembered.
 *
 * So it is resolved exactly the way `serverResources` resolves the
 * migrations and the prompts: from where this bundle was loaded. `pnpm
 * build` writes `out/renderer` and `pnpm build:server` writes
 * `out/server`, so the app is the sibling directory. Checked for
 * existence rather than assumed, because the honest answer when it has
 * not been built is "there is nothing to serve" and not a 404 for every
 * asset.
 *
 * @param explicit what the operator asked for, if anything
 * @param entryDir the directory the server entry was loaded from
 */
export function serverRenderer(explicit: string | null, entryDir: string): string | null {
  if (explicit !== null) {
    // Named rather than found: if it is wrong, that is worth a sentence
    // at startup rather than a silent fall back to a directory the
    // operator did not mean.
    if (rendererAt(explicit)) return explicit;
    console.warn(`[eo] EO_SERVER_RENDERER points at ${explicit}, which has no index.html in it. No app will be served.`);
    return null;
  }

  const beside = join(entryDir, "..", "renderer");
  if (rendererAt(beside)) return beside;

  console.warn(
    `[eo] no renderer found at ${beside}, so this server answers IPC but serves no app. ` +
      "Run `pnpm --filter @eo/desktop build` to build one, or set EO_SERVER_RENDERER.",
  );
  return null;
}

/** A directory is a renderer when it has the page that boots one. */
function rendererAt(directory: string): boolean {
  return existsSync(join(directory, "index.html"));
}

/**
 * The flag, then the variable, and neither if both are empty.
 *
 * Empty is *unset*, everywhere, on purpose: a compose file that
 * interpolates a variable nobody set writes `EO_SERVER_PORT=` into the
 * environment, and the difference between that and not writing it at all
 * is not a difference the operator intended. Its opposite failure is the
 * one worth avoiding — `Number("")` is 0, so an empty port would have
 * bound a random one and said nothing.
 */
function chosen(...candidates: Array<string | undefined>): string | undefined {
  for (const candidate of candidates) {
    if (candidate !== undefined && candidate.length > 0) return candidate;
  }
  return undefined;
}

export type FlagResult = { ok: true; values: Record<string, string> } | { ok: false; problem: string };

/**
 * `--name value` and `--name=value`, and nothing else.
 *
 * Exported because the rotation command takes flags too and takes a
 * different set of them (`server/rotateCommand.ts`) — one parser, so
 * that "EO's server does not take …" is one sentence with one shape
 * wherever an operator mistypes something.
 */
export function parseFlags(argv: readonly string[], known: readonly string[] = KNOWN_FLAGS): FlagResult {
  const values: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] ?? "";
    if (!argument.startsWith("--")) return { ok: false, problem: `EO's server does not take "${argument}".` };
    const [name, inlineValue] = splitOnce(argument.slice(2), "=");
    if (!known.includes(name)) {
      return { ok: false, problem: `EO's server does not take "--${name}". It takes ${known.map((flag) => `--${flag}`).join(", ")}.` };
    }
    if (inlineValue !== null) {
      values[name] = inlineValue;
      continue;
    }
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) return { ok: false, problem: `"--${name}" needs a value.` };
    values[name] = next;
    index += 1;
  }
  return { ok: true, values };
}

/**
 * `--secret-key` is deliberately absent, and its file is not.
 *
 * A key on a command line is a key in `ps`, in the shell history and in
 * whatever collects an orchestrator's process table. A path is none of
 * those, and the variable remains for an operator whose deployment has
 * nowhere to mount a file.
 */
const KNOWN_FLAGS = ["host", "port", "token", "data", "renderer", "secret-key-file"];

function splitOnce(text: string, separator: string): [string, string | null] {
  const at = text.indexOf(separator);
  return at === -1 ? [text, null] : [text.slice(0, at), text.slice(at + separator.length)];
}
