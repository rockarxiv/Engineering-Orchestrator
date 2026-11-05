import { describe, expect, it } from "vitest";
import { hashPassword, hashSecret, mintSecret, passwordMatches, secretMatches } from "./secrets.js";

/**
 * What is kept of the three secrets the front door deals in (EO-323,
 * ARCHITECTURE.md, "Identity").
 *
 * The property under every test here is the same one: a copy of this
 * database is a list of who, and never a way in as any of them.
 */
describe("a minted secret", () => {
  it("is 256 bits, and no two are the same", () => {
    const minted = Array.from({ length: 50 }, () => mintSecret());

    expect(new Set(minted).size).toBe(50);
    // base64url of 32 bytes, with no padding.
    for (const secret of minted) expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("is stored as a hash that does not carry it", () => {
    const token = mintSecret();

    expect(hashSecret(token)).not.toContain(token);
    expect(hashSecret(token)).toBe(hashSecret(token));
    expect(secretMatches(token, hashSecret(token))).toBe(true);
    expect(secretMatches(mintSecret(), hashSecret(token))).toBe(false);
  });

  it("matches nothing when there is no hash stored, rather than matching everything", () => {
    // The shape of the bug this rules out: a row with no token, and a
    // comparison that treats "" as "equal to whatever was presented".
    expect(secretMatches(mintSecret(), null)).toBe(false);
    expect(secretMatches(mintSecret(), "")).toBe(false);
  });
});

describe("a password", () => {
  it("is salted, so two people who chose the same one do not look alike", () => {
    const first = hashPassword("correct horse battery staple");
    const second = hashPassword("correct horse battery staple");

    expect(first).not.toBe(second);
    expect(passwordMatches("correct horse battery staple", first)).toBe(true);
    expect(passwordMatches("correct horse battery staple", second)).toBe(true);
  });

  it("is not in the stored form, in any encoding", () => {
    const stored = hashPassword("a memorable passphrase");

    expect(stored).not.toContain("a memorable passphrase");
    expect(Buffer.from(stored, "base64url").toString("utf8")).not.toContain("memorable");
  });

  it("refuses the wrong password, an absent hash and a hash this process cannot read", () => {
    const stored = hashPassword("a memorable passphrase");

    expect(passwordMatches("a memorable passphrasf", stored)).toBe(false);
    expect(passwordMatches("", stored)).toBe(false);
    expect(passwordMatches("anything", null)).toBe(false);
    // A row truncated by hand, or written by some future scheme. "No" is
    // the answer; a 500 on a sign-in screen is not.
    expect(passwordMatches("anything", "scrypt$")).toBe(false);
    expect(passwordMatches("anything", "argon2id$salt$key")).toBe(false);
    expect(passwordMatches("anything", "not a hash at all")).toBe(false);
  });
});
