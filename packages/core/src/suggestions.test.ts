import { describe, expect, it } from "vitest";
import { PIPELINE_EXPORT_VERSION, PipelineExportSchema, type PipelineExport } from "./schemas/pipelineExport.js";
import { SECTION_LOCKED_CHANNELS } from "./sections.js";
import {
  DIVERGED_EDITABLE_CHANNELS,
  divergedLine,
  documentGraph,
  editableWhenDiverged,
  suggestionDiff,
  SUGGESTION_RESULTS,
} from "./suggestions.js";
import type { VersionStep } from "./pipelineVersions.js";

/**
 * The words and the reading a suggestion is made of (EO-331,
 * `ARCHITECTURE.md`, "Divergence and suggestions").
 *
 * Pure, so it is tested here rather than through a database: what a
 * diverged pipeline says about itself, what a document looks like when
 * a diff reads it, and which door a diverged copy may still be written
 * through.
 */

const STEP = {
  id: "review",
  position: 1,
  name: "Review",
  type: "agent",
  ownerRole: "reviewer",
  entryAction: null,
  instructionsSummary: "Read it.",
  isTerminal: false,
  planMode: false,
  results: [],
};

function document(steps: unknown[]): PipelineExport {
  return PipelineExportSchema.parse({
    eoPipelineExport: PIPELINE_EXPORT_VERSION,
    pipeline: { name: "Delivery", icon: null, entryStepId: "review" },
    steps,
    routes: [],
  });
}

function version(steps: Partial<VersionStep>[]): { number: number; steps: VersionStep[]; routes: [] } {
  return {
    number: 6,
    steps: steps.map((step) => ({ ...(STEP as unknown as VersionStep), offBoard: false, ...step })),
    routes: [],
  };
}

describe("the line a diverged pipeline draws", () => {
  it("says what §9.4 says, in §9.4's order", () => {
    expect(divergedLine({ basedOn: 6, available: 7 })).toBe("Edited locally · based on v6 · v7 available");
  });

  it("does not announce an update that is not one", () => {
    // A person who diverged from the version still published is not
    // waiting for anything, and "v6 available" would be EO inventing
    // news about the copy they are looking at.
    expect(divergedLine({ basedOn: 6, available: 6 })).toBe("Edited locally · based on v6");
    expect(divergedLine({ basedOn: 6, available: null })).toBe("Edited locally · based on v6");
  });

  it("still says the one fact it always knows", () => {
    // A copy whose origin this machine cannot name — the version rows
    // have not arrived yet — is still a copy somebody edited, and that
    // is the half of the sentence the chip and the lock depend on.
    expect(divergedLine({ basedOn: null, available: null })).toBe("Edited locally");
    expect(divergedLine({ basedOn: null, available: 7 })).toBe("Edited locally · v7 available");
  });
});

describe("the document, as the diff reads it", () => {
  it("compares an export against a published version, field by field", () => {
    const diff = suggestionDiff({
      published: version([{ id: "review", name: "Review" }]),
      document: document([{ ...STEP, name: "Second opinion" }]),
    });

    expect(diff.steps).toEqual([
      { stepId: "review", name: "Second opinion", change: "changed", kind: { type: "agent", ownerRole: "reviewer", entryAction: null }, fields: [{ field: "name", before: "Review", after: "Second opinion" }] },
    ]);
  });

  it("heads the comparison with the version approving it would publish", () => {
    // "Approve publishes it as the next version" — so the diff an admin
    // reads is v6 → v7, not v6 → v6, which is what the heading would
    // have said about a document that is not a version at all.
    const diff = suggestionDiff({ published: version([{ id: "review" }]), document: document([STEP]) });

    expect(diff.from).toBe(6);
    expect(diff.to).toBe(7);
  });

  it("does not read an off-board step as one the suggestion removed", () => {
    // A version freezes the host step a conversation's runs hang from;
    // an export document carries none, on purpose. Compared as they
    // come, that step reads as *removed* by whoever suggested the
    // change — and applying the suggestion does not remove it, because
    // `applyDocument` passes off-board steps through untouched. A diff
    // that says otherwise is a diff that lies about what Approve does.
    const diff = suggestionDiff({
      published: version([
        { id: "review", name: "Review" },
        { id: "consult", name: "Consult", offBoard: true },
      ]),
      document: document([STEP]),
    });

    expect(diff.steps).toEqual([]);
  });

  it("reads every step of a document as on the board", () => {
    // `exportPipeline` filters off-board steps out, so a document never
    // carries one and "false" is the truth rather than a default picked
    // here. A diff that guessed otherwise would report a change to
    // every step of every suggestion.
    expect(documentGraph(document([STEP])).steps.every((step) => !step.offBoard)).toBe(true);
  });
});

describe("what a diverged copy may still be written through", () => {
  it("is one door, and one the section otherwise locks", () => {
    // The exception has to be *inside* the lock to be an exception at
    // all: a channel the pipelines section does not lock would be one
    // this list had no business naming, and the next reader would take
    // it for a second, wider rule.
    for (const channel of DIVERGED_EDITABLE_CHANNELS) {
      expect(SECTION_LOCKED_CHANNELS.pipelines).toContain(channel);
    }
    expect(DIVERGED_EDITABLE_CHANNELS).toEqual(["pipeline:save"]);
  });

  it("leaves everything else the section locks exactly as locked", () => {
    // Divergence is "this copy is mine", not "the section is open". A
    // person whose organisation manages pipelines still may not create
    // one, delete one, import a pack or approve a module.
    for (const channel of ["pipelines:create", "pipelines:delete", "pipelines:import", "gallery:use", "modules:approve"] as const) {
      expect(editableWhenDiverged(channel)).toBe(false);
    }
  });
});

describe("the one human step a suggestion waits on", () => {
  it("offers approve and send back, and asks why for the one that says no", () => {
    // The design's rule, and the whole reason a suggestion is an item: a
    // change refused with no words is an author told "no" by a screen.
    expect(SUGGESTION_RESULTS.map((result) => result.key)).toEqual(["approved", "changes"]);
    expect(SUGGESTION_RESULTS.find((result) => result.key === "changes")?.requiresComment).toBe(true);
    expect(SUGGESTION_RESULTS.find((result) => result.key === "approved")?.requiresComment).toBe(false);
  });
});
