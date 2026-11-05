import type { FakeProviderScript } from "./fake.js";

/**
 * A minimal result that satisfies ImplementOutputSchema (A-02). Most
 * supervisor tests drive a story through the `implement` action, and
 * since A-02 every such result is schema-checked — an ad-hoc payload
 * now gets re-prompted and escalated rather than succeeding.
 */
export const validImplementResult = { branch: "eo/EO-1", summary: "Did the work.", handoff: "Straightforward; nothing to flag." };

/** As persisted after validation: zod fills the defaulted fields in. */
export const validImplementResultParsed = { ...validImplementResult, files_changed: [], tests_run: false };

/** A normal run: some output, then a well-formed result. */
export const happyPathFixture: FakeProviderScript = {
  steps: [{ output: "Looking at the ticket..." }, { output: "Implementing..." }, { fileEdit: "src/foo.ts" }],
  usage: { tokensIn: 500, tokensOut: 200, costCents: 3 },
  result: { branch: "eo/EO-1", summary: "Implemented the thing.", handoff: "Straightforward; nothing to flag.", files_changed: ["src/foo.ts"], tests_run: true },
};

/** Agent posts a blocking @user comment mid-run and stops there — the escalation path. */
export const blockingEscalationFixture: FakeProviderScript = {
  steps: [
    { output: "I need clarification before continuing." },
    {
      toolCall: {
        name: "comment",
        args: { body: "@user should this handle empty input?", mentions: ["user"], blocking: true },
      },
    },
  ],
  // No result: a blocking escalation ends the run awaiting a reply, not with a result.
};

/** A result that fails its action's schema — drives A-02's re-prompt-then-escalate path. */
export const malformedResultFixture: FakeProviderScript = {
  steps: [{ output: "Done, I think." }],
  result: { thisFieldDoesNotExist: true },
};

/** Simulates the agent process crashing partway through. */
export const crashMidStreamFixture: FakeProviderScript = {
  steps: [{ output: "Starting..." }],
  throwMessage: "simulated provider crash",
};

/**
 * Never completes — pair with a short timeout in the caller to prove
 * timeout enforcement. sleepMs is intentionally large; the point isn't to
 * actually wait that long, it's to always be "still running" relative to
 * whatever timeout the test configures.
 */
export const hangsPastTimeoutFixture: FakeProviderScript = {
  steps: [{ sleepMs: 24 * 60 * 60 * 1000 }],
  result: { unreachable: true },
};
