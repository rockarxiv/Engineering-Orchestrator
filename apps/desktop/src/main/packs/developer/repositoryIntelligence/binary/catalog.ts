/**
 * Which CodeWiki build EO knows how to fetch (A-08).
 *
 * EO ships no third-party binaries, so repository intelligence gets the
 * same treatment the agent CLIs get in `main/runtimes/`: fetched on
 * request, pinned, and verified before it touches the disk.
 *
 * This is deliberately *not* an entry in `RUNTIMES`. CodeWiki is not an
 * agent runtime — nobody signs into it, it has no models, and it must
 * never appear on the Runtimes settings screen next to Claude and
 * Codex. Same mechanism, separate catalogue.
 *
 * The one thing that genuinely differs is distribution. The runtimes
 * come from npm, which hands out `dist.integrity` for free; CodeWiki
 * publishes to GitHub Releases, where the integrity story is a
 * `<asset>.sha256` file uploaded beside each archive. `install.ts`
 * fetches that file and checks it, for exactly the reason
 * `runtimes/install.ts` checks npm's hash.
 */

export type CodeWikiId = "codewiki";

export interface CodeWikiSpec {
  id: CodeWikiId;
  /** What to call it in front of a person. */
  label: string;
  publisher: string;
  /** Where the terms the user is agreeing to actually live. */
  termsUrl: string;
  /** `owner/repo` — GitHub Releases is the only place these builds exist. */
  repository: string;
  /**
   * Pinned, never `latest`.
   *
   * A version bump arrives with an EO release, having been tested. The
   * runtimes catalogue makes this argument at length and it applies
   * unchanged here: left floating, someone else's breaking change lands
   * on every user at once and the first EO hears of it is a bug report.
   */
  version: string;
  /** The published asset for a platform, or null where upstream ships none. */
  assetFor(platform: NodeJS.Platform, arch: string): string | null;
  /** The executable's name inside the archive. */
  binaryName(platform: NodeJS.Platform): string;
}

/**
 * v0.2.1's release assets, by `<platform>-<arch>`.
 *
 * Written out rather than assembled from a target-triple template.
 * Upstream's four names share no scheme worth deriving — `x86_64` here,
 * `aarch64` there, `.zip` on Windows and `.tar.gz` everywhere else — and
 * a wrong guess is a 404 at install time rather than a type error now.
 *
 * `darwin-x64` is absent on purpose and is not an oversight to paper
 * over: upstream publishes no Intel Mac build at all. Resolution says so
 * in words, and the rest of the feature degrades around it.
 */
const ASSETS: Record<string, string> = {
  "linux-x64": "codewiki-x86_64-unknown-linux-gnu.tar.gz",
  "linux-arm64": "codewiki-aarch64-unknown-linux-gnu.tar.gz",
  "darwin-arm64": "codewiki-aarch64-apple-darwin.tar.gz",
  "win32-x64": "codewiki-x86_64-pc-windows-msvc.zip",
};

export const CODEWIKI: CodeWikiSpec = {
  id: "codewiki",
  label: "CodeWiki",
  publisher: "0xsyncroot",
  termsUrl: "https://github.com/0xsyncroot/codewiki/blob/main/LICENSE",
  repository: "0xsyncroot/codewiki",
  version: "0.2.1",
  assetFor: (platform, arch) => ASSETS[`${platform}-${arch}`] ?? null,
  binaryName: (platform) => (platform === "win32" ? "codewiki.exe" : "codewiki"),
};

/** The git tag the release lives under: `v0.2.1`, and never a moving one. */
export function releaseTag(spec: CodeWikiSpec): string {
  return `v${spec.version}`;
}

/** Where one asset of the pinned release is downloaded from. */
export function assetUrl(spec: CodeWikiSpec, asset: string): string {
  return `https://github.com/${spec.repository}/releases/download/${releaseTag(spec)}/${asset}`;
}

/** The digest published beside it — this feature's substitute for npm's `dist.integrity`. */
export function checksumUrl(spec: CodeWikiSpec, asset: string): string {
  return `${assetUrl(spec, asset)}.sha256`;
}

const PLATFORM_NAMES: Record<string, string> = { linux: "Linux", darwin: "macOS", win32: "Windows" };

/**
 * Why this machine gets nothing, in words meant for a person.
 *
 * Carried rather than logged: a missing build is a normal outcome that
 * the caller degrades around, and "repository intelligence is off" with
 * no explanation is the thing this string exists to prevent. Intel Macs
 * are the case that actually happens, so they are named as such rather
 * than left as a target triple.
 */
export function unsupportedReason(spec: CodeWikiSpec, platform: NodeJS.Platform, arch: string): string {
  const machine = platform === "darwin" && arch === "x64" ? "Intel Macs" : `${PLATFORM_NAMES[platform] ?? platform} ${arch}`;
  return `${spec.label} ${spec.version} publishes no build for ${machine} (${platform} ${arch}), so repository intelligence is unavailable on this machine.`;
}
