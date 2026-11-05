import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readServerConfig, serverRenderer, serverResources } from "./config.js";

/**
 * How an operator tells a server where it is (EO-319).
 *
 * Worth its own tests because this is the only part of a server launch
 * that a person types, and because two of its answers are refusals: no
 * token and no data directory are the two ways to start a server that
 * should not start. Everything else in the file is a default, and a
 * default nobody checks is a default that quietly changes.
 */
/**
 * A server's environment, with the secret key already in it.
 *
 * Folded into the helper rather than repeated in every case, because
 * none of those cases is about the key (EO-320): they are about ports,
 * flags and defaults, and a variable each of them has to carry merely to
 * get past an earlier check is noise. `envWithoutKey` is for the tests
 * that are about its absence.
 */
const KEY = Buffer.alloc(32, 8);
const env = (values: Record<string, string>): NodeJS.ProcessEnv => ({ EO_SERVER_SECRET_KEY: KEY.toString("base64"), ...values });

/** The same, minus the key, for the two tests below that are about exactly that. */
const envWithoutKey = (values: Record<string, string>): NodeJS.ProcessEnv => values;

describe("reading a server's configuration", () => {
  it("refuses to start without a token", () => {
    const result = readServerConfig(env({ EO_SERVER_DATA: "/srv/eo" }), []);

    expect(result.ok).toBe(false);
    // Not a default, not a generated one, not "" — a server anybody can
    // talk to is worse than a server that did not start.
    expect(result.ok === false && result.problem).toContain("EO_SERVER_TOKEN");
  });

  it("refuses to start without a data directory", () => {
    const result = readServerConfig(env({ EO_SERVER_TOKEN: "t" }), []);

    expect(result.ok).toBe(false);
    // There is no `app.getPath("userData")` here to fall back on, and
    // guessing one would put an organisation's database somewhere
    // nobody meant to back up.
    expect(result.ok === false && result.problem).toContain("EO_SERVER_DATA");
  });

  it("refuses to start without a secret key, naming the variable to set", () => {
    const result = readServerConfig(envWithoutKey({ EO_SERVER_TOKEN: "t", EO_SERVER_DATA: "/srv/eo" }), []);

    // The third refusal, and the newest (EO-320). A headless host has no
    // keyring, so the key is the operator's to provide — and EO will not
    // invent one, because a key invented on first boot is a key nobody
    // backed up and every secret on the volume dies with the container.
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.problem).toContain("EO_SERVER_SECRET_KEY");
  });

  it("reads the key, and takes a mounted file over the environment", () => {
    const path = join(mkdtempSync(join(tmpdir(), "eo-config-key-")), "key");
    writeFileSync(path, `${Buffer.alloc(32, 4).toString("base64")}\n`);

    const fromEnvironment = readServerConfig(env({ EO_SERVER_TOKEN: "t", EO_SERVER_DATA: "/srv/eo" }), []);
    const fromFile = readServerConfig(env({ EO_SERVER_TOKEN: "t", EO_SERVER_DATA: "/srv/eo", EO_SERVER_SECRET_KEY_FILE: path }), []);
    const fromFlag = readServerConfig(env({ EO_SERVER_TOKEN: "t", EO_SERVER_DATA: "/srv/eo" }), [`--secret-key-file=${path}`]);

    expect(fromEnvironment.ok && fromEnvironment.config.secretKey.equals(KEY)).toBe(true);
    // A file is not in `docker inspect` and not in `/proc/1/environ`, so
    // an operator who arranged one meant it.
    expect(fromFile.ok && fromFile.config.secretKey.equals(Buffer.alloc(32, 4))).toBe(true);
    expect(fromFlag.ok && fromFlag.config.secretKey.equals(Buffer.alloc(32, 4))).toBe(true);
  });

  it("refuses a key that is not a key, rather than starting under a weak one", () => {
    const result = readServerConfig(envWithoutKey({ EO_SERVER_TOKEN: "t", EO_SERVER_DATA: "/srv/eo", EO_SERVER_SECRET_KEY: "hunter2" }), []);

    expect(result).toMatchObject({ ok: false, problem: expect.stringContaining("EO_SERVER_SECRET_KEY") });
  });

  it("defaults to loopback, because TLS is 7b", () => {
    const result = readServerConfig(env({ EO_SERVER_TOKEN: "t", EO_SERVER_DATA: "/srv/eo" }), []);

    expect(result.ok && result.config).toMatchObject({
      host: "127.0.0.1",
      port: 8765,
      token: "t",
      userDataPath: "/srv/eo",
      rendererDirectory: null,
      version: "0.0.0",
    });
  });

  it("takes the environment, and a flag over it", () => {
    const environment = env({ EO_SERVER_TOKEN: "from-env", EO_SERVER_DATA: "/srv/eo", EO_SERVER_PORT: "9000", EO_SERVER_HOST: "0.0.0.0" });

    const result = readServerConfig(environment, ["--port=0", "--token", "from-a-flag"]);

    expect(result.ok && result.config).toMatchObject({ port: 0, token: "from-a-flag", host: "0.0.0.0", userDataPath: "/srv/eo" });
  });

  it("takes port 0, which is how a test asks for a free one", () => {
    const result = readServerConfig(env({ EO_SERVER_TOKEN: "t", EO_SERVER_DATA: "/srv/eo", EO_SERVER_PORT: "0" }), []);

    // `Number("")` is 0 too, so the check is on the shape rather than on
    // falsiness — this is the case that would be lost to a `|| default`.
    expect(result.ok && result.config.port).toBe(0);
  });

  it("says which value is not a port", () => {
    for (const port of ["eight", "-1", "70000", "80.5"]) {
      const result = readServerConfig(env({ EO_SERVER_TOKEN: "t", EO_SERVER_DATA: "/srv/eo", EO_SERVER_PORT: port }), []);

      expect(result.ok, port).toBe(false);
      expect(result.ok === false && result.problem).toContain("port");
    }
  });

  it("names the flags it takes rather than ignoring one it does not", () => {
    const base = env({ EO_SERVER_TOKEN: "t", EO_SERVER_DATA: "/srv/eo" });

    // A typo that was silently ignored would start a server on a
    // different port than the operator asked for and say nothing.
    expect(readServerConfig(base, ["--prot", "9000"])).toMatchObject({ ok: false, problem: expect.stringContaining("--prot") });
    expect(readServerConfig(base, ["9000"])).toMatchObject({ ok: false, problem: expect.stringContaining("9000") });
    expect(readServerConfig(base, ["--port"])).toMatchObject({ ok: false, problem: expect.stringContaining("needs a value") });
    expect(readServerConfig(base, ["--port", "--host"])).toMatchObject({ ok: false, problem: expect.stringContaining("needs a value") });
  });

  it("treats an empty variable as an unset one, everywhere", () => {
    const result = readServerConfig(
      env({ EO_SERVER_TOKEN: "t", EO_SERVER_DATA: "/srv/eo", EO_SERVER_RENDERER: "", EO_SERVER_PORT: "", EO_SERVER_HOST: "", EO_SERVER_SECRET_KEY_FILE: "" }),
      [],
    );

    // A compose file interpolating a variable nobody set writes
    // `EO_SERVER_PORT=`, and that is not a request for a random port —
    // which is what `Number("")` would have made of it.
    expect(result.ok && result.config).toMatchObject({ rendererDirectory: null, port: 8765, host: "127.0.0.1" });
  });
});

