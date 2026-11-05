import { describe, expect, it } from "vitest";
import { lastSeen } from "./people";

describe("when a device was last seen", () => {
  it("is words rather than a timestamp, and says so plainly when it has not been back", () => {
    const now = Date.UTC(2026, 0, 2, 12, 0, 0);

    expect(lastSeen(null, now)).toBe("not seen since it signed in");
    expect(lastSeen(now - 30_000, now)).toBe("last seen just now");
    expect(lastSeen(now - 60_000, now)).toBe("last seen 1 minute ago");
    expect(lastSeen(now - 90 * 60_000, now)).toBe("last seen 1 hour ago");
    expect(lastSeen(now - 50 * 60 * 60_000, now)).toBe("last seen 2 days ago");
  });
});
