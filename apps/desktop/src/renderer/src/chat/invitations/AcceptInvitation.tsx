import { useState, type ReactNode } from "react";
import { useMutation } from "@tanstack/react-query";
import { invitationCodeFrom, MIN_PASSWORD_LENGTH } from "@eo/core";
import { ipcQuery } from "../../query/client";
import { Button, Card, ErrorLine, Field, TextInput, ViewHeader } from "../kit";
import { StandaloneScreen } from "../standalone";

/**
 * Accepting an invitation (EO-323, the original design).
 *
 * "Invitation by email link containing a one-time code; accepting sets a
 * password or, for the first version, a passkey through the browser's
 * WebAuthn if the platform provides it, else a password. Record the
 * choice."
 *
 * ### Why this is a gate rather than a route
 *
 * The link is a *path* — `/invite/<code>` — and the app is a
 * `HashRouter`, because the desktop loads the built page over `file://`
 * where a real path means the root of the disk (App.tsx says so at the
 * top). So the router never sees this address: the server's static
 * handler answers the path with `index.html`, the hash is empty, and the
 * catch-all would send whoever followed the link to the board.
 *
 * Reading `window.location.pathname` here is what makes the link work at
 * all. It sits above `Routes` for the reason `FirstRunGate` does: this
 * is not a place inside the app, it is the state the whole window is in
 * — somebody who is not yet anybody, holding a code.
 *
 * ### Why there is no passkey here
 *
 * The scope allows "a passkey through the browser's WebAuthn if the
 * platform provides it, else a password", and this screen offered the
 * choice for exactly one round of review: a radio button that set a
 * label, beside a password field the person still had to fill in,
 * because nothing registered a WebAuthn credential and nothing verified
 * an assertion. That is two failures wearing one control. The button did
 * nothing, which invariant #12 exists to forbid; and the record then
 * said "passkey" about an account whose only credential was a password,
 * which is EO answering its own data's one question wrongly.
 *
 * "If the platform provides it" is the condition that is not met, and
 * the platform here is not the browser — it is EO. A passkey has to be
 * registered against a challenge this server issued and verified on the
 * way in, and the way in for this version is the desktop's sign-in
 * screen, which the same scope describes as "server address, email,
 * password". A credential only a browser could present, to a browser
 * sign-in that does not exist, is a credential nobody can use.
 *
 * So: a password, and `CredentialKindSchema` is where the value comes
 * back when the flow that can honour it does.
 *
 * ### How it is drawn
 *
 * In the chat layout's look (EO-527): above both layouts, it belongs to
 * neither's frame, so it is the chat kit on a `StandaloneScreen` in this
 * browser's chat theme.
 */
export function InvitationGate({ children }: { children: ReactNode }) {
  const code = typeof window === "undefined" ? null : invitationCodeFrom(window.location.pathname);
  if (code === null) return <>{children}</>;
  return <AcceptInvitation code={code} />;
}

export function AcceptInvitation({ code }: { code: string }) {
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [again, setAgain] = useState("");

  const accept = useMutation({
    mutationFn: (input: { code: string; password: string; name?: string }) => ipcQuery("auth:acceptInvitation", input),
  });

  const accepted = accept.data?.accepted ?? null;
  const tooShort = password.length > 0 && password.length < MIN_PASSWORD_LENGTH;
  const mismatch = again.length > 0 && again !== password;

  if (accepted !== null) {
    return (
      <Shell title={`Welcome, ${accepted.name}.`}>
        <Card>
          <p className="text-[13px] leading-relaxed text-ink-muted">
            You are on this organisation&apos;s list as <span className="text-ink">{accepted.email}</span>. Open EO on your own machine, go to
            Settings → Organisation, and sign in with this server&apos;s address and the password you just set.
          </p>
        </Card>
      </Shell>
    );
  }

  return (
    <Shell
      title="Join this EO server"
      meta="Somebody invited you. Set the password you will sign in with, and this link stops working — it is good for one person, once."
    >
      <Card>
        <Field label="Your name">
          <TextInput aria-label="Your name" value={name} onChange={(event) => setName(event.target.value)} />
        </Field>

        <Field
          label="Password"
          {...(tooShort ? { error: `A password needs at least ${MIN_PASSWORD_LENGTH} characters. Three words is plenty.` } : {})}
        >
          <TextInput type="password" aria-label="Password" value={password} onChange={(event) => setPassword(event.target.value)} />
        </Field>
        <Field label="Password again" {...(mismatch ? { error: "Those two do not match." } : {})}>
          <TextInput type="password" aria-label="Password again" value={again} onChange={(event) => setAgain(event.target.value)} />
        </Field>

        <div className="pt-1">
          <Button
            variant="primary"
            disabled={password.length < MIN_PASSWORD_LENGTH || again !== password || accept.isPending}
            onClick={() => accept.mutate({ code, password, ...(name.trim() === "" ? {} : { name: name.trim() }) })}
          >
            Accept
          </Button>
        </div>

        {accept.data?.problem ? <ErrorLine>{accept.data.problem}</ErrorLine> : null}
      </Card>
    </Shell>
  );
}

function Shell({ title, meta, children }: { title: string; meta?: string; children: ReactNode }) {
  return (
    <StandaloneScreen width="max-w-lg">
      <ViewHeader title={title} {...(meta === undefined ? {} : { meta })} />
      {children}
    </StandaloneScreen>
  );
}
