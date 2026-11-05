import { describe, expect, it } from "vitest";
import { templateOriginLabel, templateUpdateAuthor, templateUpdatedLabel, templateUpdateOfAuthor, templateWaitingLabel } from "./templateStatus.js";

/** The words a pipeline's head says about its template (EO-536), and the author a template update files a version under (EO-532). */
describe("a pipeline's template words", () => {
  it("names the template and version it came from", () => {
    expect(templateOriginLabel({ title: "Software feature to merge", version: "4" })).toBe("From Software feature to merge v4");
  });

  it("says which version an update applied", () => {
    expect(templateUpdatedLabel({ version: "5" })).toBe("Updated to v5");
  });

  it("counts a held update's conflicts, and its problems where nothing conflicts", () => {
    expect(templateWaitingLabel({ conflicts: 1, problems: 0 })).toBe("Update waiting: 1 conflict");
    expect(templateWaitingLabel({ conflicts: 3, problems: 2 })).toBe("Update waiting: 3 conflicts");
    expect(templateWaitingLabel({ conflicts: 0, problems: 2 })).toBe("Update waiting: 2 problems");
  });
});

describe("a template update's author", () => {
  it("reads back what it writes", () => {
    expect(templateUpdateOfAuthor(templateUpdateAuthor("software-feature-to-merge", "1.1"))).toEqual({ slug: "software-feature-to-merge", version: "1.1" });
  });

  it("is nothing for a person's version or EO's own", () => {
    expect(templateUpdateOfAuthor("0190-person")).toBeNull();
    expect(templateUpdateOfAuthor(null)).toBeNull();
  });

  it("names no version where the author carries none", () => {
    expect(templateUpdateOfAuthor("template:weekly-report")).toEqual({ slug: "weekly-report", version: null });
  });
});
