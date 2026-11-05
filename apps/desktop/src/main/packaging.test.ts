import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { resolveResourcePaths } from "./resources.js";

const appRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * Where a packaged build looks for the files it does not bundle.
 *
 * Written over *every* field of `ResourcePaths` rather than over a list
 * of them, and that is the point rather than tidiness. Each of these
 * checks used to name three paths by hand while the type had four, so
 * `moduleHost` was resolved, shipped and never checked — and the fourth
 * file added after that would have been the same. The failure they exist
 * to catch is invisible in development and fatal on first launch of a
 * release, which is exactly the kind that must not depend on somebody
 * remembering to extend a literal.
 */
const PACKAGED_ROOT = "app-resources";

describe("resource resolution", () => {
  it("reads every one of its files from the source tree when unpackaged", () => {
    const paths = resolveResourcePaths({ isPackaged: false, resourcesPath: "/ignored", mainDir: join(appRoot, "out", "main") });

    // The real files must be there, or a dev build silently fails to
    // migrate and starts every agent with an empty prompt.
    for (const [name, path] of Object.entries(paths)) {
      expect(existsSync(path), `${name} does not exist at ${path}`).toBe(true);
    }
    // Non-vacuous: an empty object would satisfy the loop above.
    expect(Object.keys(paths).length).toBeGreaterThanOrEqual(4);
  });

  it("reads every one of them from process.resourcesPath when packaged", () => {
    // Built with join() rather than literal separators: this same test
    // runs on Windows, where a hardcoded "/" would fail for a reason
    // that has nothing to do with the behaviour being checked.
    const resourcesPath = join("/Apps", "EO.app", "Contents", "Resources");
    const paths = resolveResourcePaths({ isPackaged: true, resourcesPath, mainDir: "/ignored" });

    for (const [name, path] of Object.entries(paths)) {
      expect(path.startsWith(join(resourcesPath, PACKAGED_ROOT)), `${name} resolves outside the shipped root: ${path}`).toBe(true);
    }
    // The two that decide whether the app starts at all, named because a
    // rule about shape would not notice one of them moving.
    expect(paths.migrations).toBe(join(resourcesPath, PACKAGED_ROOT, "migrations"));
    expect(paths.eoMcpServer).toBe(join(resourcesPath, PACKAGED_ROOT, "mcp", "eoServer.mjs"));
  });
});

