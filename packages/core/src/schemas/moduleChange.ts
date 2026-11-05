import { z } from "zod";
import { ModuleManifestSchema, ModuleTestCaseInputSchema } from "./modules.js";

/**
 * A change to a module that already exists, **proposed and never
 * applied** (EO-356, EO-418).
 *
 * One shape for both chats that can raise one — a module's scenario
 * chat and the help chat — because it becomes one card either way: a
 * diff of the code, a diff of the manifest, and an Apply button a person
 * presses. Nothing is saved by returning it.
 *
 * Whole documents, never fragments. `code` is the module's whole code as
 * it would be, and `manifest` its whole manifest as it would be: what is
 * applied is exactly what the card shows, and a patch would be a second
 * thing to get wrong between the two.
 *
 * `manifest` is **null rather than absent** for "leave the manifest as
 * it is", for the reason `ScenarioOutputSchema` gives (invariant #12):
 * Codex is held to a strict subset where every property is required, so
 * an optional manifest would be one the model has to write on every
 * change, and a manifest restated from memory is a manifest that can
 * drift. Nullable with a default lets Claude leave the key out and Codex
 * write `null`, and both mean the same thing. The stored manifest is
 * what a run enforces — which binaries and environment variables the
 * module is given — so a fix to `needs`, `inputs` or `results` is a fix
 * only this field can carry.
 */
export const ModuleChangeSchema = z.object({
  /** What the change does and why, in a sentence or two — it sits above the diff. */
  summary: z.string().min(1),
  /** The module's whole code as it would be after the change. Never a fragment: what is applied is what is shown. */
  code: z.string().min(1),
  /**
   * The module's whole manifest as it would be after the change. Null
   * leaves the manifest exactly as it is saved.
   *
   * Held to `ModuleManifestSchema` here, whole — every field, nested
   * values included — as a proposed module's manifest is. A manifest
   * that fails it fails the reply, and a reply that fails its schema is
   * sent straight back to the agent with the message, so the next
   * attempt can put it right. That is where the refusal is useful: a
   * rejection posted into the thread would be read by the person, who
   * did not write the manifest, and not by the agent, who did
   * (`ProposedModuleSchema` makes the same call about test cases). So a
   * change that reaches a card always carries a valid manifest or none.
   */
  manifest: ModuleManifestSchema.nullable().default(null),
});

/**
 * A change raised in the help chat (EO-418).
 *
 * The scenario chat's room is about one module, so its change needs no
 * address. The help chat is about whatever is in front of the person, so
 * its change says which module it is for — by id, the one name that
 * cannot be confused with a slug somebody is about to propose under.
 *
 * `tests` are the cases the change adds or replaces, written when the
 * person applies it and not before, in the same write as the code. They
 * are matched by `description`, as a corrected module's are (EO-401): a
 * description the module already has replaces that case, a new one is
 * added, and a case not listed is kept. Empty, the module's cases stay
 * exactly as they are. Defaulted rather than optional for the reason
 * `manifest` is nullable: an empty list is something both backends can
 * write.
 *
 * `removeTests` are the cases the change deletes, by the id
 * `module_tests_list` gives (EO-499) — an id rather than a description,
 * because two cases can share a description and a removal has to say
 * which one. Deleted on Apply in the same write as everything else, and
 * defaulted to empty like `tests`, so a change can be removals alone:
 * the code exactly as saved, a null manifest, no `tests`.
 */
export const AssistModuleChangeSchema = ModuleChangeSchema.extend({
  /** The id of the module this changes, as the catalog gives it. Never a slug. */
  moduleId: z.string().min(1),
  /** Test cases to add or replace on Apply, matched by description. */
  tests: z.array(ModuleTestCaseInputSchema).default([]),
  /** Ids of the module's test cases to delete on Apply, as `module_tests_list` gives them. */
  removeTests: z.array(z.string().min(1)).default([]),
});

export type ModuleChange = z.infer<typeof ModuleChangeSchema>;
export type AssistModuleChange = z.infer<typeof AssistModuleChangeSchema>;

/**
 * What a message that is a module-change card in the help chat says
 * about itself (EO-418) — see `DiscussionMessage.moduleChange`.
 */
export const ModuleChangeCardSchema = z.object({
  /** The module the change is for. The card reads its name and approval from the catalog by this. */
  moduleId: z.string(),
  /** True once a person pressed Apply and the change was saved. */
  applied: z.boolean(),
  /**
   * True while the catalog's module still holds the code and manifest
   * this card saved. Approve on the card approves whatever the catalog
   * holds, so it is offered only while that is what the card showed.
   */
  describesSaved: z.boolean(),
});

export type ModuleChangeCard = z.infer<typeof ModuleChangeCardSchema>;
