import { z } from "zod";

/**
 * The tools an assistant or scenario turn prepares a change to an
 * existing module with (EO-813), so that its answer can name the change
 * by id instead of restating the whole module and its tests.
 *
 *   * `module_change_prepare` stages the module as it is saved — its
 *     code, its manifest and, in the assistant's chat, its test cases —
 *     as files in a directory EO owns, and answers with a staging id.
 *   * `module_change_edit` changes one staged file, by exact text
 *     replacement or by whole content, so a turn with no file tools and
 *     no checkout can still edit what it staged without restating it.
 *   * `module_change_freeze` reads the staged files, holds them to the
 *     rules a module-change card is held to, and keeps the result in
 *     EO's database as an immutable proposal, answering with its id.
 *
 * None of them saves, approves or tests the module: what is frozen is
 * applied only when a person presses Apply on the card.
 *
 * Through the agent write bridge (`agent-writes.ts`), because the main
 * process is what knows which run is asking, on which conversation, and
 * where its staging area is. Named here for the reason
 * `REPOSITORY_CHECKOUT_TOOL_NAME` is: the server lists them, the bridge
 * takes them and the supervisor answers them.
 */
export const MODULE_CHANGE_PREPARE_TOOL_NAME = "module_change_prepare";
export const MODULE_CHANGE_EDIT_TOOL_NAME = "module_change_edit";
export const MODULE_CHANGE_FREEZE_TOOL_NAME = "module_change_freeze";

/** Every module-change tool, in the order the `eo` server lists them. */
export const MODULE_CHANGE_TOOLS = [MODULE_CHANGE_PREPARE_TOOL_NAME, MODULE_CHANGE_EDIT_TOOL_NAME, MODULE_CHANGE_FREEZE_TOOL_NAME] as const;
export type ModuleChangeTool = (typeof MODULE_CHANGE_TOOLS)[number];

/**
 * What each tool takes. Strict, so an argument a tool does not name is a
 * refused call rather than an ignored field.
 */
export const ModuleChangePrepareArgsSchema = z.strictObject({
  /** The module to change, by the id the catalog gives. A scenario chat may leave it out: its module is the chat's own. */
  moduleId: z.string().trim().min(1).optional(),
});
export type ModuleChangePrepareArgs = z.infer<typeof ModuleChangePrepareArgsSchema>;

export const ModuleChangeEditArgsSchema = z
  .strictObject({
    stagingId: z.string().trim().min(1),
    /** A path relative to the staging directory, as `module_change_prepare` names it. */
    file: z.string().trim().min(1),
    /** Exact replacements, applied in order; each `old_text` must occur exactly once in the text the edits before it left. */
    edits: z.array(z.strictObject({ old_text: z.string().min(1), new_text: z.string() })).min(1).optional(),
    /** The file's whole new content, instead of `edits`. */
    content: z.string().optional(),
  })
  .refine((args) => (args.edits === undefined) !== (args.content === undefined), { message: "Give either `edits` or `content`, not both." });
export type ModuleChangeEditArgs = z.infer<typeof ModuleChangeEditArgsSchema>;

export const ModuleChangeFreezeArgsSchema = z.strictObject({
  stagingId: z.string().trim().min(1),
  /** What the change does and why, in a sentence or two. */
  summary: z.string().trim().min(1),
  /**
   * Test cases to add or replace on Apply, matched by description — the
   * assistant's chat only. Each carries its `source`, or names a `file` in
   * the staging directory holding it.
   */
  tests: z
    .array(
      z
        .strictObject({ description: z.string().trim().min(1), source: z.string().min(1).optional(), file: z.string().trim().min(1).optional() })
        .refine((test) => (test.source === undefined) !== (test.file === undefined), { message: "Each test gives either `source` or `file`." }),
    )
    .default([]),
  /** Ids of the module's test cases to delete on Apply — the assistant's chat only. */
  removeTests: z.array(z.string().trim().min(1)).default([]),
});
export type ModuleChangeFreezeArgs = z.infer<typeof ModuleChangeFreezeArgsSchema>;
