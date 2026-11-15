import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { KeyRound, Sparkles } from "lucide-react";
import { actionOptions, type CommentActionOption, type CommentOption, type RuntimeId } from "@eo/core";
import { machineAvailable } from "../ipc/bridge";
import { runtimeLabel } from "../shared/agents/catalog";
import { useRuntimeStatus } from "../shared/agents/runtimeStatus";
import { Button, ErrorLine } from "./kit";
import { useOpenUpdateConflictChat } from "./updateConflictChat";
import { SignInDialog } from "./views/agents/SignIn";

/**
 * The buttons on a comment that open something rather than answer it
 * (EO-533, `CommentActionOption`).
 *
 * Drawn apart from the offered answers, and pressing one posts nothing:
 * it is not a reply, and the mention it sits on stays open until what it
 * opened is settled. Each target opens through its own channel, and the
 * main process decides what it opens — the renderer sends which notice
 * was pressed and nothing it wrote itself.
 *
 * - `updateConflictChat`: the assistant chat about a held template
 *   update, Fix with assistant on the conflict notice
 *   (`useOpenUpdateConflictChat`).
 * - `runtimeSignIn` (EO-795): the same `SignInDialog` the Runtimes tab
 *   opens, for the runtime the message names. A sign-in it completes is
 *   heard by main from the CLI itself (`runtimes/signedIn.ts`), so the
 *   renderer has nothing to report afterwards beyond refreshing what it
 *   shows.
 */
export function CommentActions({ options, commentId, className }: { options: readonly CommentOption[] | null; commentId: string | null; className?: string }) {
  const actions = actionOptions(options);
  const { open, isPending, problem } = useOpenUpdateConflictChat();
  const [signingIn, setSigningIn] = useState<RuntimeId | null>(null);

  if (actions.length === 0) return null;

  const press = (action: CommentActionOption): void => {
    const target = action.opens;
    switch (target.type) {
      case "updateConflictChat":
        open({ conflictId: target.conflictId, commentId });
        return;
      case "runtimeSignIn":
        setSigningIn(target.runtime);
        return;
    }
  };

  return (
    <div className={className}>
      <div className="flex flex-wrap gap-1.5" role="group" aria-label="Actions">
        {actions.map((action) => (
          <Button
            key={`${action.opens.type}:${action.label}`}
            size="sm"
            variant="primary"
            icon={action.opens.type === "runtimeSignIn" ? <KeyRound size={12} /> : <Sparkles size={12} />}
            disabled={action.opens.type === "updateConflictChat" && isPending}
            onClick={() => press(action)}
          >
            {action.label}
          </Button>
        ))}
      </div>
      {problem ? <ErrorLine>{problem}</ErrorLine> : null}
      {signingIn ? <RuntimeSignIn key={signingIn} runtime={signingIn} onClose={() => setSigningIn(null)} /> : null}
    </div>
  );
}

/**
 * The sign-in dialog for one runtime, once EO has said what that runtime
 * is on this device — `SignInDialog` signs in the binary the status
 * resolved, so it is not drawn before the status answers.
 *
 * A tab served by an organisation's server has no runtimes of its own
 * (EO-319), so there it says where to sign in instead of asking.
 */
function RuntimeSignIn({ runtime, onClose }: { runtime: RuntimeId; onClose: () => void }) {
  const queryClient = useQueryClient();
  const status = useRuntimeStatus(runtime);
  const label = runtimeLabel(runtime);

  if (!machineAvailable()) return <ErrorLine>{`Sign ${label} in from EO on the computer it runs on — this window cannot reach its runtimes.`}</ErrorLine>;
  if (status.error) return <ErrorLine>{status.error.message}</ErrorLine>;
  if (!status.data) return null;
  if (status.data.runtime === null) return <ErrorLine>{`EO has no ${label} runtime on this computer to sign in.`}</ErrorLine>;

  return (
    <SignInDialog
      open
      runtime={status.data.runtime}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      onSignedIn={() => {
        // As the Runtimes tab does: the status re-probes the binary, and the model lists were failing until a moment ago.
        void queryClient.invalidateQueries({ queryKey: ["runtime"] });
        void queryClient.invalidateQueries({ queryKey: ["providers"] });
      }}
    />
  );
}
