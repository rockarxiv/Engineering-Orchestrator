import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { PlugZap, Sparkles } from "lucide-react";
import { INVITATION_LINK_SHAPE_LINE, invitationLinkFrom, serverAddressRefusal } from "@eo/core";
import { machineAvailable } from "../../ipc/bridge";
import { ipcQuery } from "../../query/client";
import { firstRunKey, galleryKey, peopleKey, sessionKey } from "../../query/hooks";
import { Button, Card, ErrorLine, Field, Loading, Notice, TextInput, ViewHeader } from "../kit";
import { StandaloneScreen } from "../standalone";
import { ConnectAgentPanel, useCodingAgents } from "../views/agents/ConnectAgent";
import { Gallery } from "../views/gallery/GalleryView";

/**
 * First run, in the order the design settled (EO-317,
 * the original design).
 *
 * "Mode, then gallery, then optional Preview with no sign-in, then the
 * template's own blanks as a short form, then the needs check with a
 * 'why' line per red item and 'Continue with Preview only', then the
 * first real item."
 *
 * What this component owns is step 1, step 2 — connecting a coding agent
 * (EO-659) — and the frame; steps 3 to 7 are the gallery, which is the same screen a person reaches from Templates
 * afterwards. That is deliberate and is the whole reason first run is
 * not a wizard of its own: a second project starts from a template as
 * much as a first does, and a flow that existed only at the beginning
 * would be a screen nobody could return to — and a second copy of the
 * needs check to keep in step with this one.
 *
 * **It replaces "point EO at a repository"**, which was the wrong door
 * for everybody who is not a developer, and is now one card in the
 * gallery for the developers it was right for.
 *
 * Drawn in the chat layout's look whichever layout the window is set to
 * (EO-527): the chat kit, on a `StandaloneScreen` in this device's chat
 * theme. The gallery is the chat layout's own (`views/gallery`), so the
 * flow and the Templates view are still the one screen.
 */
export function FirstRun({ onLeft }: { onLeft: () => void }) {
  const queryClient = useQueryClient();
  const state = useQuery({ queryKey: firstRunKey, queryFn: () => ipcQuery("firstRun:state", undefined) });

  const finish = useMutation({
    mutationFn: () => ipcQuery("firstRun:finish", undefined),
    // Everything on screen is about to be about a project that did not
    // exist a moment ago.
    onSuccess: () => void queryClient.invalidateQueries(),
  });

  /**
   * Both exits come through here: the first item, and "Continue with
   * Preview only".
   *
   * The gate is told first and told directly, rather than being left to
   * notice: `firstRun:finish` is a round trip, and the screen the person
   * pressed the button on navigates immediately. Waiting for the answer
   * would put the flow back over the board for as long as the write
   * took.
   */
  const leave = () => {
    onLeft();
    finish.mutate();
  };

  // Nothing is drawn until the mode is known, because drawing step 1
  // first and then replacing it would ask somebody a question they had
  // already answered.
  if (state.isLoading) return null;
  if ((state.data?.mode ?? null) === null) return <Mode onAnswered={() => void queryClient.invalidateQueries({ queryKey: firstRunKey })} />;
  return <AfterMode onLeft={leave} />;
}

/**
 * Where moving on from the connect step — "Look around first" or
 * "Continue" — is remembered, for the rest of this window's session. Not
 * React state: Preview takes the window to an item page, which unmounts
 * the flow, and coming back from a rehearsal the person chose must not
 * ask them the question they just answered.
 */
const LOOKED_AROUND_KEY = "eo.firstRun.lookedAround";

function lookedAroundBefore(): boolean {
  return window.sessionStorage.getItem(LOOKED_AROUND_KEY) === "1";
}

/**
 * Step 2, "Connect a coding agent" (EO-659), and then the gallery.
 *
 * Skipped when something on this machine is already signed in at the
 * moment it would first be shown, decided from what the runtimes
 * themselves answer. Once it is on screen it stays there until the
 * person moves on (EO-666): a sign-in that finishes turns that row to
 * "Signed in" and leaves the others offering their own Install or Sign
 * in, so somebody with both Claude Code and Codex can sign in to both.
 * "Continue" moves on once one is signed in; while none is, "Look
 * around first" goes on to the gallery anyway, where Preview works and
 * every Use this waits for a coding agent, with a way back here.
 */
