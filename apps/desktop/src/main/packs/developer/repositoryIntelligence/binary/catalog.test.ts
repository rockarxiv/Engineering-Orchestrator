import { describe, expect, it } from "vitest";
import { RUNTIMES } from "../../../../runtimes/catalog.js";
import { assetUrl, checksumUrl, CODEWIKI, releaseTag, unsupportedReason } from "./catalog.js";

/**
 * The pinned CodeWiki release (A-08).
 *
 * Two things are being defended. The asset names are transcribed from
 * what upstream actually published for v0.2.1 — a typo here is a 404 on
 * a user's machine and nowhere else — and the pin itself, because a
 * floating tag turns someone else's release into an EO release.
 */

/** Exactly what GitHub lists under the v0.2.1 tag. */
const PUBLISHED: Array<[NodeJS.Platform, string, string]> = [
  ["linux", "x64", "codewiki-x86_64-unknown-linux-gnu.tar.gz"],
  ["linux", "arm64", "codewiki-aarch64-unknown-linux-gnu.tar.gz"],
  ["darwin", "arm64", "codewiki-aarch64-apple-darwin.tar.gz"],
  ["win32", "x64", "codewiki-x86_64-pc-windows-msvc.zip"],
];

describe("the catalogue", () => {
  it("maps every supported platform to the asset upstream published", () => {
    for (const [platform, arch, asset] of PUBLISHED) {
      expect(CODEWIKI.assetFor(platform, arch), `${platform} ${arch}`).toBe(asset);
    }
  });

  it("pins one version and never asks for a floating tag", () => {
    // The whole argument for pinning: a bump arrives with an EO
    // release, having been tested, rather than landing on every user at
    // once the moment upstream publishes.
    expect(CODEWIKI.version).toBe("0.2.1");
    expect(releaseTag(CODEWIKI)).toBe("v0.2.1");

    for (const [platform, arch] of PUBLISHED) {
      const asset = CODEWIKI.assetFor(platform, arch)!;
      for (const url of [assetUrl(CODEWIKI, asset), checksumUrl(CODEWIKI, asset)]) {
        expect(url).toContain("/releases/download/v0.2.1/");
        expect(url).not.toContain("latest");
      }
    }
  });

  it("asks for the digest published beside the archive, not one of its own", () => {
    const asset = CODEWIKI.assetFor("linux", "x64")!;

    expect(checksumUrl(CODEWIKI, asset)).toBe(`${assetUrl(CODEWIKI, asset)}.sha256`);
    expect(assetUrl(CODEWIKI, asset)).toBe("https://github.com/0xsyncroot/codewiki/releases/download/v0.2.1/codewiki-x86_64-unknown-linux-gnu.tar.gz");
  });

  it("names the executable the way each platform does", () => {
    expect(CODEWIKI.binaryName("linux")).toBe("codewiki");
    expect(CODEWIKI.binaryName("darwin")).toBe("codewiki");
    expect(CODEWIKI.binaryName("win32")).toBe("codewiki.exe");
  });
});

describe("machines upstream does not build for", () => {
  it("has nothing for an Intel Mac, and that is not an error to paper over", () => {
    // The case that actually happens. Upstream ships Apple Silicon
    // only, so this path is exercised by real people rather than being
    // a hypothetical branch.
    expect(CODEWIKI.assetFor("darwin", "x64")).toBeNull();

    const reason = unsupportedReason(CODEWIKI, "darwin", "x64");
    expect(reason).toContain("Intel Macs");
    expect(reason).toContain("darwin");
    expect(reason).toContain("x64");
  });

  it("returns null rather than a plausible-looking guess for anything else", () => {
    const unsupported: Array<[NodeJS.Platform, string]> = [
      ["darwin", "x64"],
      ["win32", "arm64"],
      ["win32", "ia32"],
      ["linux", "ia32"],
      ["linux", "ppc64"],
      ["freebsd" as NodeJS.Platform, "x64"],
      ["aix" as NodeJS.Platform, "ppc64"],
    ];

    for (const [platform, arch] of unsupported) {
      expect(CODEWIKI.assetFor(platform, arch), `${platform} ${arch}`).toBeNull();
      // Every one of them still has to be able to say why, in words —
      // repository intelligence degrades, and a caller has to have
      // something to put in front of a person.
      const reason = unsupportedReason(CODEWIKI, platform, arch);
      expect(reason, `${platform} ${arch}`).toContain(platform);
      expect(reason, `${platform} ${arch}`).toContain(arch);
      expect(reason, `${platform} ${arch}`).toContain("0.2.1");
    }
  });
});

describe("what a person can read before EO fetches on their behalf", () => {
  it("names the publisher and the terms, in the shape RUNTIMES uses", () => {
    // Not decoration. EO downloads this binary from somebody else's
    // release page, and these two fields are how the person doing the
    // downloading finds out whose terms that puts them under — the same
    // job they do for Anthropic and OpenAI in the runtimes catalogue.
    // Same field names deliberately: one shape for the consent screen
    // and the NOTICE table to be built from, rather than two.
    for (const field of ["label", "publisher", "termsUrl"] as const) {
      expect(typeof RUNTIMES.claude[field], `RUNTIMES.claude.${field}`).toBe("string");
      expect(typeof CODEWIKI[field], field).toBe("string");
      expect(CODEWIKI[field], field).not.toBe("");
    }

    // The publisher as upstream's own copyright line spells it, and a
    // URL that resolves to the licence rather than to a project page.
    expect(CODEWIKI.publisher).toBe("0xsyncroot");
    expect(CODEWIKI.termsUrl).toMatch(/^https:\/\/github\.com\/0xsyncroot\/codewiki\/.*LICENSE$/);
  });
});
