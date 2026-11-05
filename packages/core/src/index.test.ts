import { describe, expect, it } from "vitest";
import type { Uuid } from "./index.js";

describe("@eo/core", () => {
  it("exports the Uuid type", () => {
    const id = "018f8f5e-0000-7000-8000-000000000000" as Uuid;
    expect(typeof id).toBe("string");
  });
});
