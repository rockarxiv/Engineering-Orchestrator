import type { AgentProvider, AgentProviderResumeOptions, AgentProviderStartOptions, AgentSessionQuery, DebugSent, DebugSession } from "@eo/core";
import { withSkillsSection } from "../agentAttachments/skillsPrompt.js";

/**
 * Debug mode's capture: what a provider was handed, written down as it
 * is handed over (EO-392).
 *
 * **Above both adapters, and that is the point** (invariant 12). This
 * wraps an `AgentProvider` and knows nothing about which one: `start`,
 * `resume` and `fork` (the learning review's turn, EO-734) are recorded
 * from the very arguments the adapter is then called with, so the
 * recorded instructions and prompt are byte-for-byte what crossed the
 * provider boundary on either backend, and a third backend is captured
 * the day it implements the interface. Nothing is re-derived — re-assembling a context later would show what EO would
 * send now, not what it sent.
 *
 * What only an adapter can say — the model it resolves to, the sandbox
 * it pins, the servers it delivers — it says through
 * `describeSession`, asked here with the same options the turn gets.
 * The one thing an adapter adds to a new thread's prompt, its Skills
 * section (EO-602), it reports through `onSkillsSection` from inside
 * `start`, from the skills it actually delivered.
 *
 * **No secret passes through this file's output.** The options it reads
 * carry two places a value could hide, the repository server's `env`
 * and a fork's write-bridge credential, and neither is read: a server is
 * its name. The instructions and the prompt are recorded as sent, which
 * is what the window is for.
 */

/** What the caller knows about a send that the provider's arguments do not say. */
export interface SendContext {
  /** `runs.provider` for the run — the backend that is actually running it. */
  backend: string;
  purpose: DebugSent["purpose"];
  /** Why an existing thread was not carried on, when one was refused. Only meaningful on a `start`. */
  refusal: string | null;
  /**
   * The instructions a resumed thread was started with, when EO can
   * still say what they were. Only meaningful on a `resume`, which sends
   * none.
   */
  threadInstructions: string | null;
  /**
   * The name of the answer schema this turn may be held to — the
   * resolved one (`actionSchemaName`), which is not always the action's:
   * `refine` pointed at work somebody already wrote is held to `clarify`.
   * Recorded only when a schema is actually passed.
   */
  outputSchemaName: string;
}

function sessionOf(provider: AgentProvider, context: SendContext, turn: AgentSessionQuery & Pick<AgentProviderResumeOptions, "outputSchema" | "attachments">): DebugSession {
  const described = provider.describeSession?.({
    ...(turn.cwd !== undefined ? { cwd: turn.cwd } : {}),
    ...(turn.model !== undefined ? { model: turn.model } : {}),
    ...(turn.reasoningEffort !== undefined ? { reasoningEffort: turn.reasoningEffort } : {}),
    ...(turn.toolDirectory !== undefined ? { toolDirectory: turn.toolDirectory } : {}),
    ...(turn.repositoryMcp !== undefined ? { repositoryMcp: turn.repositoryMcp } : {}),
    ...(turn.skillScope !== undefined ? { skillScope: turn.skillScope } : {}),
    ...(turn.memoryScopes !== undefined ? { memoryScopes: turn.memoryScopes } : {}),
  });
  return {
    backend: context.backend,
    described: described !== undefined,
    instructionsSlot: described?.instructionsSlot ?? null,
    // Without a description, only what EO asked for — and no claim about
    // what the backend made of an absence.
    model: described ? described.model : (turn.model ?? null),
    reasoningEffort: described ? described.reasoningEffort : (turn.reasoningEffort ?? null),
    cwd: turn.cwd ?? null,
    policy: described?.policy ?? [],
    outputSchema: turn.outputSchema ? context.outputSchemaName : null,
    mcpServers: described?.mcpServers ?? (turn.repositoryMcp ? [turn.repositoryMcp.name] : []),
    allowedTools: described?.allowedTools ?? null,
    skills: described?.skills ?? [],
    inheritsAmbientConfig: described?.inheritsAmbientConfig ?? false,
    attachments: (turn.attachments ?? []).map((attachment) => attachment.name),
  };
}