function AfterMode({ onLeft }: { onLeft: () => void }) {
  const agents = useCodingAgents();
  const [lookedAround, setLookedAround] = useState(lookedAroundBefore);
  /** The step has been shown and not yet moved on from, so a sign-in does not take it away. */
  const [stepOpen, setStepOpen] = useState(false);
  const remember = (value: boolean) => {
    if (value) window.sessionStorage.setItem(LOOKED_AROUND_KEY, "1");
    else window.sessionStorage.removeItem(LOOKED_AROUND_KEY);
    setLookedAround(value);
    setStepOpen(!value);
  };

  if (agents.loading) {
    return (
      <StandaloneScreen>
        <Loading>Asking this machine what it has…</Loading>
      </StandaloneScreen>
    );
  }
  const showStep = !lookedAround && (stepOpen || !agents.signedIn);
  // Adjusting state while rendering, React's pattern for state derived
  // from what was rendered: the step is held open from the render that
  // first shows it, before any sign-in can land.
  if (showStep && !stepOpen) setStepOpen(true);
  if (showStep) return <ConnectStep signedIn={agents.signedIn} onMoveOn={() => remember(true)} />;
  return (
    // From the top rather than centred: the cards, the form and the needs
    // check all run longer than a window, and the ground scrolls.
    <StandaloneScreen width="max-w-6xl" centred={false}>
      <Gallery
        onFinished={onLeft}
        // Until a sign-in is established, Preview only — on a served tab
        // too, where nothing here can establish one.
        {...(agents.signedIn ? {} : { needsCodingAgent: { onConnect: () => remember(false) } })}
      />
    </StandaloneScreen>
  );
}

function ConnectStep({ signedIn, onMoveOn }: { signedIn: boolean; onMoveOn: () => void }) {
  const machine = machineAvailable();
  return (
    <StandaloneScreen>
      <ViewHeader
        icon={<PlugZap size={15} />}
        title="Connect a coding agent"
        meta={
          machine
            ? "The agents in a pipeline run on a coding agent signed in on this machine. EO ships none: pick one, and EO fetches it from its publisher, checks it, and signs you in."
            : "The agents in a pipeline run on a coding agent signed in on the machine that runs them."
        }
      />
      <Card>
        <ConnectAgentPanel />
      </Card>
      <div className="flex flex-wrap items-center gap-3 pt-3">
        {signedIn ? (
          <Button variant="primary" onClick={onMoveOn}>
            Continue
          </Button>
        ) : (
          <>
            <Button onClick={onMoveOn}>Look around first</Button>
            <span className="text-[12.5px] text-ink-subtle">Every template can be previewed without one. Nothing is sent, and nothing costs money.</span>
          </>
        )}
      </div>
    </StandaloneScreen>
  );
}

/**
 * Step 1: "one question before anything else — solo or organisation."
 *
 * Solo goes straight in. Organisation is a real way in (EO-661), by one
 * of two doors:
 *
 *  - **I have an account** — server address, email, password, signed in
 *    through `session:signIn`, the same call Settings → Organisation
 *    makes. There is one sign-in, in the main process; this is a second
 *    form in front of it, not a second implementation.
 *  - **I have an invitation link** — the link is opened in the person's
 *    browser, where `/invite/<code>` sets the password
 *    (`AcceptInvitation`), and the account form comes back with the
 *    server's address already in it for when that is done.
 *
 * Somebody with neither is told plainly that whoever runs the server
 * has to invite them, and offered "Continue on my own" — an address
 * alone gets nobody in, so a form that took one and carried on would be
 * a door painted on a wall.
 *
 * The mode is recorded only once there is an answer: solo when they
 * carry on alone, organisation once the sign-in succeeded.
 */
type ModeView = "question" | "organisation" | "account" | "invitation";

