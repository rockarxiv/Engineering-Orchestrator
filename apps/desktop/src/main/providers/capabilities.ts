import type { ModelReasoningEffort } from "./codexClient.js";
import type { ProviderCapabilities, ProviderModel } from "@eo/core";

/**
 * What each backend can be configured with (U-11).
 *
 * Everything here that is a union in an SDK is written as a value list
 * *typed by* that union, so bumping the dependency turns a changed
 * option into a compile error instead of a dropdown that silently
 * offers something the SDK no longer accepts.
 *
 * What is *not* here is as deliberate (EO-178). Claude's permission
 * modes and Codex's sandbox modes and approval policies were three such
 * lists, and each has exactly one correct value under EO — pinned in
 * `claude.ts` and `codex.ts`, where the process is actually spawned,
 * rather than offered here and then obeyed. A list this file no longer
 * publishes is a control the editor no longer draws.
 */

/**
 * `satisfies` rather than a cast. For Codex the union is EO's own now
 * (`codexClient.ts`, copied from `@openai/codex-sdk` 0.161.0 when the
 * library was removed in EO-372): the app-server types an effort as a
 * bare string, as 0.163.0's, 0.165.0's and 0.166.0's still do, so no upstream type can catch a
 * level going away, and the
 * live model list (`codexModels.ts`, which reads each model's supported
 * efforts from the binary) is the authority on what a model accepts.
 */
const CODEX_REASONING_EFFORTS = ["minimal", "low", "medium", "high", "xhigh"] as const satisfies readonly ModelReasoningEffort[];
const CLAUDE_REASONING_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

/**
 * Can this backend be spoken to while a turn is running (EO-176)?
 *
 * Not part of `ProviderCapabilities` above, and deliberately: everything
 * there is a list of values an *editor* offers when somebody configures
 * an agent. This is not configurable by anybody — it is whether the
 * backend has the capability at all — and it is asked at a different
 * moment, about a run rather than about an agent.
 *
 * The authority is still `InterruptibleStream.steer` on the live stream;
 * this is what a screen can ask *before* there is a message to deliver,
 * so that a person is never shown a control that would do nothing. The
 * two are checked against each other in `capabilities.test.ts`, because
 * a backend gaining the capability and this line not moving would show
 * up as a missing control rather than as anything louder.
 *
 * Claude, yes: the SDK's streaming input mode carries a user message
 * into a live query, and the CLI folds it into the turn already running
 * — see `steeredMessage` in `claude.ts` for which of the SDK's three
 * priorities actually does that, since it is not the one whose name says
 * so. Codex, yes since EO-373: it was `@openai/codex-sdk` over a one-shot
 * `codex exec`, with nothing to reach a session that had already
 * started, and it runs over `codex app-server` now (EO-372), whose
 * `turn/steer` puts a message into the turn that is running.
 *
 * Every other backend — `fake`, `scripted`, one EO has never heard of —
 * answers no, which fails closed.
 */
export function providerSteersLiveTurns(provider: string): boolean {
  return provider === "claude" || provider === "codex";
}

/**
 * The static half of a provider's capabilities — everything that does
 * not need the CLI. Models may be empty here and filled in later by a
 * live fetch.
 */
export function capabilitiesFor(provider: string): ProviderCapabilities {
  switch (provider) {
    case "claude":
      return {
        provider,
        // Fetched from the installed SDK; see fetchClaudeModels.
        models: [],
        modelsAreLive: true,
        reasoningEfforts: [...CLAUDE_REASONING_EFFORTS],
      };

    case "codex":
      return {
        provider,
        // The SDK has no catalog API, but its managed CLI app-server does.
        models: [],
        modelsAreLive: true,
        reasoningEfforts: [...CODEX_REASONING_EFFORTS],
      };

    default:
      // `fake` and `scripted` take no configuration. Returning an empty
      // shape rather than throwing keeps the editor uniform: it renders
      // whatever a provider offers, which for these is nothing.
      return {
        provider,
        models: [],
        modelsAreLive: false,
        reasoningEfforts: [],
      };
  }
}

/**
 * Asks the installed Claude SDK which models it has.
 *
 * A real CLI spawn, so it happens when the editor asks and not on every
 * render. The alternative — a list in this file — is wrong the day the
 * SDK adds a model, and nothing would say so.
 */
export async function fetchClaudeModels(
  runQuery: typeof import("@anthropic-ai/claude-agent-sdk").query,
  /**
   * The `claude` executable (A-08).
   *
   * This spawns the CLI exactly as a run does, so it needs the resolved
   * path for the same reason: EO no longer ships a binary for the SDK to
   * fall back to. Without it the model list is empty on any machine that
   * has not got Claude Code installed separately.
   */
  executablePath?: string | null,
): Promise<{ ok: true; models: ProviderModel[] } | { ok: false; reason: string }> {
  try {
    // A prompt is required, but the answer is never read: the session
    // exists to be asked what models it supports. maxTurns 1 keeps it
    // from doing any work if it ever gets that far.
    const session = runQuery({
      prompt: "",
      options: { maxTurns: 1, ...(executablePath ? { pathToClaudeCodeExecutable: executablePath } : {}) },
    });
    const models = await session.supportedModels();
    await session.return?.(undefined);

    // An unauthenticated CLI answers with an empty list rather than
    // throwing — found by running this against a machine that wasn't
    // signed in, where the dropdown simply had nothing in it and said
    // nothing about why. Empty is a failure to answer, not an answer.
    if (models.length === 0) {
      return {
        ok: false,
        reason: "Claude returned no models. You may not be signed in on this machine — run `claude` in a terminal. You can still type a model name.",
      };
    }

    return {
      ok: true,
      models: models.map((model) => ({
        value: model.value,
        label: model.displayName || model.value,
        ...(model.description ? { description: model.description } : {}),
        supportsEffort: model.supportsEffort ?? false,
        effortLevels: [...(model.supportedEffortLevels ?? [])],
      })),
    };
  } catch (error) {
    return {
      ok: false,
      reason:
        `Could not ask Claude which models are available: ${error instanceof Error ? error.message : String(error)}. ` +
        `You can still type a model name.`,
    };
  }
}
