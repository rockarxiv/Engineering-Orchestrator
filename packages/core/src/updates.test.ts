import { describe, expect, it } from "vitest";
import { ipcContract, ipcPushContract } from "./ipc.js";
import { UpdateStatusSchema } from "./updates.js";

describe("UpdateStatus", () => {
  it("accepts each state with the fields that state carries", () => {
    const states = [
      { state: "unsupported" },
      { state: "idle", lastCheckedAt: null },
      { state: "checking", lastCheckedAt: 1_700_000_000_000 },
      { state: "up-to-date", lastCheckedAt: 1_700_000_000_000 },
      { state: "available", version: "0.5.0", lastCheckedAt: 1_700_000_000_000 },
      { state: "downloading", percent: 42.5, lastCheckedAt: 1_700_000_000_000 },
      { state: "downloaded", version: "0.5.0", lastCheckedAt: 1_700_000_000_000 },
      { state: "error", message: "release server unreachable", lastCheckedAt: null },
    ];

    for (const state of states) expect(UpdateStatusSchema.safeParse(state).success).toBe(true);
  });

  it("hands on one state's worth of data and no more", () => {
    const parsed = UpdateStatusSchema.parse({ state: "available", version: "0.5.0", percent: 40, message: "boom", lastCheckedAt: 1 });

    // The reason this is a union rather than a bag of optional fields.
    // "Available and also downloading and also errored" is not a state EO
    // can be in, and whatever is handed in, what comes out the far side
    // is one state and one state only — a reader never sees `percent`
    // beside `message` beside `version`, so it can never forget to rule
    // that out.
    expect(parsed).toEqual({ state: "available", version: "0.5.0", lastCheckedAt: 1 });
  });

  it("refuses a state missing what that state is for", () => {
    expect(UpdateStatusSchema.safeParse({ state: "available", lastCheckedAt: 1 }).success).toBe(false);
    expect(UpdateStatusSchema.safeParse({ state: "downloaded", lastCheckedAt: 1 }).success).toBe(false);
    expect(UpdateStatusSchema.safeParse({ state: "error", lastCheckedAt: 1 }).success).toBe(false);
    // A percentage outside the range it is a percentage of.
    expect(UpdateStatusSchema.safeParse({ state: "downloading", percent: 140, lastCheckedAt: 1 }).success).toBe(false);
    // And a state nobody defined.
    expect(UpdateStatusSchema.safeParse({ state: "installing", lastCheckedAt: 1 }).success).toBe(false);
  });
});

describe("the updates channels", () => {
  it("validate the status on the way through, like everything else crossing the boundary", () => {
    for (const channel of ["updates:status", "updates:check", "updates:download"] as const) {
      // Not merely "a schema exists": the same one, so no channel can
      // drift into answering a shape the others would refuse.
      expect(ipcContract[channel].response).toBe(UpdateStatusSchema);
      expect(ipcContract[channel].response.safeParse({ state: "nonsense" }).success).toBe(false);
    }

    // Split from the three above so a download that fails cannot restart
    // the app: this one answers whether the restart was requested, never
    // a status a caller might act on.
    expect(ipcContract["updates:install"].response.safeParse({ requested: true }).success).toBe(true);
  });

  it("says only \"ask again\" when the status moves, carrying nothing", () => {
    // The contract's own rule, which `updates:progress` beside it is a
    // reasoned exception to. This one has a durable source to re-read —
    // the controller's own state, one `updates:status` call away — so
    // there is nothing for it to carry and no second copy to disagree.
    expect(Object.keys(ipcPushContract["updates:changed"].shape)).toEqual([]);
    expect(ipcPushContract["updates:changed"].safeParse({}).success).toBe(true);
  });

  it("pushes a percentage, and only a percentage", () => {
    const progress = ipcPushContract["updates:progress"];

    expect(progress.safeParse({ percent: 0 }).success).toBe(true);
    expect(progress.safeParse({ percent: 100 }).success).toBe(true);
    expect(progress.safeParse({ percent: -1 }).success).toBe(false);
    expect(progress.safeParse({ percent: 101 }).success).toBe(false);
  });
});
