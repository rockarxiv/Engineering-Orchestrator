import { z } from "zod";
import { MemoryUsedSchema } from "../memory.js";

/**
 * What the implementer returns (ARCHITECTURE.md, "Verification, review and the pull request").
 *
 * Every field here is a *claim*, and every one of them is independently
 * checkable — does the branch exist, are there commits, does the suite
 * pass. G-02 does that checking. Per the original design's rule ("never accept 'I'm
 * done' from the implementer"), passing this schema is necessary but
 * not sufficient to move an item.
 */
export const ImplementOutputSchema = z.object({
  branch: z.string().min(1),
  summary: z.string(),
  files_changed: z.array(z.string()).default([]),
  tests_run: z.boolean().default(false),
  /**
   * What the next person needs to know, in the implementer's own words
   * (KAN-31).
   *
   * `summary` is a claim addressed to the engine, and G-02 checks it.
   * This is addressed to a human and to the reviewer, and says the
   * things a diff cannot: what was considered and rejected, what is
   * deliberately left out, where to look first.
   *
   * It exists because the implementer was the one role that left nothing
   * in the thread. A real run spent 40¢ producing a careful account of
   * its work — which files, which API, why it built on what was there —
   * and that account went into `runs.result` and no further, because
   * assembled context reads same-item *comments*, not same-item run
   * results. The reviewer reviewed the diff having never read it.
   *
   * Required, not defaulted. `io: "input"` makes a defaulted field
   * optional for the model, and an optional field is one that will be
   * omitted on exactly the runs where it would have mattered.
   */
  handoff: z.string().min(1),
  /**
   * The memory entries the run relied on, by id (EO-597). Optional, and
   * held to what the run was given: an id it was not delivered is dropped
   * and recorded as dropped (`memory/memoryUse.ts`).
   */
  memoryUsed: MemoryUsedSchema,
});

export type ImplementOutput = z.infer<typeof ImplementOutputSchema>;
