import type { AgentCliTool } from "@eo/core";
import { oneLine, withSkillsSection } from "./skillsPrompt.js";

/**
 * The "## Command-line tools" section a turn that opens a thread starts
 * with, on either backend (EO-820).
 *
 * One function and one wording for both, as the Skills section beside it
 * is (invariant 12): a capability worded per adapter is one that drifts
 * on one of them while its tests pass. Only the CLIs EO found installed
 * at dispatch are named, each with what a person said it is for, where it
 * resolved and what version answered — so the agent is told what it can
 * run, not what somebody once meant to install.
 *
 * Information, not a grant (invariant 11): nothing here, and nothing an
 * adapter does with it, reaches `allowedTools` or a sandbox. The agent
 * runs the program through the shell it already has.
 */
export function cliToolsPromptSection(tools: readonly AgentCliTool[]): string {
  if (tools.length === 0) return "";
  return [
    "## Command-line tools",
    "",
    "These command-line tools are installed on this machine.",
    "You may run them through your shell when they fit what you are doing:",
    "",
    ...tools.map(cliToolLine),
  ].join("\n");
}

/**
 * One bullet. The description is a person's free text, and a newline in
 * it would end the bullet and turn the rest into prose read as
 * instructions — so it is collapsed, as a skill's is.
 */
function cliToolLine(tool: AgentCliTool): string {
  const description = oneLine(tool.description);
  const version = tool.version === null ? "" : oneLine(tool.version);
  return `- \`${tool.command}\`${description ? ` — ${description}` : ""} (\`${tool.path}\`${version ? `, ${version}` : ""})`;
}

/**
 * The prompt a turn that opens a thread sends: its context, the Skills
 * section when there is one, then the Command-line tools section when
 * there is one. One function for both adapters and for debug mode's
 * record of what they sent, so the three cannot disagree.
 */
export function openingPrompt(context: string, skillsSection: string, cliTools: readonly AgentCliTool[] | undefined): string {
  return withSkillsSection(withSkillsSection(context, skillsSection), cliToolsPromptSection(cliTools ?? []));
}

/**
 * What the item is told about a CLI its agent was given and EO did not
 * find at dispatch (EO-820, invariant 8): which one, that it is missing
 * here, and that the run did not wait for it.
 */
export function missingCliToolNotice(tool: { name: string; command: string }, agentName: string): string {
  return `The command-line tool ${tool.name} (\`${tool.command}\`), attached to ${agentName}, was not found on this machine, so this run went ahead without it.`;
}
