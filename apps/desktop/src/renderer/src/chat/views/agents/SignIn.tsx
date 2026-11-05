import { useEffect, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { ExternalLink } from "lucide-react";
import type { RuntimeStatusView } from "@eo/core";
import { ipcQuery } from "../../../query/client";
import { CODEX_WARNING, cancelStarted, introFor, keyCustodyFor, type Phase, type Started } from "../../../shared/agents/signIn";
import { Button, Dialog, TextInput } from "../../kit";

/**
 * Signing a runtime in, without a terminal (EO-83, EO-84) — the chat
 * layout's drawing of `agents/SignInDialog`.
 *
 * The flow is the classic dialog's, line for line, because every rule in
 * it is about a child process rather than about pixels: a start that
 * lands after the dialog let go of it is killed (`own`, `pending`), a
 * retired wait cannot clear the device code off the screen (`attempt`),
 * a cancelled sign-in reports itself rather than closing as though it
 * worked, and a typed API key is dropped the moment its call answers.
 */
export function SignInDialog({
  runtime,
  open,
  onOpenChange,
  onSignedIn,
}: {
  runtime: RuntimeStatusView;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Refetches the status, which re-probes the binary rather than assuming the answer. */
  onSignedIn: () => void;
}) {
  const [phase, setPhase] = useState<Phase>("intro");
  const [session, setSession] = useState<Started | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [transcript, setTranscript] = useState("");
  const [code, setCode] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [copied, setCopied] = useState(false);
  const copiedReset = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (copiedReset.current !== null) clearTimeout(copiedReset.current);
    },
    [],
  );

  /** The child this dialog is responsible for killing, if any. */
  const live = useRef<string | null>(null);
  /** Which attempt this dialog is currently driving. */
  const attempt = useRef(0);
  /** A start that has been asked for and has not yet answered. */
  const pending = useRef<Promise<Started> | null>(null);

  /** Takes charge of a child, and retires whatever came before it — including a start still in flight. */
  const own = (sessionId: string | null): number => {
    const inFlight = pending.current;
    pending.current = null;
    if (inFlight !== null) void inFlight.then(cancelStarted).catch(() => {});
    live.current = sessionId;
    attempt.current += 1;
    return attempt.current;
  };

  useEffect(() => {
    return () => {
      // Abandoning the dialog must not leave a child running.
      const sessionId = live.current;
      if (sessionId !== null) void ipcQuery("runtime:cancelSignIn", { sessionId });
      const inFlight = pending.current;
      pending.current = null;
      if (inFlight !== null) void inFlight.then(cancelStarted).catch(() => {});
      attempt.current += 1;
    };
  }, []);

  const start = useMutation({
    mutationFn: (input: { mode: "browser" | "device" | "console"; generation: number }) => {
      const flow = ipcQuery("runtime:startSignIn", { provider: runtime.id as "codex" | "claude", mode: input.mode });
      pending.current = flow;
      return flow;
    },
    onSuccess: (result, variables) => {
      if (variables.generation !== attempt.current) return;
      pending.current = null;
      if (!result.ok || result.sessionId === null) {
        setPhase("failed");
        setProblem(result.problem ?? `EO could not start signing ${runtime.label} in.`);
        setTranscript(result.transcript);
        return;
      }
      const generation = own(result.sessionId);
      setSession(result);
      setPhase("waiting");
      // Codex has nothing to submit — its child takes the code itself.
      if (!result.needsCode) finish.mutate({ sessionId: result.sessionId, code: null, attempt: generation });
    },
    onError: (error: Error, variables) => {
      if (variables.generation !== attempt.current) return;
      pending.current = null;
      setPhase("failed");
      setProblem(error.message);
      setTranscript("");
    },
  });

  const finish = useMutation({
    mutationFn: (input: { sessionId: string; code: string | null; attempt: number }) =>
      ipcQuery("runtime:submitSignInCode", { sessionId: input.sessionId, code: input.code }),
    onSuccess: (result, variables) => {
      if (variables.attempt !== attempt.current) return;
      live.current = null;
      if (result.state === "signed_in") {
        setSession(null);
        onSignedIn();
        onOpenChange(false);
        return;
      }
      // Cancelled is reported as cancelled, never as a success or a failure to interpret.
      setSession(null);
      setPhase(result.state === "cancelled" ? "cancelled" : "failed");
      setProblem(result.problem);
      setTranscript(result.transcript);
    },
    onError: (error: Error, variables) => {
      if (variables.attempt !== attempt.current) return;
      live.current = null;
      setSession(null);
      setPhase("failed");
      setProblem(error.message);
      setTranscript("");
    },
  });

  const cancel = useMutation({
    mutationFn: (sessionId: string) => ipcQuery("runtime:cancelSignIn", { sessionId }),
  });

  /** The API-key way in (EO-84): one call, no session, and the key dropped whichever way it answers. */
  const withKey = useMutation({
    mutationFn: (key: string) => ipcQuery("runtime:signInWithApiKey", { provider: runtime.id as "codex" | "claude", apiKey: key }),
    onSuccess: (result) => {
      setApiKey("");
      if (result.ok) {
        onSignedIn();
        onOpenChange(false);
        return;
      }
      setPhase("failed");
      setProblem(result.problem);
      setTranscript(result.transcript);
    },
    onError: (error: Error) => {
      setApiKey("");
      setPhase("failed");
      setProblem(error.message);
      setTranscript("");
    },
  });

  const stop = (): void => {
    const sessionId = session?.sessionId ?? null;
    if (sessionId !== null) cancel.mutate(sessionId);
    own(null);
    setSession(null);
    setTranscript("");
    setPhase("cancelled");
    setProblem(
      runtime.id === "codex"
        ? `Sign-in was cancelled, so ${runtime.label} is still signed out — the CLI removed its credentials when the flow began.`
        : `Sign-in was cancelled, so ${runtime.label} is still signed out.`,
    );
  };

  const close = (): void => {
    const sessionId = session?.sessionId ?? null;
    if (sessionId !== null) cancel.mutate(sessionId);
    own(null);
    setSession(null);
    setPhase("intro");
    setProblem(null);
    setTranscript("");
    setCode("");
    setApiKey("");
    onOpenChange(false);
  };

  const retry = (): void => {
    setPhase("intro");
    setProblem(null);
    setTranscript("");
    setCode("");
    setApiKey("");
    start.reset();
    finish.reset();
    withKey.reset();
  };

  const busy = start.isPending || withKey.isPending;

  const keyForm = (
    <form
      className="flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        setProblem(null);
        withKey.mutate(apiKey);
      }}
    >
      <span className="text-[12px] font-medium text-ink-muted">API key</span>
      <div className="flex items-center gap-2">
        <TextInput
          aria-label="API key"
          type="password"
          value={apiKey}
          autoComplete="off"
          spellCheck={false}
          disabled={withKey.isPending}
          onChange={(event) => setApiKey(event.target.value)}
        />
        <Button type="submit" variant="primary" disabled={apiKey.trim() === "" || withKey.isPending}>
          {withKey.isPending ? "Signing in…" : "Use this key"}
        </Button>
      </div>
      <p className="text-[12px] leading-snug text-ink-subtle">{keyCustodyFor(runtime)}</p>
    </form>
  );

  const footer = (
    <>
      {/* The fallback for the one flow that has one — and not beside a field that opens no browser. */}
      {runtime.id === "codex" && phase !== "api_key" ? (
        <Button
          variant="ghost"
          disabled={busy}
          onClick={() => {
            const sessionId = session?.sessionId ?? null;
            if (sessionId !== null) cancel.mutate(sessionId);
            const generation = own(null);
            setSession(null);
            setProblem(null);
            setTranscript("");
            start.mutate({ mode: "device", generation });
          }}
        >
          Browser didn&apos;t open
        </Button>
      ) : null}

      {phase === "api_key" ? (
        <Button
          variant="ghost"
          disabled={busy}
          onClick={() => {
            setApiKey("");
            setProblem(null);
            setPhase("intro");
          }}
        >
          Back
        </Button>
      ) : null}

      {/* Closing is the dialog's own close button, which kills whatever child it holds; while a child is running, Cancel says so instead. */}
      {phase === "waiting" ? <Button onClick={stop}>Cancel</Button> : null}

      {phase === "intro" || phase === "failed" || phase === "cancelled" ? (
        <>
          {/* Beside the subscription rather than behind it: a key is a way in, not a recovery step. */}
          <Button
            disabled={busy}
            onClick={() => {
              if (phase !== "intro") retry();
              setProblem(null);
              setPhase("api_key");
            }}
          >
            Use an API key
          </Button>
          <Button
            variant="primary"
            disabled={busy}
            icon={<ExternalLink size={12} />}
            onClick={() => {
              if (phase !== "intro") retry();
              setProblem(null);
              start.mutate({ mode: "browser", generation: own(null) });
            }}
          >
            {busy ? "Starting…" : phase === "intro" ? "Sign in" : "Try again"}
          </Button>
        </>
      ) : null}
    </>
  );

  return (
    <Dialog open={open} onClose={close} title={`Sign in to ${runtime.label}`} footer={footer} width="w-[32rem]">
      <div className="flex flex-col gap-3 text-[13px] leading-relaxed">
        {phase === "intro" ? (
          <>
            <p className="text-ink">{introFor(runtime)}</p>
            {runtime.id === "codex" ? (
              <p role="alert" className="text-[12.5px] text-paused">
                {CODEX_WARNING}
              </p>
            ) : null}
            <p className="text-[12.5px] text-ink-subtle">
              EO writes nothing into {runtime.id === "codex" ? "~/.codex" : "~/.claude"} — every credential is written by {runtime.label} itself.
            </p>
          </>
        ) : null}

        {phase === "api_key" ? (
          <>
            {runtime.id === "claude" ? (
              <>
                <p className="text-ink">Two ways in, and they differ in who ends up holding the key.</p>
                {/* The Console flow first: it is the one where EO stores nothing. */}
                <div className="flex flex-col items-start gap-1">
                  <Button
                    disabled={busy}
                    icon={<ExternalLink size={12} />}
                    onClick={() => {
                      setProblem(null);
                      setTranscript("");
                      start.mutate({ mode: "console", generation: own(null) });
                    }}
                  >
                    Sign in through the Anthropic Console
                  </Button>
                  <p className="text-[12px] text-ink-subtle">
                    EO runs <code className="font-mono">claude auth login --console</code> and opens the page in your browser, the same as a subscription
                    sign-in. Claude Code keeps the credential itself — EO stores nothing.
                  </p>
                </div>
                <p className="text-ink">Or, if you already have a key:</p>
              </>
            ) : (
              <>
                <p className="text-ink">
                  The key is handed to Codex on standard input — it never appears on a command line, where every process listing on this machine could
                  read it.
                </p>
                <p role="alert" className="text-[12.5px] text-paused">
                  Codex stores one credential at a time: this key replaces whatever it is signed in with now.
                </p>
              </>
            )}
            {keyForm}
          </>
        ) : null}

        {phase === "waiting" && session ? (
          <>
            <p className="text-ink">
              {session.opened ? "Your browser should have opened. If it did not, use this link:" : "EO could not open your browser. Open this link yourself:"}
            </p>
            <div className="flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded-[8px] bg-canvas-raised px-2 py-1 font-mono text-[12px] text-ink" title={session.url ?? ""}>
                {session.url}
              </code>
              <Button
                size="sm"
                onClick={() => {
                  void navigator.clipboard?.writeText(session.url ?? "");
                  setCopied(true);
                  if (copiedReset.current !== null) clearTimeout(copiedReset.current);
                  copiedReset.current = setTimeout(() => setCopied(false), 2000);
                }}
              >
                {copied ? "Copied" : "Copy"}
              </Button>
            </div>

            {session.verificationCode !== null ? (
              <div className="flex flex-col gap-1">
                <span className="text-[12.5px] text-ink-muted">Type this code into the page:</span>
                <code className="rounded-[8px] bg-canvas-raised px-2 py-1 font-mono text-[17px] text-ink">{session.verificationCode}</code>
              </div>
            ) : null}

            {session.needsCode ? (
              <form
                className="flex flex-col gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (session.sessionId !== null) finish.mutate({ sessionId: session.sessionId, code, attempt: attempt.current });
                }}
              >
                <span className="text-[12.5px] text-ink-muted">After signing in, the page shows an authorization code. Paste it here.</span>
                <div className="flex items-center gap-2">
                  <TextInput
                    aria-label="Authorization code"
                    value={code}
                    autoComplete="off"
                    disabled={finish.isPending}
                    onChange={(event) => setCode(event.target.value)}
                  />
                  <Button type="submit" variant="primary" disabled={code.trim() === "" || finish.isPending}>
                    {finish.isPending ? "Signing in…" : "Submit"}
                  </Button>
                </div>
              </form>
            ) : (
              <p role="status" className="text-[12.5px] text-ink-subtle">
                Waiting for {runtime.label} to finish signing in. It completes the exchange itself — there is no code to paste.
              </p>
            )}
          </>
        ) : null}

        {phase === "failed" || phase === "cancelled" ? (
          <p role="alert" className={phase === "cancelled" ? "text-[12.5px] text-paused" : "text-[12.5px] text-danger"}>
            {problem ?? `Signing in to ${runtime.label} did not finish.`}
          </p>
        ) : null}

        {/* What the CLI actually printed: the one place a person can read a code EO's scrape missed. */}
        {phase === "failed" && transcript !== "" ? (
          <pre className="max-h-40 overflow-auto relative rounded-[10px] bg-canvas p-2 font-mono text-[11.5px] text-ink-muted">{transcript}</pre>
        ) : null}
      </div>
    </Dialog>
  );
}
