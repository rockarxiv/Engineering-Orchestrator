import { Eye, ShieldCheck } from "lucide-react";
import { useItemAuthority } from "../../shared/admin/authority";
import { Button } from "../kit";

/**
 * The line above an item an administrator is only reading, and the button
 * that changes that (EO-326, `ARCHITECTURE.md`, "Identity") — drawn as the
 * chat layout's notice.
 *
 * What it says and does is the classic `admin/ActAsAdmin`'s. Read-only, it
 * says this is somebody else's work and nothing will move, and offers
 * **Act as admin**; taken, it says that what happens next is recorded
 * under this person's name on the item's thread — and stays, because a
 * line that vanished the moment it started to matter would be
 * reassurance rather than information. On a desktop, and for anyone
 * reading their own projects, it draws nothing at all.
 */
export function ActAsAdmin({ itemId }: { itemId: string }) {
  const { administering, readOnly, actAsAdmin } = useItemAuthority(itemId);
  if (!administering) return null;

  return (
    <div
      role="status"
      className="flex items-center gap-3 rounded-[12px] bg-canvas-subtle px-3.5 py-2.5 text-[12.5px] leading-relaxed text-ink-muted"
    >
      {readOnly ? <Eye aria-hidden size={15} className="shrink-0" /> : <ShieldCheck aria-hidden size={15} className="shrink-0 text-ink" />}
      <p className="min-w-0 flex-1">
        {readOnly
          ? "You are looking at this as an administrator. Nothing here will move until you say so."
          : "You are acting as an administrator. What you do here is recorded under your name, on this item's thread."}
      </p>
      {readOnly ? (
        <Button variant="secondary" size="sm" onClick={actAsAdmin}>
          Act as admin
        </Button>
      ) : null}
    </div>
  );
}
