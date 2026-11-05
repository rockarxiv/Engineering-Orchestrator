import { Link } from "react-router-dom";
import { CloudOff, KeyRound } from "lucide-react";
import type { ReactNode } from "react";
import { useSession, useSyncStatus } from "../query/hooks";

/**
 * What the whole window needs to say, over the conversation and the
 * canvas alike: offline, signed out.
 *
 * The same two conditions and the same words as the classic shell's
 * banners, drawn as the chat layout's thin strips. Each is absent when its
 * condition is.
 */
export function ChatBanners() {
  return (
    <>
      <SignedOut />
      <Offline />
    </>
  );
}

function Strip({ label, icon, children, end }: { label: string; icon: ReactNode; children: ReactNode; end?: ReactNode }) {
  return (
    <div role="status" aria-label={label} className="flex min-h-9 shrink-0 items-center gap-2.5 border-b border-line px-4 py-1.5 text-[12.5px]">
      <span aria-hidden className="shrink-0 text-paused">
        {icon}
      </span>
      <span className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2 gap-y-0.5">{children}</span>
      {end}
    </div>
  );
}

function Offline() {
  const sync = useSyncStatus();
  const status = sync.data;
  if (status === undefined || status.state !== "offline") return null;
  return (
    <Strip label="Offline" icon={<CloudOff size={14} />}>
      <span className="text-paused">
        Offline since {clockTime(status.offlineSince)}
        {status.queued > 0 ? ` · ${status.queued === 1 ? "1 change" : `${status.queued} changes`} waiting to sync` : ""}
      </span>
      <span className="min-w-0 truncate text-ink-subtle">
        {status.queued > 0
          ? "Nothing is lost — your changes replay in order when your organisation's record is reachable again."
          : "EO is still working on this machine; it will catch up with your organisation's record when it can."}
      </span>
    </Strip>
  );
}

function clockTime(at: number | null): string {
  if (at === null) return "a moment ago";
  return new Date(at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

function SignedOut() {
  const session = useSession();
  if (session.data?.state !== "revoked") return null;
  return (
    <Strip
      label="Signed out"
      icon={<KeyRound size={14} />}
      end={
        <Link to="/settings?section=organisation" className="shrink-0 text-[12.5px] font-medium text-accent-soft hover:underline">
          Sign in again
        </Link>
      }
    >
      <span className="text-paused">{session.data.line}</span>
    </Strip>
  );
}
