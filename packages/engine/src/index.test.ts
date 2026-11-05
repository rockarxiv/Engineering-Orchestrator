import { describe, expect, it } from "vitest";
import type { Uuid } from "@eo/core";
import { isSameId } from "./index.js";

describe("@eo/engine", () => {
  it("compares ids", () => {
    const a = "018f8f5e-0000-7000-8000-000000000000" as Uuid;
    const b = "018f8f5e-0000-7000-8000-000000000001" as Uuid;
    expect(isSameId(a, a)).toBe(true);
    expect(isSameId(a, b)).toBe(false);
  });
});
