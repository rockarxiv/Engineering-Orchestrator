import { describe, expect, it } from "vitest";
import { createSignInThrottle } from "./signInThrottle.js";

/**
 * How often one caller may try the front door (EO-323, ARCHITECTURE.md, "Identity").
 *
 * The two channels a request reaches without a token are the two an
 * unauthenticated stranger may call as often as they like, and scrypt
 * makes each attempt a hundred milliseconds of this process's CPU. This
 * is the bound on that, and the tests are about what it actually claims
 * — see the module comment for what it deliberately does not.
 */
describe("the sign-in throttle", () => {
  it("lets a person mistype their password, and stops a search", () => {
    const throttle = createSignInThrottle(3, 60_000);

    expect([1, 2, 3].map(() => throttle.allow("192.0.2.7", 1_000))).toEqual([true, true, true]);
    expect(throttle.allow("192.0.2.7", 1_000)).toBe(false);
  });

  it("counts attempts rather than failures, per address", () => {
    const throttle = createSignInThrottle(2, 60_000);
    throttle.allow("192.0.2.7", 1_000);
    throttle.allow("192.0.2.7", 1_000);

    expect(throttle.allow("192.0.2.7", 1_000)).toBe(false);
    // Somebody else at the office is not locked out by them.
    expect(throttle.allow("192.0.2.8", 1_000)).toBe(true);
  });

  it("forgives, so a locked-out person is not stuck", () => {
    const throttle = createSignInThrottle(1, 60_000);
    throttle.allow("192.0.2.7", 1_000);

    expect(throttle.allow("192.0.2.7", 30_000)).toBe(false);
    expect(throttle.allow("192.0.2.7", 61_001)).toBe(true);
  });
});
