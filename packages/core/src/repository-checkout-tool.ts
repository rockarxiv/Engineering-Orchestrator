import { z } from "zod";

/**
 * The tool an agent asks for a read-only checkout of a branch of a
 * repository on its item's project with, mid-run (EO-633).
 *
 * Named here for the reason `ATTACHMENT_ADD_TOOL_NAME` is: the service
 * advertises it, the main process acts on it over the agent write bridge
 * (`agent-writes.ts`), the prompt names it and an `allowedTools` entry
 * permits it, and a literal in four places is one rename away from a tool
 * that is advertised and never acted on.
 *
 * Through the bridge although it writes nothing EO keeps: the `eo` server
 * opens EO's database read-only and has no way to the git kind, which is
 * the one thing that may make a reference checkout (EO-632).
 */
export const REPOSITORY_CHECKOUT_TOOL_NAME = "repository_checkout";

/**
 * What the tool takes: a repository on the item's project, by the name
 * the prompt lists it under, and a branch. Strict, so an argument the
 * tool does not name is a refused call rather than an ignored field.
 */
export const RepositoryCheckoutArgsSchema = z.strictObject({
  repository: z.string().trim().min(1),
  branch: z.string().trim().min(1),
});

export type RepositoryCheckoutArgs = z.infer<typeof RepositoryCheckoutArgsSchema>;