function Mode({ onAnswered }: { onAnswered: () => void }) {
  const queryClient = useQueryClient();
  const [view, setView] = useState<ModeView>("question");
  const [address, setAddress] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [link, setLink] = useState("");
  const [linkProblem, setLinkProblem] = useState<string | null>(null);
  /** The account form was reached by opening an invitation, so it says what to do in the browser first. */
  const [invited, setInvited] = useState(false);

  const answer = useMutation({
    mutationFn: (input: { mode: "solo" | "organisation"; address: string }) => ipcQuery("firstRun:setMode", input),
    onSuccess: onAnswered,
  });

  const signIn = useMutation({
    mutationFn: (input: { address: string; email: string; password: string }) => ipcQuery("session:signIn", input),
    onSuccess: (result, input) => {
      // A failure keeps every field as it was typed, so a mistyped
      // password is one field to fix rather than three to fill again.
      if (result.problem !== null) return;
      setPassword("");
      // What the signed-in machine can name changes with the sign-in:
      // the session itself, and the people the gallery's role pickers
      // offer (`gallery:list` asks the organisation once signed in).
      for (const queryKey of [sessionKey, peopleKey, galleryKey]) void queryClient.invalidateQueries({ queryKey });
      answer.mutate({ mode: "organisation", address: input.address });
    },
  });

  const typed = address.trim();
  const addressProblem = typed === "" ? null : serverAddressRefusal(typed);
  const ready = typed !== "" && email.trim() !== "" && password !== "" && addressProblem === null;
  const busy = signIn.isPending || answer.isPending;
  const submit = () => {
    if (ready && !busy) signIn.mutate({ address: typed, email: email.trim(), password });
  };

  /**
   * Opens the invitation, after it has been read.
   *
   * Judged first, and refused with a sentence about what a link looks
   * like before anything is opened: a browser pointed at whatever was
   * pasted is not a step towards an account. `window.open` reaches the
   * window-open handler, which hands the address to the real browser.
   */
  const openInvitation = () => {
    const found = invitationLinkFrom(link);
    const problem = found === null ? INVITATION_LINK_SHAPE_LINE : serverAddressRefusal(found.address);
    setLinkProblem(problem);
    if (found === null || problem !== null) return;
    window.open(link.trim(), "_blank", "noopener,noreferrer");
    setAddress(found.address);
    setInvited(true);
    setView("account");
  };

  const organisationFooter = (
    <div className="flex flex-col gap-2 pt-3">
      <p className="text-[12.5px] leading-relaxed text-ink-muted">
        Without an account or an invitation, you need to be invited by whoever runs your organisation&apos;s EO server. Until then, EO
        works on this machine on its own.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button disabled={busy} onClick={() => answer.mutate({ mode: "solo", address: "" })}>
          Continue on my own
        </Button>
        <Button variant="ghost" onClick={() => setView(view === "organisation" ? "question" : "organisation")}>
          Back
        </Button>
      </div>
      {answer.error ? <ErrorLine>{answer.error.message}</ErrorLine> : null}
    </div>
  );

  return (
    <StandaloneScreen>
      <ViewHeader
        icon={<Sparkles size={15} />}
        title="Welcome to EO"
        meta="EO runs work through a pipeline: agents do the steps that can be done for you, and you decide the ones that are yours. One question before anything else."
      />

      {view === "question" ? (
        <Card>
          <p className="text-[13.5px] text-ink">Is this just you, or is it for an organisation?</p>
          <div className="flex items-center gap-2">
            <Button variant="primary" disabled={answer.isPending} onClick={() => answer.mutate({ mode: "solo", address: "" })}>
              Just me
            </Button>
            <Button onClick={() => setView("organisation")}>My organisation</Button>
          </div>
          <p className="text-[12.5px] leading-relaxed text-ink-subtle">
            Just me keeps everything on this machine: your projects, your sign-ins, your folders. An organisation shares pipelines and
            agents through a server.
          </p>
        </Card>
      ) : null}

      {view === "organisation" ? (
        <>
          <Card>
            <p className="text-[13.5px] text-ink">How are you getting in to your organisation?</p>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="primary"
                onClick={() => {
                  setInvited(false);
                  setView("account");
                }}
              >
                I have an account
              </Button>
              <Button onClick={() => setView("invitation")}>I have an invitation link</Button>
            </div>
          </Card>
          {organisationFooter}
        </>
      ) : null}

      {view === "invitation" ? (
        <>
          <Card>
            <form
              aria-label="Open an invitation"
              className="flex min-w-0 max-w-[26rem] flex-col gap-3"
              onSubmit={(event) => {
                event.preventDefault();
                openInvitation();
              }}
            >
              <Field
                label="Invitation link"
                hint="The link in the invitation you were sent. It opens in your browser, where you choose your password."
                error={linkProblem}
              >
                <TextInput
                  aria-label="Invitation link"
                  placeholder="https://eo.example.com/invite/…"
                  value={link}
                  onChange={(event) => {
                    setLink(event.target.value);
                    setLinkProblem(null);
                  }}
                />
              </Field>
              <div>
                <Button type="submit" variant="primary" disabled={link.trim() === ""}>
                  Open the invitation
                </Button>
              </div>
            </form>
          </Card>
          {organisationFooter}
        </>
      ) : null}

      {view === "account" ? (
        <>
          <Card>
            {invited ? (
              <Notice tone="info" role="status">
                The invitation has opened in your browser. Choose your password there, then come back and sign in with your email and that
                password.
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
                <TextInput
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  aria-label="Password"
                  onChange={(event) => setPassword(event.target.value)}
                />
              </Field>
              <div>
                <Button type="submit" variant="primary" disabled={!ready || busy}>
                  {busy ? "Signing in…" : "Sign in"}
                </Button>
              </div>
            </form>
            {signIn.data?.problem ? <ErrorLine>{signIn.data.problem}</ErrorLine> : null}
            {signIn.error ? <ErrorLine>{signIn.error.message}</ErrorLine> : null}
          </Card>
          {organisationFooter}
        </>
      ) : null}
    </StandaloneScreen>
  );
}
