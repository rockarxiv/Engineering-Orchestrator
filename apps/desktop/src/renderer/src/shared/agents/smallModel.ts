import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { SmallModelView } from "@eo/core";
import { ipcQuery } from "../../query/client";

/**
 * A backend's small model, as both layouts' Runtimes cards edit it
 * (EO-477): what EO's own short questions run on — choosing which memory
 * an agent is given, among them.
 *
 * One query for both backends, keyed once, so two cards on one tab ask
 * once. Its default may have to ask the Codex CLI which models it has, so
 * it is asked when the tab opens and not again until something changes.
 */
export const smallModelsKey = ["sideCalls", "smallModels"] as const;

export function useSmallModel(backend: string): {
  view: SmallModelView | null;
  /** What the box shows: a choice being typed, or the stored one. Empty is "use the default". */
  text: string;
  setText: (next: string) => void;
  /** Stores what was typed, if it changed; an empty box goes back to the default. */
  commit: () => void;
  useDefault: () => void;
  saving: boolean;
  problem: string | null;
} {
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: smallModelsKey, queryFn: () => ipcQuery("sideCalls:smallModels", undefined), staleTime: 5 * 60_000 });
  const save = useMutation({
    mutationFn: (model: string | null) => ipcQuery("sideCalls:setSmallModel", { backend, model }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: smallModelsKey }),
  });
  const [draft, setDraft] = useState<string | null>(null);
  // Read defensively: a screen drawn against a stub that does not know
  // the channel has no small model to show, not a crash.
  const backends: readonly SmallModelView[] = Array.isArray(query.data?.backends) ? query.data.backends : [];
  const view = backends.find((entry) => entry.backend === backend) ?? null;
  const text = draft ?? view?.chosen ?? "";

  const store = (model: string | null) => {
    setDraft(null);
    if (model === (view?.chosen ?? null)) return;
    save.mutate(model);
  };

  return {
    view,
    text,
    setText: setDraft,
    commit: () => store(text.trim() === "" ? null : text.trim()),
    useDefault: () => store(null),
    saving: save.isPending,
    problem: save.data?.ok === false ? save.data.problem : save.isError ? "EO could not save the small model." : null,
  };
}

/** The sentence under the box: what the model is for, and what the default is when none is chosen. */
export function smallModelHint(view: SmallModelView): string {
  const purpose = "What EO's own short questions run on, such as choosing which memory to give an agent.";
  return view.chosen === null ? `${purpose} Default: ${view.defaultNote}` : `${purpose} Clear it to go back to the default: ${view.defaultNote}`;
}
