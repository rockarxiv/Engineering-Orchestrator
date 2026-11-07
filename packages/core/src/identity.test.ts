import { describe, expect, it } from "vitest";
import { invitationLinkFrom, invitationPath } from "./identity.js";

/** A pasted invitation link, read in first run (EO-661). */
describe("invitationLinkFrom", () => {
  it("splits a server's invitation link into its address and code", () => {
    expect(invitationLinkFrom(` https://eo.acme.com${invitationPath("a1b2")} `)).toEqual({ address: "https://eo.acme.com", code: "a1b2" });
    expect(invitationLinkFrom("http://localhost:4100/invite/xyz?from=mail")).toEqual({ address: "http://localhost:4100", code: "xyz" });
  });

  it("is null for anything that is not one", () => {
    for (const link of ["", "eo.acme.com/invite/a1b2", "https://eo.acme.com", "https://eo.acme.com/invite/", "https://eo.acme.com/project", "ftp://eo.acme.com/invite/a1b2", "https://eo.acme.com/invite/a/b", "https://user@eo.acme.com/invite/a1b2"]) {
      expect(invitationLinkFrom(link)).toBeNull();
    }
  });

  /** What a browser normalises away: these reach the server's root, not an invitation (EO-661 review). */
  it("is null for a code a browser would resolve away as a dot segment or a backslash", () => {
    for (const link of [
      "https://eo.acme.com/invite/..",
      "https://eo.acme.com/invite/.",
      "https://eo.acme.com/invite/%2e%2e",
      "https://eo.acme.com/invite/%2E%2e",
      "https://eo.acme.com/invite/.%2e",
      "https://eo.acme.com/invite/%2e",
      "https://eo.acme.com/invite/a1b2\\..",
      "https://eo.acme.com/invite/a1b2%5c..",
      "https://eo.acme.com\\invite/a1b2",
    ]) {
      expect(invitationLinkFrom(link)).toBeNull();
    }
  });
});
