import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { machineAvailable } from "../../ipc/bridge";
import { useMe } from "../../query/hooks";

/**
 * Read-only by default, and what it takes to stop being (EO-326,
 * `ARCHITECTURE.md`, "Identity").
 *
 * The design grants an administrator two things that sound like one and are
 * not. They **see** every project's board and inbox, because the record
 * syncs up. And they **may** move an item or decide on it, "as a human
 * actor, through the same transition path as anyone else". What sits
 * between the two is this: an admin looking at a team's board is
 * ordinarily reading it, and a decision taken by a slip of the hand on
 * somebody else's work is a decision that team cannot explain.
 *
 * So it is a **safety catch, not a permission**, and the difference is
 * worth being exact about because the code would look the same either
 * way:
 *
 *  - the server does **not** refuse an admin who acts without pressing
 *    it. `ADMIN_ONLY_CHANNELS` says every channel outside the
 *    organisation's own list "stays open to any signed-in device", and
 *    putting half a permission model behind a button in the renderer
 *    would be a lock whose key is in the same drawer — and worse, one
 *    that a person would believe;
 *  - it is therefore per *item* and for this tab only. Nothing is
 *    stored. Reloading the page puts every card back to read-only,
 *    which is the right default to return to.
 *
 * And it is drawn only where it means something: a desktop has one
 * person, who owns the machine and everything on it, so there is nothing
 * for them to take authority over and no banner is shown.
 *
 * Disabled rather than absent, which is the opposite of what
 * `machineAvailable` does two files over, and deliberately. That rule is
 * for a control that *cannot* work here — a file picker on a server —
 * and hiding it is honest because the capability is missing. This
 * control can work, and the person is entitled to know it is there and
 * that they have not taken it yet. Hiding it would leave an admin
 * concluding EO had made their board read-only, and looking for a
 * setting that does not exist.
 *
 * ### What actually does the disabling
 *
 * `ReadOnlyFence`, not this. This hook answers *whether*, and a
 * `<fieldset disabled>` around each mutating region answers *what* —
 * because "what" is the half that goes wrong. The first cut of this
 * story passed `readOnly` to the four controls its author was thinking
 * about and left ten others live, every one an honest oversight. A hook
 * that every control has to remember to call has the same failure mode
 * as a prop every control has to be passed.
 *
 * So a component should reach for this only where a fence cannot help:
 * `Composer`, whose file drops land on a wrapper no fieldset disables,
 * and the board's drag, which is a dnd-kit option rather than an
 * attribute. Everything else is inside a fence and needs to know
 * nothing.
 */
export interface ItemAuthority {
  /**
   * Whether this tab is looking at somebody else's record at all.
   *
   * False on every desktop, which is what keeps every screen below
   * unchanged for somebody working alone.
   */
  administering: boolean;
  /** Whether the actions on this item are to be drawn disabled. */
  readOnly: boolean;
  /** Takes authority over this one item, for this tab. */
  actAsAdmin: () => void;
}

interface AuthorityValue {
  administering: boolean;
  acting: ReadonlySet<string>;
  take: (itemId: string) => void;
}

const AuthorityContext = createContext<AuthorityValue | null>(null);

/**
 * Holds which items this tab has taken authority over.
 *
 * Above the router, beside the other gates, because an admin who presses
 * Act as admin on the item page and then drags the same card on the
 * board has not changed their mind — and a state that lived in either
 * screen would make them press it twice for one decision.
 */
export function AdminAuthorityProvider({ children }: { children: ReactNode }) {
  const { admin, organisation, isLoading } = useMe();
  const [acting, setActing] = useState<ReadonlySet<string>>(() => new Set<string>());

  const take = useCallback((itemId: string) => {
    setActing((taken) => (taken.has(itemId) ? taken : new Set([...taken, itemId])));
  }, []);

  const value = useMemo<AuthorityValue>(
    () => ({ administering: administering(isLoading, organisation, admin), acting, take }),
    [isLoading, organisation, admin, acting, take],
  );

  return <AuthorityContext.Provider value={value}>{children}</AuthorityContext.Provider>;
}

/**
 * Whether this tab is looking into work that is not its own — including
 * while it does not yet know (EO-326, ARCHITECTURE.md, "Identity").
 *
 * A catch that is open while the answer is in flight is not a catch. The
 * first paint of an item page happens long before `people:me` comes
 * back, and for that render every control was live: an admin who clicked
 * Archive in the second before the answer arrived would have archived
 * another team's item, and the banner explaining why they could not
 * would have appeared immediately afterwards.
 *
 * So the loading answer is **yes, careful** — but only where being
 * careful could ever be right. `machineAvailable()` is synchronous and
 * known on the first render, and it is false only in a browser served by
 * a server. A desktop therefore never waits and never flickers: there is
 * one person, they own the machine, and no query can change that. The
 * uncertainty exists in exactly one place, and it is the place that
 * errs closed.
 *
 * The cost is paid by a colleague in a browser, whose own item page is
 * briefly read-only before the record says who they are. That is the
 * right way round: a moment of "not yet" for somebody who will get their
 * controls back, against a silent mutation of somebody else's work.
 */
function administering(isLoading: boolean, organisation: boolean, admin: boolean): boolean {
  if (machineAvailable()) return false;
  if (isLoading) return true;
  // An organisation's record *and* the admin flag. A colleague signed in
  // to the browser is reading their own projects and acts on them as
  // they would on their own desktop; there is nobody else's work in
  // front of them to be careful with.
  return organisation && admin;
}

/**
 * What this tab may do to one item.
 *
 * Answers "not administering, nothing read-only" when no provider is
 * above it, so a component rendered on its own in a test behaves as it
 * does on a desktop. That is the same answer the provider gives there,
 * rather than a convenient blank.
 */
export function useItemAuthority(itemId: string | null | undefined): ItemAuthority {
  const context = useContext(AuthorityContext);
  const administering = context?.administering ?? false;
  const take = context?.take;
  const actAsAdmin = useCallback(() => {
    if (itemId != null) take?.(itemId);
  }, [itemId, take]);

  return {
    administering,
    readOnly: administering && (itemId == null || !(context?.acting.has(itemId) ?? false)),
    actAsAdmin,
  };
}