describe("where a server finds the files that ship beside it", () => {
  it("reads a packaged layout when it is told where one is", () => {
    const resources = serverResources(env({ EO_SERVER_RESOURCES: join("/opt", "eo", "resources") }), "/opt/eo/server");

    expect(resources.migrations).toBe(join("/opt", "eo", "resources", "app-resources", "migrations"));
  });

  it("reads the source tree otherwise, from the bundle's own place in it", () => {
    // The layout `pnpm build:server` writes: `out/server/index.js`,
    // beside the `out/main` the desktop build produces. Reached through
    // the same resolver rather than a second copy of the layout, so a
    // change to where migrations live moves both at once.
    const resources = serverResources(env({}), join("/checkout", "apps", "desktop", "out", "server"));

    expect(resources.migrations).toBe(join("/checkout", "apps", "desktop", "src", "main", "db", "migrations"));
  });
});

/**
 * Where a server finds the app it serves (EO-319).
 *
 * The acceptance criterion is that an admin opens the address and sees
 * the app — so this has to be true of the binary as it starts, not of
 * the binary plus a variable somebody remembered. It was not: the
 * default was `null` and the documented command supplied nothing, so
 * `/` answered 503 while every renderer test passed on a directory the
 * test itself had injected.
 */
describe("where a server finds its renderer", () => {
  let root = "";

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "eo-renderer-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  /** The layout `pnpm build` and `pnpm build:server` leave behind. */
  function buildRenderer(): { entryDir: string; renderer: string } {
    const entryDir = join(root, "out", "server");
    const renderer = join(root, "out", "renderer");
    mkdirSync(entryDir, { recursive: true });
    mkdirSync(renderer, { recursive: true });
    writeFileSync(join(renderer, "index.html"), "<!doctype html>");
    return { entryDir, renderer };
  }

  it("finds the one beside the binary, with nothing configured", () => {
    const { entryDir, renderer } = buildRenderer();

    // The whole fix in one assertion: `null` in, a real directory out.
    expect(serverRenderer(null, entryDir)).toBe(renderer);
  });

  it("says so, rather than guessing, when nothing has been built", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const entryDir = join(root, "out", "server");
    mkdirSync(entryDir, { recursive: true });

    expect(serverRenderer(null, entryDir)).toBeNull();
    // Before anybody opens a browser and finds a 503 with no idea why.
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("no renderer found"));
  });

  it("prefers what the operator named", () => {
    const { entryDir } = buildRenderer();
    const elsewhere = join(root, "somewhere-else");
    mkdirSync(elsewhere, { recursive: true });
    writeFileSync(join(elsewhere, "index.html"), "<!doctype html>");

    expect(serverRenderer(elsewhere, entryDir)).toBe(elsewhere);
  });

  it("refuses to fall back when what the operator named is wrong", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { entryDir } = buildRenderer();

    // Silently serving the sibling would be answering a question the
    // operator did not ask, and hiding a typo in a deployment.
    expect(serverRenderer(join(root, "no-such-place"), entryDir)).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("EO_SERVER_RENDERER"));
  });

  it("wants an index.html, not merely a directory", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const entryDir = join(root, "out", "server");
    mkdirSync(entryDir, { recursive: true });
    // An empty `out/renderer` is what a half-finished build leaves.
    mkdirSync(join(root, "out", "renderer"), { recursive: true });

    expect(serverRenderer(null, entryDir)).toBeNull();
  });
});