/** What a `start` with these options sends, as debug mode records it — with the Skills section the adapter reported adding. */
export function sentOnStart(provider: AgentProvider, context: SendContext, opts: AgentProviderStartOptions, skillsSection = ""): DebugSent {
  return {
    purpose: context.purpose,
    thread: { mode: "new", threadId: null, refusal: context.refusal },
    instructions: { sent: true, text: opts.instructions },
    // Joined by the function the adapter joins it with.
    prompt: withSkillsSection(opts.context, skillsSection),
    session: sessionOf(provider, context, opts),
  };
}

/** What a `resume` of this thread with this message sends, as debug mode records it — with the Skills section the adapter reported adding (EO-721). */
export function sentOnResume(provider: AgentProvider, context: SendContext, threadId: string, message: string, opts: AgentProviderResumeOptions | undefined, skillsSection = ""): DebugSent {
  return {
    purpose: context.purpose,
    thread: { mode: "resumed", threadId, refusal: null },
    instructions: { sent: false, text: context.threadInstructions },
    prompt: withSkillsSection(message, skillsSection),
    session: sessionOf(provider, context, opts ?? {}),
  };
}

/**
 * What a `fork` of this thread with this message sends, as debug mode
 * records it (EO-734): the learning review's turn. Like a resume, no
 * instructions are sent — the copy keeps the ones the thread started
 * with — and the thread named is the one forked, since the copy's own id
 * is issued by the backend after this is written.
 */
export function sentOnFork(provider: AgentProvider, context: SendContext, threadId: string, message: string, opts: AgentProviderResumeOptions | undefined, skillsSection = ""): DebugSent {
  return {
    purpose: context.purpose,
    thread: { mode: "forked", threadId, refusal: null },
    instructions: { sent: false, text: context.threadInstructions },
    prompt: withSkillsSection(message, skillsSection),
    session: sessionOf(provider, context, opts ?? {}),
  };
}

/**
 * The same provider, with every send recorded on its way through.
 *
 * `record` is called with what the adapter was given — on a `start`,
 * once the adapter has said the Skills section it adds, which it does
 * before `start` returns, so the record still precedes every event. A
 * capture that fails says so on the console and the turn goes ahead: a
 * diagnostic instrument must not be the reason work stops.
 */
export function capturingProvider(provider: AgentProvider, context: SendContext, record: (sent: DebugSent) => void): AgentProvider {
  const capture = (describe: () => DebugSent): void => {
    try {
      record(describe());
    } catch (error) {
      console.warn(`[eo] debug mode could not record what was sent: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  return {
    start(opts) {
      let skillsSection = "";
      try {
        return provider.start({
          ...opts,
          onSkillsSection: (section) => {
            skillsSection = section;
            opts.onSkillsSection?.(section);
          },
        });
      } finally {
        capture(() => sentOnStart(provider, context, opts, skillsSection));
      }
    },
    resume(threadId, message, opts) {
      let skillsSection = "";
      try {
        return provider.resume(threadId, message, {
          ...opts,
          onSkillsSection: (section) => {
            skillsSection = section;
            opts?.onSkillsSection?.(section);
          },
        });
      } finally {
        capture(() => sentOnResume(provider, context, threadId, message, opts, skillsSection));
      }
    },
    ...(provider.describeSession ? { describeSession: (turn) => provider.describeSession!(turn) } : {}),
    // Recorded as a resume is (EO-734), and only where the backend can
    // fork at all, so debug mode neither takes forking away (EO-716) nor
    // invents it. Codex reports the Skills section it adds to a fork's
    // message before `fork` returns its promise, as it does on a resume.
    ...(provider.fork
      ? {
          fork: (threadId: string, message: string, opts?: AgentProviderResumeOptions) => {
            let skillsSection = "";
            try {
              return provider.fork!(threadId, message, {
                ...opts,
                onSkillsSection: (section) => {
                  skillsSection = section;
                  opts?.onSkillsSection?.(section);
                },
              });
            } finally {
              capture(() => sentOnFork(provider, context, threadId, message, opts, skillsSection));
            }
          },
        }
      : {}),
  };
}
