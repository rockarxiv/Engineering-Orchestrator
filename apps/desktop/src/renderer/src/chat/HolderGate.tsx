import { useState, type ReactNode } from "react";
import { cn } from "@eo/ui";
import { useClaimItem, useStepAuthority, useTakeOverItem } from "../query/hooks";

/**
 * On a human step owned by a group, only the person holding the item
 * decides (EO-368, the revised decision on EO-366).
 *
 * Wraps whatever decides — the step's result buttons — and draws them
 * only for the holder. Everybody else is told whose it is and offered
 * what they may do instead:
 *
 * - a member, on an item somebody else holds: who holds it, and **Take
 *   over**, which first shows a warning naming the holder and sends
 *   nothing until it is confirmed;
 * - a member, on an item nobody holds: **Claim**, then decide;
 * - somebody outside the group: whose step it is, and nothing to press.
 *
 * Anywhere nothing is gated — every other step, and a desktop signed in
 * to nothing — it draws its children and nothing else, so solo mode looks
 * exactly as it did.
 *
 * **Nothing gated is drawn before the answer is known.** Until
 * `items:authority` has answered there is no telling a holder from an
 * outsider, and drawing the buttons in the meantime would put them in
 * front of somebody the step is not waiting on. While the answer is being
 * asked again — a push said something changed — what is drawn stays, but
 * cannot be pressed until it is confirmed. The record's refusal remains
 * the enforcement; this keeps the screen from offering what it would
 * refuse.
 */
