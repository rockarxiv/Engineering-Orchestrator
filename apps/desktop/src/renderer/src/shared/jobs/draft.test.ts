import { JobViewSchema, type Job, type JobTrigger } from "@eo/core";
import { describe, expect, it } from "vitest";
import { draftOf, triggerOf } from "./draft";

/**
 * A trigger the Job page cannot edit is carried through it untouched
 * (EO-333 for a webhook, EO-753 for a watch): opening the page and
 * pressing Save after a rename must not turn it into "daily at 08:00".
 */

function jobWith(trigger: JobTrigger): Job {
  return JobViewSchema.parse({
    id: "01a1d000-0000-7000-8000-000000000001",
    projectId: null,
    name: "Open pull requests",
    trigger,
    pipelineId: "01a1d000-0000-7000-8000-000000000002",
    template: { type: "task", title: "Look at it", body: null },
    ownerId: "01a1d000-0000-7000-8000-000000000003",
    pausedAt: null,
    budgetPerOccurrenceCents: null,
    maxItemsPerHour: null,
    createdAt: 1,
    updatedAt: 1,
  });
}

describe("a watch job read into the form and saved again", () => {
  const watch: JobTrigger = { kind: "watch", moduleId: "pr-watch", inputs: { repo: "eo", draft: false }, everyMinutes: 30, waitWhileOpen: true };

  it("keeps its trigger exactly as it was", () => {
    const draft = draftOf(jobWith(watch));
    expect(draft.triggerKind).toBe("watch");
    expect(triggerOf({ ...draft, name: "Renamed" })).toEqual(watch);
  });

  it("does not share its inputs with the job the cache holds", () => {
    const job = jobWith(watch);
    const draft = draftOf(job);
    expect(draft.watch?.inputs).not.toBe(job.trigger.kind === "watch" ? job.trigger.inputs : undefined);
  });
});
