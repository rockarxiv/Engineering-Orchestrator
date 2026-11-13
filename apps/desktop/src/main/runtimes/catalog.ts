/**
 * Which agent runtimes EO knows how to fetch (A-08).
 *
 * EO does not ship these. The Claude CLI is "© Anthropic PBC. All rights
 * reserved" with no redistribution grant, so bundling it inside a
 * product would be redistributing someone else's binary; fetching it on
 * request puts the user's machine in touch with Anthropic's own
 * distribution under Anthropic's own terms, which is the arrangement
 * every IDE that downloads a driver relies on. Codex is Apache-2.0 and
 * could be shipped, but it takes the same path — one mechanism is
 * easier to reason about than two, and it keeps ~90 MB out of the
 * installer as well.
 */

export type RuntimeId = "claude" | "codex";

export interface RuntimeSpec {
  id: RuntimeId;
  /** What to call it in front of a person. */
  label: string;
  publisher: string;
  /** Where the terms the user is agreeing to actually live. */
  termsUrl: string;
  /**
   * Pinned, never `latest`.
   *
   * A version bump arrives with an EO release, having been tested. Left
   * floating, a breaking change in someone else's CLI lands on every
   * user at once and the first EO hears of it is a bug report.
   */
  version: string;
  /** npm package for a platform, or null where that platform is unsupported. */
  packageFor(platform: NodeJS.Platform, arch: string): string | null;
  /**
   * The executable's *name*, searched for in the extracted tree.
   *
   * Deliberately not a path: Codex buries its binary under
   * `vendor/<target-triple>/bin/`, and encoding six Rust target triples
   * would be six things to get wrong every time one changes.
   */
  binaryName(platform: NodeJS.Platform): string;
}

/** npm's platform suffix convention, shared by both SDKs. */
function suffix(platform: NodeJS.Platform, arch: string): string | null {
  const os = platform === "win32" ? "win32" : platform === "darwin" ? "darwin" : platform === "linux" ? "linux" : null;
  const cpu = arch === "x64" ? "x64" : arch === "arm64" ? "arm64" : null;
  return os && cpu ? `${os}-${cpu}` : null;
}

export const RUNTIMES: Record<RuntimeId, RuntimeSpec> = {
  claude: {
    id: "claude",
    label: "Claude Code",
    publisher: "Anthropic PBC",
    termsUrl: "https://code.claude.com/docs/en/legal-and-compliance",
    version: "0.3.322",
    packageFor: (platform, arch) => {
      const platformSuffix = suffix(platform, arch);
      return platformSuffix ? `@anthropic-ai/claude-agent-sdk-${platformSuffix}` : null;
    },
    binaryName: (platform) => (platform === "win32" ? "claude.exe" : "claude"),
  },
  codex: {
    id: "codex",
    label: "Codex",
    publisher: "OpenAI",
    termsUrl: "https://github.com/openai/codex/blob/main/LICENSE",
    version: "0.167.1",
    // Codex publishes its platform builds as *versions* of one package
    // rather than as separate packages: @openai/codex@0.167.1-linux-x64.
    packageFor: (platform, arch) => (suffix(platform, arch) ? "@openai/codex" : null),
    binaryName: (platform) => (platform === "win32" ? "codex.exe" : "codex"),
  },
};

/** The exact version to request, which for Codex encodes the platform. */
export function versionFor(spec: RuntimeSpec, platform: NodeJS.Platform, arch: string): string | null {
  const platformSuffix = suffix(platform, arch);
  if (!platformSuffix) return null;
  return spec.id === "codex" ? `${spec.version}-${platformSuffix}` : spec.version;
}