export function HolderGate({ itemId, children }: { itemId: string; children: ReactNode }) {
  const state = useStepAuthority(itemId);
  const claim = useClaimItem();
  const takeOver = useTakeOverItem();
  // The item and the holder the warning was opened about, captured when
  // it opened. Confirming sends *this* person, never whoever the live
  // answer says holds the item now: a person who was warned about Anna
  // has agreed to take it from Anna, and nobody else — and on *this*
  // item, so a warning cannot carry over to the next item opened in the
  // same place, even one Anna also holds.
  const [opened, setOpened] = useState<{ itemId: string; holder: { id: string; name: string } } | null>(null);
  const [said, setSaid] = useState<{ itemId: string; problem: string | null } | null>(null);
  // …and forgotten, not merely hidden, the moment the item changes. A
  // warning left open on one item and hidden while another is shown would
  // come back, still confirmable, on returning to the first — a takeover
  // confirmed against a warning the person had walked away from. Reset
  // during render, React's own pattern for state that follows a prop, so
  // no frame draws the old warning under the new item.
  const [shownFor, setShownFor] = useState(itemId);
  if (shownFor !== itemId) {
    setShownFor(itemId);
    setOpened(null);
    setSaid(null);
  }
  const warnedAbout = opened !== null && opened.itemId === itemId ? opened.holder : null;
  const problem = said !== null && said.itemId === itemId ? said.problem : null;
  const setWarnedAbout = (holder: { id: string; name: string } | null) => setOpened(holder === null ? null : { itemId, holder });
  const setProblem = (text: string | null) => setSaid({ itemId, problem: text });

  if (!state.known) return <div aria-busy="true" />;
  const { authority, refreshing } = state;
  if (authority === null || authority.you === "holder") {
    return (
      <fieldset disabled={refreshing} className="contents">
        {children}
      </fieldset>
    );
  }
  const { group, holder } = authority;
  // The warning stays open only while it is still about the person who
  // holds the item. If the item has changed hands since it opened, it
  // closes, says so, and a takeover needs a fresh warning naming whoever
  // holds it now.
  const warning = warnedAbout !== null && holder !== null && holder.id === warnedAbout.id ? warnedAbout : null;
  const changedHands = warnedAbout !== null && warning === null ? warnedAbout : null;

  const answered = (result: { problem: string | null }) => {
    setWarnedAbout(null);
    setProblem(result.problem);
  };
  const failed = (error: unknown) => setProblem(error instanceof Error ? error.message : String(error));

  return (
    <section aria-label="Who decides" className="flex flex-col gap-2 text-[12.5px] text-ink-muted">
      {authority.you === "outsider" ? (
        <p>
          This step waits on {group.name}
          {holder === null ? "" : ` and ${holder.name} holds it`}. Only somebody in {group.name} can claim it or decide on it.
        </p>
      ) : holder === null ? (
        <>
          {changedHands ? <p role="status">{changedHands.name} no longer holds this, so there is nothing to take over.</p> : null}
          <p>Nobody holds this yet. Claim it to decide on it.</p>
          <div>
            <button
              type="button"
              disabled={claim.isPending || refreshing}
              onClick={() => claim.mutate({ itemId }, { onSuccess: answered, onError: failed })}
              className={BUTTON}
            >
              Claim
            </button>
          </div>
        </>
      ) : (
        <>
          <p>{holder.name} holds this. On a step that waits on {group.name} only the person holding it decides.</p>
          {changedHands ? (
            <p role="status">
              {changedHands.name} no longer holds this — {holder.name} does now. Nothing was sent; take it over again if you still
              need to.
            </p>
          ) : null}
          {warning ? (
            <div role="alertdialog" aria-label={`Take over from ${warning.name}`} className="flex flex-col gap-2 rounded-[10px] bg-paused/12 p-2.5">
              <p className="text-ink">
                {warning.name} is holding this. Taking it over makes it yours and takes it from {warning.name}, who will be told you
                took it.
              </p>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={takeOver.isPending || refreshing}
                  onClick={() => takeOver.mutate({ itemId, fromPersonId: warning.id }, { onSuccess: answered, onError: failed })}
                  className={cn(BUTTON, "bg-accent text-accent-ink hover:bg-accent-hover")}
                >
                  Take over from {warning.name}
                </button>
                <button type="button" onClick={() => setWarnedAbout(null)} className="h-[26px] rounded-[10px] px-2 text-xs text-ink-muted hover:bg-canvas-raised">
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <div>
              <button
                type="button"
                disabled={refreshing}
                onClick={() => {
                  setProblem(null);
                  setWarnedAbout(holder);
                }}
                className={BUTTON}
              >
                Take over
              </button>
            </div>
          )}
        </>
      )}
      {problem ? <p className="text-xs text-danger">{problem}</p> : null}
    </section>
  );
}

/**
 * Whether the item's own content may be edited here (EO-368): everywhere
 * nothing is gated, and by the holder where something is — and not before
 * the answer is known. The editors sit behind a `ReadOnlyFence` with the
 * answer, so commenting, which is nowhere near them, stays open to
 * everybody. A re-read does not take an open editor away from the holder
 * mid-sentence; the last answer stands until the new one arrives.
 */
export function useMayEdit(itemId: string): boolean {
  const state = useStepAuthority(itemId);
  return state.known && (state.authority === null || state.authority.you === "holder");
}

/**
 * Whether a board card may offer Claim on this item (EO-368).
 *
 * The main process says an item is `claimable` — a human step nobody
 * holds — without knowing who is looking. On a step that waits on a
 * group only its members may claim, so the card asks the same question
 * the item page does, and only for a card that would offer Claim at all.
 * Nothing is offered until the answer is known, and nothing to somebody
 * outside the group: not an administrator either, who may take an item
 * over but not claim it.
 */
export function useMayClaim(itemId: string, claimable: boolean): boolean {
  const state = useStepAuthority(itemId, claimable);
  if (!claimable || !state.known) return false;
  return state.authority === null || (state.authority.you !== "outsider" && state.authority.holder === null);
}

const BUTTON = "inline-flex h-[26px] items-center rounded-[10px] bg-canvas-raised px-2.5 text-xs font-medium text-ink hover:bg-canvas-hover disabled:opacity-50";
