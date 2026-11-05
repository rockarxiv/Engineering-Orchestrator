import { useState, type ReactNode } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { hasServerCredential, rememberedDeviceId, rememberServerCredential } from "../../ipc/bridge";
import { ipcQuery } from "../../query/client";
import { Button, Card, ErrorLine, Field, TextInput, ViewHeader } from "../kit";
import { StandaloneScreen } from "../standalone";

/**
 * Signing in to a server from the browser it serves (EO-326,
 * the original design).
 *
 * "The admin opens its address in a browser and sees the same renderer
 * the desktop has, in an admin role." Which they could not do: the only
 * credential a browser could hold was the operator's token, carried in
 * the address the server printed at boot — a stand-in that `bridge.ts`
 * has described as standing in "until real sign-in lands (7b)" since
 * EO-319, and which the door itself calls a key that "cannot *be* a
 * device". A key that is nobody cannot act as anybody, so without this
 * the design's second half — the admin deciding on an item, recorded under
 * their own name — has nothing to record.
 *
 * So a browser signs in the way a desktop does, through `auth:signIn`,
 * and comes away the same thing a desktop comes away as: **a device**.
 * That is the whole design, and it is why nothing new is stored. A
 * browser session is a row in the admin's Devices list, revocable there
 * like any other; the device names a person; the person is what a
 * transition joins to. An admin's decision is then an ordinary
 * transition with an ordinary device on it, which is exactly what the
 * story asks for when it says "as any person's would be".
 *
 * ### Why a gate and not a route
 *
 * `InvitationGate`'s reason, one door along. This is not a place inside
 * the app; it is the state the whole window is in — somebody holding no
 * credential, for whom every record channel answers a sentence about a
 * missing token. A route would need the app around it, and the app
 * cannot draw itself without the record.
 *
 * ### Why the operator's token still works
 *
 * Untouched. It is how somebody reaches a server whose people list is
 * empty, which is every server on its first boot — the first invitation
 * has to be written by somebody, and that somebody cannot have been
 * invited. A tab that already holds any credential goes straight
 * through here.
 *
 * ### Why it is drawn in the chat layout's look
 *
 * It is in front of both layouts, so it belongs to neither's frame, and
 * the chat layout is the one that stays (EO-527): the chat kit, on a
 * `StandaloneScreen` in this browser's chat theme.
 */
export function ServedSignInGate({ children }: { children: ReactNode }) {
  // Held in state, and told rather than re-read. `hasServerCredential`
  // is a look at `sessionStorage`, which React has no way to hear
  // change: the form below is a *child*, so a successful sign-in
  // re-renders the form and not this — and a gate that only re-read on
  // its own next render would leave somebody staring at the sign-in
  // screen they had just completed.
  const [credentialled, setCredentialled] = useState(hasServerCredential);
  if (credentialled) return <>{children}</>;
  return <ServedSignIn onSignedIn={() => setCredentialled(true)} />;
}

/**
 * What the admin's list will call this browser.
 *
 * Coarse on purpose. The list exists so somebody can recognise a row
 * they want to revoke — "Firefox" beside "anna-macbook" is enough to do
 * that — and a full user-agent string is both unreadable and more about
 * the machine than anybody asked for. Unrecognised is "A browser",
 * which is honest and still distinguishable from a laptop.
 */
export function browserName(userAgent: string): string {
  if (/\bEdg\//.test(userAgent)) return "Edge";
  if (/\bOPR\//.test(userAgent)) return "Opera";
  if (/\bFirefox\//.test(userAgent)) return "Firefox";
  if (/\bChrome\//.test(userAgent)) return "Chrome";
  if (/\bSafari\//.test(userAgent)) return "Safari";
  return "A browser";
}

export function ServedSignIn({ onSignedIn }: { onSignedIn?: (() => void) | undefined } = {}) {
  const queryClient = useQueryClient();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const signIn = useMutation({
    mutationFn: (input: { email: string; password: string }) =>
      ipcQuery("auth:signIn", {
        ...input,
        deviceName: `${browserName(typeof navigator === "undefined" ? "" : navigator.userAgent)} (browser)`,
        // Re-issued onto the row this browser held before, so the
        // admin's list does not grow one per sign-in. An id the server
        // does not know, or one belonging to somebody else, is ignored
        // rather than refused — see `IssueDeviceInput.deviceId`.
        ...(rememberedDeviceId() === undefined ? {} : { deviceId: rememberedDeviceId()! }),
      }),
    onSuccess: (answer) => {
      if (answer.session === null) return;
      rememberServerCredential(answer.session.token, answer.session.deviceId);
      onSignedIn?.();
      // Everything this tab has cached was fetched with no credential
      // and is therefore a refusal. Thrown away whole rather than
      // per-key: there is no query whose answer survives becoming
      // somebody.
      void queryClient.invalidateQueries();
    },
  });

  const ready = email.trim() !== "" && password !== "" && !signIn.isPending;

  return (
    <StandaloneScreen width="max-w-lg">
      <ViewHeader
        title="Sign in to this EO server"
        meta="Use the email and password you set when you accepted your invitation. This browser becomes a device on the organisation's list, and your admin can revoke it there."
      />

      <Card>
        <Field label="Email">
          <TextInput type="email" aria-label="Email" autoComplete="username" value={email} onChange={(event) => setEmail(event.target.value)} />
        </Field>

        <Field label="Password">
          <TextInput
            type="password"
            aria-label="Password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </Field>

        <div className="pt-1">
          <Button variant="primary" disabled={!ready} onClick={() => signIn.mutate({ email: email.trim(), password })}>
            Sign in
          </Button>
        </div>

        {/* One sentence for every failure, which is the server's own rule:
            telling "no such person" from "wrong password" is how a form
            becomes a way to learn who is on the list. */}
        {signIn.data?.problem ? <ErrorLine>{signIn.data.problem}</ErrorLine> : null}
      </Card>
    </StandaloneScreen>
  );
}