describe("the MCP protocol library reaches a packaged build", () => {
  const manifest = JSON.parse(readFileSync(join(appRoot, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };

  it("is a real dependency, not a dev one", () => {
    // externalizeDepsPlugin leaves it out of the main bundle and
    // electron-builder packs it from node_modules — which it does for
    // `dependencies` and not for `devDependencies`. Getting this wrong
    // builds and tests clean and fails only on a packaged launch, with
    // the MCP server quietly refusing to start.
    expect(manifest.dependencies?.["@modelcontextprotocol/sdk"]).toBeDefined();
    expect(manifest.devDependencies?.["@modelcontextprotocol/sdk"]).toBeUndefined();
  });

  it("is not caught by a files exclusion", () => {
    // There are already three `!**/node_modules/...` rules next to each
    // other in that file, for packages EO deliberately does not ship. A
    // fourth aimed at this one would look entirely at home.
    const builder = readFileSync(join(appRoot, "electron-builder.yml"), "utf8");

    expect(builder).not.toContain("!**/node_modules/@modelcontextprotocol");
  });
});

describe("the app's package.json", () => {
  const manifest = JSON.parse(readFileSync(join(appRoot, "package.json"), "utf8")) as {
    name: string;
    productName?: string;
    repository?: { url?: string };
  };

  it("names the app for userData, not after the workspace package", () => {
    // app.getName() drives app.getPath("userData"). Electron prefers
    // productName over name — without it a packaged build stored its
    // database under ~/.config/@eo/desktop, creating a stray "@eo"
    // directory. Invisible in dev, and only on a packaged run.
    expect(manifest.productName).toBe("EO");
    expect(manifest.name.startsWith("@"), "a scoped name would become a nested userData directory").toBe(true);
  });

  it("says where a release publishes to", () => {
    // electron-builder resolves the GitHub target from here. Without it
    // `pnpm release` warns and has nowhere to publish.
    expect(manifest.repository?.url).toContain("github.com");
  });
});

describe("the electron-builder config", () => {
  const config = readFileSync(join(appRoot, "electron-builder.yml"), "utf8");
  // Comments in this file explain the traps by naming them, so asserting
  // a word is *absent* has to look at the settings alone.
  const settings = config
    .split("\n")
    .filter((line) => !line.trim().startsWith("#"))
    .join("\n");

  it("ships every runtime-read file as an extraResource, at the path the resolver expects", () => {
    // Derived from the resolver rather than listed beside it, so the two
    // cannot disagree. A file read from disk with no entry here is fatal
    // on first launch of a release build and invisible everywhere else,
    // and the way that happens is somebody adding the resolver half and
    // not this one.
    const resourcesPath = join("/Apps", "EO.app", "Contents", "Resources");
    const paths = resolveResourcePaths({ isPackaged: true, resourcesPath, mainDir: "/ignored" });

    for (const [name, path] of Object.entries(paths)) {
      // `to:` in the config is written with forward slashes whatever the
      // platform, so the resolved path is put back into that spelling
      // rather than compared in this machine's.
      const to = relative(resourcesPath, path).split(sep).join("/");
      expect(config, `extraResources is missing ${name} (${to})`).toContain(to);
    }
    expect(Object.keys(paths).length).toBeGreaterThanOrEqual(4);
  });

  it("unpacks better-sqlite3 from the asar", () => {
    // node-gyp-build resolves a real filesystem path for the prebuilt
    // binary, which cannot exist inside an asar archive.
    expect(config).toContain("asarUnpack");
    expect(config).toContain("better-sqlite3");
  });

  it("builds Windows x64 and arm64 in one target list", () => {
    // Both archs, from ONE electron-builder run. Only Linux gets an arch
    // suffix on its update metadata, so two Windows *jobs* would both
    // write latest.yml and the second would overwrite the first —
    // leaving whichever finished last as the only installer anyone is
    // ever offered. The release workflow depends on this staying here.
    const windows = config.slice(config.indexOf("win:"), config.indexOf("linux:"));
    expect(windows).toContain("x64");
    expect(windows).toContain("arm64");
  });

  it("builds a macOS zip beside the dmg", () => {
    // macOS updates are applied from a zip. Without one, MacUpdater
    // throws ERR_UPDATER_ZIP_FILE_NOT_FOUND after the update was already
    // found and auto-download started — so every update fails, and the
    // failure is swallowed into a log line nobody reads.
    const mac = config.slice(config.indexOf("mac:"), config.indexOf("win:"));
    expect(mac).toContain("target: dmg");
    expect(mac).toContain("target: zip");
  });

  it("names artifacts with their arch, except on Windows", () => {
    // macOS needs it: electron-updater picks a file by looking for
    // process.arch in its name, and an unlabelled x64 artifact gets
    // matched by position instead.
    expect(config).toContain("${arch}");

    // Windows must NOT have it. NSIS builds the combined installer *and*
    // one per arch when the pattern contains ${arch} and more than one
    // arch is requested — three .exe files on the release page, and no
    // way for anyone to tell which they want. One installer carrying
    // both architectures is the whole point.
    const windows = settings.slice(settings.indexOf("win:"), settings.indexOf("linux:"));
    expect(windows).toContain("artifactName:");
    expect(windows.slice(windows.indexOf("artifactName:")).split("\n")[0]).not.toContain("${arch}");
  });

  it("names the Linux target explicitly", () => {
    // The default is ["snap", "appimage"], and snap needs snapcraft on
    // the build machine. Omitting `target` does not mean "none".
    const linux = settings.slice(settings.indexOf("linux:"));
    expect(linux).toContain("target: AppImage");
    expect(linux).not.toContain("snap");
  });

  it("keeps the hardened runtime, and leaves notarization off while unsigned", () => {
    // `notarize: true` is harmless with no credentials — it warns and
    // skips — but *partial* credentials throw, so the day someone sets
    // APPLE_ID alone every macOS build dies. This flips in the same
    // commit that adds all three secrets.
    expect(config).toContain("hardenedRuntime: true");
    expect(config).toContain("notarize: false");
    expect(config).toContain("entitlements");
  });

  it("has the entitlements the app actually needs", () => {
    const entitlements = readFileSync(join(appRoot, "build", "entitlements.mac.plist"), "utf8");

    // EO spawns the codex CLI, git, and the configured check commands;
    // without these the app crashes on a signed build only.
    expect(entitlements).toContain("com.apple.security.cs.allow-jit");
    expect(entitlements).toContain("com.apple.security.cs.disable-library-validation");
    expect(entitlements).toContain("com.apple.security.files.user-selected.read-write");
  });
});

/**
 * That NOTICE is generated, and that it ships. What it has to *say* is
 * asserted beside the catalogue that creates the obligation —
 * `repositoryIntelligence/binary/notice.test.ts` — so that packaging
 * stays ignorant of which third-party components EO fetches.
 */
describe("the attribution notice", () => {
  const repoRoot = join(appRoot, "..", "..");
  const notice = readFileSync(join(repoRoot, "NOTICE"), "utf8");
  const header = readFileSync(join(repoRoot, "scripts", "notice-header.md"), "utf8");
  const builder = readFileSync(join(appRoot, "electron-builder.yml"), "utf8");

  it("reaches a packaged build", () => {
    // NOTICE lives two directories above this one, so `files` never sees
    // it and neither does anyone running an installed EO. The obligation
    // it records is towards the person holding the app, not the person
    // holding the source tree.
    expect(builder).toContain("from: ../../NOTICE");
    expect(builder).toContain("to: NOTICE");
    expect(existsSync(join(repoRoot, "NOTICE"))).toBe(true);
  });

  it("ships EO's own licence beside it and shows it in the installer", () => {
    // Apache-2.0 section 4: whoever receives the binary receives the
    // licence too, not only whoever clones the repository.
    expect(builder).toContain("from: ../../LICENSE\n");
    expect(builder).toContain("to: LICENSE\n");
    expect(builder).toMatch(/^ {2}license: \.\.\/\.\.\/LICENSE$/m);
    expect(existsSync(join(repoRoot, "LICENSE"))).toBe(true);
  });

  it("keeps the attribution in the file NOTICE is generated from", () => {
    // `third-party-notice.mjs` writes NOTICE as notice-header.md
    // followed by the bundled-components table it reads out of a packed
    // build. Anything added to NOTICE by hand is silently gone at the
    // next regeneration — which for an attribution notice is the whole
    // failure mode. This is what proves it lives in the header instead.
    expect(notice.startsWith(header.trimEnd())).toBe(true);
  });
});
