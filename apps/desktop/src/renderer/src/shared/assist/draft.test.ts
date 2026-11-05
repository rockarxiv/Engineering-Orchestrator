import { beforeEach, describe, expect, it, vi } from "vitest";
import { publishAssistDraft } from "./draft";

/**
 * Publish, as the card's button does it (EO-610). The step between
 * `assist:draft` and `pipeline:save` is here and copies the fields it
 * names, so a field it does not name never reaches the pipeline.
 */
function ipcAnswering(read: Record<string, unknown>) {
  const invoke = vi.fn(async (channel: string, _payload?: unknown) => {
    if (channel === "assist:draft") {
      return { ok: true, data: { pipelineId: "default", newPipelineName: null, steps: [], routes: [], entryStepId: "todo", problem: null, waiting: [], actions: [], rename: null, icon: null, restoredFrom: null, ...read } };
    }
    return { ok: true, data: { saved: true, problems: [], version: 2, watchTurnedOff: [] } };
  });
  window.eo.ipc.invoke = invoke as never;
  return () => invoke.mock.calls.find(([channel]) => channel === "pipeline:save")?.[1] as Record<string, unknown>;
}

describe("publishing a draft", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("sends its entry rules on to pipeline:save", async () => {
    const rules = [{ kind: "description" }];
    const saved = ipcAnswering({ entryRules: rules });

    await expect(publishAssistDraft("chat", "card")).resolves.toMatchObject({ saved: true, problem: null });

    expect(saved().entryRules).toEqual(rules);
  });

  it("sends an empty list on as an empty list, which clears them", async () => {
    const saved = ipcAnswering({ entryRules: [] });

    await publishAssistDraft("chat", "card");

    expect(saved().entryRules).toEqual([]);
  });

  it("leaves them out when the draft says nothing, so the pipeline keeps its own", async () => {
    const saved = ipcAnswering({});

    await publishAssistDraft("chat", "card");

    expect(saved()).not.toHaveProperty("entryRules");
  });
});
