import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { serverAddressRefusal } from "@eo/core";
import { ipcQuery } from "../../../../query/client";
import { peopleKey, sessionKey, useSession } from "../../../../query/hooks";
import { Button, CardSection, Chip, ErrorLine, Facts, Field, Loading, Notice, TextInput } from "../../../kit";

/**
 * Settings → Organisation: signing this machine in to an organisation
 * (EO-323, `ARCHITECTURE.md`, "Identity"), in the chat
 * layout's terms.
 *
 * Three fields — the server's address, the person's email, their
 * password — and a token for *this machine* in its keychain, which the
 * admin can revoke from their Devices list. Machine-only in the nav: a
 * server asked to sign in to itself is a question with no answer.
 *
 * The address is judged here as well as in the main process, with the
 * same `serverAddressRefusal`: `http://eo.example.com` is refused while
 * the person is still looking at the field, before a password is sent
 * anywhere.
 */
export function OrganisationSection() {
  const queryClient = useQueryClient();
  // The banner's own hook, subscription and all, so this screen and the
  // banner cannot disagree about a revocation.
  const session = useSession();
  const status = session.data;

  const [address, setAddress] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: sessionKey });
    // Who EO can name changes with the sign-in.
    void queryClient.invalidateQueries({ queryKey: peopleKey });
  };

  const signIn = useMutation({
    mutationFn: (input: { address: string; email: string; password: string }) => ipcQuery("session:signIn", input),
    onSuccess: (result) => {
      // A password left in a field is a password on the screen behind whoever walks past next.
      setPassword("");
      if (result.problem === null) {
        setAddress("");
        setEmail("");
      }
      refresh();
    },
    onError: () => setPassword(""),
  });

  const signOut = useMutation({
    mutationFn: () => ipcQuery("session:signOut", undefined),
    onSuccess: () => refresh(),
  });

  const typed = address.trim();
  const addressProblem = typed === "" ? null : serverAddressRefusal(typed);

  if (session.isLoading) {
    return (
      <CardSection title="Organisation">
        <Loading />
      </CardSection>
    );
  }

  if (status?.state === "signed-in") {
    return (
      <CardSection
        title="Organisation"
        description="This machine is signed in to an organisation server."
        actions={
          <Button disabled={signOut.isPending} onClick={() => signOut.mutate()}>
            Sign out
          </Button>
        }
      >
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="text-[13.5px] font-medium text-ink">{status.personName}</span>
          {status.isAdmin ? <Chip tone="accent">admin</Chip> : null}
        </div>
        <Facts
          label="Sign-in"
          items={[
            { term: "Email", value: status.email },
            { term: "Server", value: <span className="font-mono">{status.address}</span> },
            { term: "This machine", value: <span className="font-mono">{status.deviceName}</span> },
          ]}
        />
        <p className="text-[12px] leading-relaxed text-ink-subtle">
          Signing out here forgets this machine&apos;s token. The device stays in your admin&apos;s
          list until they revoke it — this end cannot prove to the server that it is the one giving the token up.
        </p>
        {signOut.error ? <ErrorLine>{signOut.error.message}</ErrorLine> : null}
      </CardSection>
    );
  }

  const ready = typed !== "" && email.trim() !== "" && password !== "" && addressProblem === null;
  const submit = () => {
    if (ready && !signIn.isPending) signIn.mutate({ address: typed, email: email.trim(), password });
  };

  return (
    <CardSection title="Organisation" description="Sign in to your organisation's EO server to share the record with your colleagues.">
      {/* The third state: the person did nothing; their organisation did. */}
      {status?.state === "revoked" ? (
        <Notice tone="paused" role="status">
          {status.line}
        </Notice>
      ) : null}

      <form
        aria-label="Sign in to an organisation"
        className="flex min-w-0 max-w-[26rem] flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <Field label="Server address" error={addressProblem}>
          <TextInput value={address} aria-label="Server address" placeholder="https://eo.example.com" onChange={(event) => setAddress(event.target.value)} />
        </Field>
        <Field label="Email">
          <TextInput value={email} type="email" autoComplete="username" aria-label="Email" onChange={(event) => setEmail(event.target.value)} />
        </Field>
        <Field label="Password">
          <TextInput type="password" autoComplete="current-password" value={password} aria-label="Password" onChange={(event) => setPassword(event.target.value)} />
        </Field>
        <div>
          <Button type="submit" variant="primary" disabled={!ready || signIn.isPending}>
            {signIn.isPending ? "Signing in…" : "Sign in"}
          </Button>
        </div>
      </form>

      {signIn.data?.problem ? <ErrorLine>{signIn.data.problem}</ErrorLine> : null}
      {signIn.error ? <ErrorLine>{signIn.error.message}</ErrorLine> : null}
    </CardSection>
  );
}
