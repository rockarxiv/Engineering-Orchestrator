import { agentSandboxed, type IpcPayload, type IpcResponse, type SandboxAvailability, type Uuid } from "@eo/core";
import type { Db } from "../db/client.js";
import { getAgent } from "../db/repos/index.js";
import { sandboxAvailability } from "../providers/sandboxAvailability.js";
import { saveAgent, setAgentBinding } from "./configCommands.js";
import { dispatchedRuntimePath, type Machine, type RuntimeContext } from "./runtimeCommands.js";

/** Whether a backend's sandbox can start, asked of one binary. `providers/sandboxAvailability.ts` on the real machine. */
export type SandboxCheck = (provider: string, executablePath: string | null) => Promise<SandboxAvailability | null>;

/**
 * Whether this backend's sandbox can start on this machine, for the
 * agent editor (EO-935): asked of the binary dispatch would run for the
 * agent — its own `executablePath` when it names one, EO's managed copy
 * otherwise — so the answer is about the copy that would be sandboxed.
 */
export async function sandboxStatus(
  context: RuntimeContext,
  payload: IpcPayload<"providers:sandbox">,
  check: SandboxCheck = sandboxAvailability,
  machine: Machine = {},
): Promise<IpcResponse<"providers:sandbox">> {
  return { sandbox: await check(payload.provider, dispatchedRuntimePath(context, payload, machine)) };
}

/**
 * Why this save may not turn the agent's sandbox on, or null (EO-935).
 *
 * Asked only of a save that turns it on for a binary it was not already
 * on for — off to on, or on and moved to another backend or executable —
 * so an agent that is already sandboxed can still be edited, and turned
 * off, on a machine that cannot sandbox it. The run is refused there
 * anyway; this is the setting saying so where it is chosen, in the
 * editor and through `agent_save` alike, which reach the same handler.
 */
export async function sandboxSaveRefusal(
  db: Db,
  context: RuntimeContext,
  input: IpcPayload<"agents:save">,
  check: SandboxCheck = sandboxAvailability,
  machine: Machine = {},
): Promise<string | null> {
  const existing = input.id === undefined ? undefined : getAgent(db, input.id as Uuid);
  // Absent leaves what is stored (EO-185), which is what the row will hold.
  const config = input.config ?? existing?.config ?? {};
  if (!agentSandboxed({ config })) return null;
  const executable = executablePathIn(config);
  const already =
    existing !== undefined && agentSandboxed(existing) && existing.provider === input.provider && executablePathIn(existing.config) === executable;
  if (already) return null;

  const answer = await check(input.provider, dispatchedRuntimePath(context, { provider: input.provider, executablePath: executable }, machine));
  if (answer === null || answer.available) return null;
  return (
    `This machine cannot start the "${input.provider}" sandbox, so EO did not turn the sandbox on for ${input.name}: ${answer.reason} ${answer.fix} ` +
    "Nothing was saved. Save without `sandboxed` to keep the agent unsandboxed."
  );
}

/**
 * `agents:setBinding`, refused where it would move a sandboxed agent onto
 * a backend whose sandbox this machine cannot start (EO-935) — the second
 * door onto `agents.provider`, which `setAgentBinding` already treats as
 * one for the organisation's policy — and `setAgentBinding` otherwise.
 */
export async function setAgentBindingChecked(
  db: Db,
  context: RuntimeContext,
  input: IpcPayload<"agents:setBinding">,
  check: SandboxCheck = sandboxAvailability,
  machine: Machine = {},
): Promise<IpcResponse<"agents:setBinding">> {
  const agent = getAgent(db, input.agentId as Uuid);
  if (agent !== undefined && agentSandboxed(agent) && agent.provider !== input.provider) {
    const answer = await check(input.provider, dispatchedRuntimePath(context, { provider: input.provider, executablePath: executablePathIn(agent.config) }, machine));
    if (answer !== null && !answer.available) {
      return {
        bound: false,
        problem: `${agent.name} runs sandboxed, and this machine cannot start the "${input.provider}" sandbox, so EO did not move it there: ${answer.reason} ${answer.fix} Nothing was changed.`,
      };
    }
  }
  return setAgentBinding(db, input);
}

/**
 * `agents:save`, refused where it would turn on a sandbox this machine
 * cannot start (EO-935), and `saveAgent` otherwise: the handler the
 * Agents editor and `agent_save` both reach.
 */
export async function saveAgentChecked(
  db: Db,
  context: RuntimeContext,
  input: IpcPayload<"agents:save">,
  check: SandboxCheck = sandboxAvailability,
  machine: Machine = {},
): Promise<IpcResponse<"agents:save">> {
  const refused = await sandboxSaveRefusal(db, context, input, check, machine);
  return refused === null ? saveAgent(db, input) : { saved: false, agent: null, problem: refused };
}

/** The agent's own executable, as dispatch reads it (`configuredExecutablePath` in engine.ts). */
function executablePathIn(config: Record<string, unknown>): string | null {
  const value = config["executablePath"];
  return typeof value === "string" && value.trim() !== "" ? value : null;
}
