import { describe, expect, it } from "vitest";
import { featureIsDone, type FeatureProgress } from "./featureLifecycle.js";

/**
 * A feature's state is derived rather than stored (invariant #6's
 * reasoning applied to ARCHITECTURE.md, "One work entity"), which makes this two-line function the
 * whole of the answer to "is this feature finished". It had no test:
 * mutation testing found `total > 0` could become `total >= 0` with the
 * entire desktop suite still green.
 */
describe("whether a feature is finished", () => {
  const progress = (done: number, total: number): FeatureProgress => ({ done, total });

  it("is finished when every story under it is", () => {
    expect(featureIsDone(progress(3, 3))).toBe(true);
  });

  it("is not finished while a story is outstanding", () => {
    expect(featureIsDone(progress(2, 3))).toBe(false);
  });

  it("is not finished when it has no stories at all", () => {
    // The rule the docstring states, and the one nothing checked: with no
    // stories, `done === total` is trivially 0 === 0. A feature whose plan
    // nobody has approved yet has not started, rather than ended — and
    // calling it done would ship a container with nothing in it.
    expect(featureIsDone(progress(0, 0))).toBe(false);
  });
});
