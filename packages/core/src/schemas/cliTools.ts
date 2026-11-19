import { z } from "zod";

/**
 * A command-line tool installed on the machine, as the third kind of
 * thing an agent can be given beside MCP servers and skills (EO-818,
 * EO-819).
 *
 * A row is information, not a grant: it tells an agent that a program
 * exists and what it is for in this installation, and the agent runs it
 * through the shell it already has. So nothing here reaches
 * `allowedTools` or a sandbox (invariant 11), and only a person writes
 * the catalogue.
 *
 * The row says nothing about whether the program is installed. That is
 * checked on this machine every time it matters (`cliTools:detect`, and
 * at dispatch), because the row's word for it would be wrong the first
 * time somebody uninstalled the program (invariant 5).
 */
export const CliToolSchema = z.object({
  /** UUIDv7, generated client-side. */
  id: z.string(),
  /** What a person reads in the catalogue — "GitHub CLI". */
  name: z.string(),
  /**
   * What an agent types — `gh`. A bare program name looked up on the
   * agent's PATH, or an absolute path to one. Unique in the catalogue.
   */
  command: z.string(),
  /** What it is and when to use it here, in a person's words. Empty where nobody has said. */
  description: z.string(),
  archivedAt: z.number().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

export type CliTool = z.infer<typeof CliToolSchema>;

/**
 * What the catalogue editor sends. Absent `id` creates; present edits
 * that row in place. The description is the person's, never a draft
 * saved on their behalf.
 */
export const CliToolDraftSchema = z.object({
  id: z.string().optional(),
  name: z.string(),
  command: z.string(),
  description: z.string().default(""),
});

export type CliToolDraft = z.input<typeof CliToolDraftSchema>;

/** Which CLIs one agent has been given, in catalogue order. */
export const AgentCliToolsSchema = z.object({
  agentId: z.string(),
  cliToolIds: z.array(z.string()),
});

export type AgentCliTools = z.infer<typeof AgentCliToolsSchema>;

/**
 * Whether a command is installed on this machine: found on the PATH an
 * agent is spawned with, with the absolute path it resolved to. Only
 * looked up — the program is not started (EO-858).
 */
export const CliToolDetectionSchema = z.discriminatedUnion("found", [
  z.object({ found: z.literal(true), path: z.string() }),
  z.object({ found: z.literal(false) }),
]);

export type CliToolDetection = z.infer<typeof CliToolDetectionSchema>;

/**
 * A suggested description, drafted from the program's own `--help`.
 * Empty — `description: ""` — when the program is not there, hangs or
 * says nothing usable. Never saved without a person.
 */
export const CliToolDescriptionDraftSchema = z.object({
  description: z.string(),
});

export type CliToolDescriptionDraft = z.infer<typeof CliToolDescriptionDraftSchema>;

/** How long a display name and a description may be. Generous; a prompt line is not a manual. */
export const CLI_TOOL_NAME_MAX = 80;
export const CLI_TOOL_DESCRIPTION_MAX = 500;

export type CliToolDraftResult =
  | { ok: true; name: string; command: string; description: string }
  | { ok: false; problems: string[] };

/**
 * A command EO will look up and run without a shell: one bare program
 * name, or an absolute path to one.
 *
 * A relative path with a separator in it is refused, because where it
 * points depends on the directory a run happens to start in, and a
 * catalogue entry has to mean one program wherever it is used. Spaces
 * are refused because there is no shell to split them: `gh pr` is a
 * command and an argument, and the row is for the command.
 */
export function cliToolCommandProblem(command: string): string | null {
  if (command === "") return "A command-line tool needs the command an agent types, like `gh`.";
  if (/\s/.test(command)) return `"${command}" has a space in it: enter only the program, like \`gh\`, not its arguments.`;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(command)) return "The command has a control character in it.";
  const absolute = command.startsWith("/") || /^[A-Za-z]:[\\/]/.test(command);
  if (!absolute && /[\\/]/.test(command)) return `"${command}" is a relative path: enter the program's name, like \`gh\`, or its absolute path.`;
  return null;
}

/**
 * Reads a draft into what may be written, or the sentences saying why
 * not. Pure, so the repository and the IPC command both apply it; it
 * refuses and never throws.
 */
export function readCliToolDraft(draft: CliToolDraft): CliToolDraftResult {
  const problems: string[] = [];
  const name = draft.name.trim();
  const command = draft.command.trim();
  const description = (draft.description ?? "").trim();

  if (name === "") problems.push("A command-line tool needs a name.");
  else if (name.length > CLI_TOOL_NAME_MAX) problems.push(`A name can be at most ${CLI_TOOL_NAME_MAX} characters.`);

  const commandProblem = cliToolCommandProblem(command);
  if (commandProblem !== null) problems.push(commandProblem);

  if (description.length > CLI_TOOL_DESCRIPTION_MAX) problems.push(`A description can be at most ${CLI_TOOL_DESCRIPTION_MAX} characters.`);

  return problems.length > 0 ? { ok: false, problems } : { ok: true, name, command, description };
}
