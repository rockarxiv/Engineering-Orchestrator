import { QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { RuntimeStatusView } from "@eo/core";
import { describe, expect, it, vi } from "vitest";
import { createQueryClient } from "../../../query/client";
import { SignInDialog } from "./SignIn";

/**
 * The chat layout's sign-in dialog, held to every case the classic
 * dialog's tests (`agents/SignInDialog.test.tsx`) hold that one to — the
 * flow is the same and only the drawing differs. The one difference in
 * the cases: closing is the dialog's own close button, not a second one
 * in the footer.
 *
 * Originally:  * The sign-in dialog (EO-83).
 *
 * What is under test is that the dialog is shaped by the provider's
 * actual flow rather than by a single guess at both. Claude's
 * authorization code travels browser → person → EO → the child's
 * stdin, so there is a field and a submit; Codex's goes straight to the
 * child's own listener, so there is neither and the dialog waits. Get
 * that backwards and one provider hangs on a field nobody can fill
 * while the other silently never finishes.
 *
 * The other load-bearing property: a cancelled sign-in reports itself.
 * Closing as though it had worked would leave someone looking at a
 * runtime that still cannot run a turn — and for Codex, at a machine
 * the CLI signed out on the way in.
 */
const CODEX: RuntimeStatusView = {
  id: "codex",
  label: "Codex",
  publisher: "OpenAI",
  termsUrl: "https://github.com/openai/codex/blob/main/LICENSE",
  source: "cache",
  path: "/home/x/.config/EO/runtimes/codex@0.147.0/codex",
  version: "0.147.0",
  packageName: "@openai/codex",
  packageVersion: "0.147.0-linux-x64",
  state: "ready",
  auth: { state: "signed_out", method: null, kind: "unknown", storedKey: false, account: null, problem: null },
};

const CLAUDE: RuntimeStatusView = {
  ...CODEX,
  id: "claude",
  label: "Claude Code",
  publisher: "Anthropic PBC",
  path: "/home/x/.config/EO/runtimes/claude@0.3.227/claude",
  packageName: "@anthropic-ai/claude-agent-sdk-linux-x64",
  packageVersion: "0.3.227",
};

type Started = {
  ok?: boolean;
  sessionId?: string | null;
  url?: string | null;
  verificationCode?: string | null;
  needsCode?: boolean;
  opened?: boolean;
  transcript?: string;
  problem?: string | null;
};

type Finished = { ok?: boolean; state?: "signed_in" | "failed" | "cancelled"; transcript?: string; problem?: string | null };

/**
 * The main process, as far as this dialog can tell.
 *
 * `submitSignInCode` is deliberately left unresolved until a test says
 * otherwise: for Codex that call is the whole browser half of the flow,
 * and a dialog that only behaves while nothing is pending is not the
 * dialog anybody uses.
 */
type Keyed = { ok?: boolean; heldBy?: "cli" | "eo" | null; transcript?: string; problem?: string | null };

function renderDialog(
  runtime: RuntimeStatusView,
  options: { start?: Started | ((mode: string) => Started); finish?: Finished; holdStart?: boolean; withKey?: Keyed } = {},
) {
  /** Set when `holdStart` is on: ends the spawn the test is holding open. */
  let releaseStart: (() => void) | null = null;
  const calls: { channel: string; payload: Record<string, unknown> }[] = [];
  // Keyed by session, because more than one wait can be outstanding at
  // once: the device fallback kills the browser child and starts another
  // while the first wait is still in the air, and that overlap is the
  // whole point of the test at the bottom of this file.
  const waiting = new Map<string, (value: unknown) => void>();
  let waitedOn: string | null = null;
  const onOpenChange = vi.fn();
  const onSignedIn = vi.fn();

  window.eo.ipc.invoke = vi.fn(async (channel: string, payload: Record<string, unknown>) => {
    calls.push({ channel, payload });
    if (channel === "runtime:startSignIn") {
      const chosen = typeof options.start === "function" ? options.start(String(payload["mode"])) : options.start;
      const response = {
        ok: true,
        data: {
          ok: true,
          sessionId: "session-1",
          url: "https://auth.example.com/oauth/authorize?state=xyz",
          verificationCode: null,
          needsCode: runtime.id === "claude",
          opened: true,
          transcript: "",
          problem: null,
          ...chosen,
        },
      };
      // A start that does not answer until the test says so. Spawning
      // the CLI and scraping its stdout for a URL is not instant, and
      // letting go of the dialog inside that window is the case where
      // the child exists but has no id yet for anyone to cancel.
      if (options.holdStart) {
        return new Promise((resolve) => {
          releaseStart = () => resolve(response);
        });
      }
      return response;
    }
    if (channel === "runtime:submitSignInCode") {
      if (!options.finish) {
        const sessionId = String(payload["sessionId"]);
        waitedOn = sessionId;
        return new Promise((resolve) => waiting.set(sessionId, resolve));
      }
      return { ok: true, data: { ok: false, state: "failed", transcript: "", problem: null, ...options.finish } };
    }
    if (channel === "runtime:cancelSignIn") return { ok: true, data: { cancelled: true } };
    if (channel === "runtime:signInWithApiKey") {
      return {
        ok: true,
        data: { ok: true, heldBy: runtime.id === "codex" ? "cli" : "eo", transcript: "", problem: null, ...options.withKey },
      };
    }
    return { ok: true, data: {} };
  }) as never;

  const view = render(
    <QueryClientProvider client={createQueryClient()}>
      <SignInDialog runtime={runtime} open onOpenChange={onOpenChange} onSignedIn={onSignedIn} />
    </QueryClientProvider>,
  );

  return {
    calls,
    onOpenChange,
    onSignedIn,
    unmount: view.unmount,
    /** Lets a held `startSignIn` answer at last. */
    releaseStart: () => releaseStart?.(),
    sent: (channel: string) => calls.filter((call) => call.channel === channel),
    /** Ends one outstanding wait — the most recent unless a test names an older one. */
    release: (result: Finished, sessionId?: string) =>
      waiting
        .get(sessionId ?? waitedOn ?? "")
        ?.({ ok: true, data: { ok: false, state: "failed", transcript: "", problem: null, ...result } }),
  };
}

async function signIn(): Promise<void> {
  fireEvent.click(await screen.findByRole("button", { name: /Sign in/ }));
}

describe("before anything is spawned", () => {
  it("says that signing Codex in signs this machine out of Codex first", async () => {
    // The CLI deletes ~/.codex/auth.json at the start of both its login
    // paths, and EO does not reach into another product's credential
    // store to put it back. Saying so first is the whole mitigation.
    renderDialog(CODEX);

    const warning = await screen.findByRole("alert");
    expect(warning).toHaveTextContent(/signs this machine out of Codex first/);
    expect(warning).toHaveTextContent(/abandon this dialog.*left signed out/i);
  });

  it("does not warn about a Claude sign-in, which takes nothing away", async () => {
    renderDialog(CLAUDE);

    await screen.findByText(/claude auth login/);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("spawns nothing until someone asks for it", async () => {
    const { sent } = renderDialog(CODEX);

    await screen.findByText(/codex login/);
    expect(sent("runtime:startSignIn")).toHaveLength(0);
  });
});

describe("the Claude flow", () => {
  it("shows the URL with a copy button and a field for the code the page displays", async () => {
    const writeText = vi.fn();
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    renderDialog(CLAUDE);
    await signIn();

    expect(await screen.findByText("https://auth.example.com/oauth/authorize?state=xyz")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    // The copy button is not decoration: `openExternal` resolving is not
    // proof a browser appeared.
    expect(writeText).toHaveBeenCalledWith("https://auth.example.com/oauth/authorize?state=xyz");
    expect(screen.getByLabelText("Authorization code")).toBeInTheDocument();
  });

  it("cancels the Copied label's reset when the dialog goes, rather than leaving a timer behind", async () => {
    // A `setState` two seconds in the future with nothing holding it.
    // In the app it lands on a dialog somebody has closed; in the suite
    // it outlives this file's jsdom and arrives as `window is not
    // defined`, which vitest counts as an unhandled error — so a run in
    // which all 5,666 tests passed failed anyway, and did so on whichever
    // PR happened to shift the timing. Same defect, two symptoms.
    // Real timers, and the 2-second handle watched directly: a count of
    // pending timers is noise here — react-query and testing-library
    // both schedule their own — so the assertion names the exact handle
    // rather than hoping the total moved.
    const realSetTimeout = globalThis.setTimeout;
    const reset: unknown[] = [];
    const setSpy = vi.spyOn(globalThis, "setTimeout");
    setSpy.mockImplementation(((handler: TimerHandler, ms?: number, ...rest: unknown[]) => {
      const id = (realSetTimeout as (...args: never[]) => unknown)(handler as never, ms as never, ...(rest as never[]));
      if (ms === 2000) reset.push(id);
      return id;
    }) as never);
    const clearSpy = vi.spyOn(globalThis, "clearTimeout");

    try {
      Object.defineProperty(navigator, "clipboard", { value: { writeText: vi.fn() }, configurable: true });
      const { unmount } = renderDialog(CLAUDE);
      await signIn();
      await screen.findByText("https://auth.example.com/oauth/authorize?state=xyz");

      fireEvent.click(screen.getByRole("button", { name: "Copy" }));
      expect(screen.getByRole("button", { name: "Copied" })).toBeInTheDocument();
      // The label's own reset, and only it.
      expect(reset).toHaveLength(1);

      unmount();

      // Cleared by the effect's cleanup, so there is no callback left to
      // arrive after this component — or, in the suite, after this
      // file's environment.
      expect(clearSpy).toHaveBeenCalledWith(reset[0]);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("submits what was pasted, and closes once the child exits successfully", async () => {
    const { sent, onSignedIn, onOpenChange } = renderDialog(CLAUDE, { finish: { ok: true, state: "signed_in" } });
    await signIn();

    fireEvent.change(await screen.findByLabelText("Authorization code"), { target: { value: "pasted-code" } });
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));

    await waitFor(() => expect(onSignedIn).toHaveBeenCalled());
    expect(sent("runtime:submitSignInCode")[0]?.payload).toEqual({ sessionId: "session-1", code: "pasted-code" });
    // The status re-probes because the dialog refetches it, not because
    // anything here decided the answer.
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("does not cancel a child that has already exited cleanly", async () => {
    // The dialog kills whatever it is responsible for when it goes away,
    // and a success closes it — so the two have to agree on the moment
    // the child stopped being its responsibility.
    const { sent, onSignedIn } = renderDialog(CLAUDE, { finish: { ok: true, state: "signed_in" } });
    await signIn();

    fireEvent.change(await screen.findByLabelText("Authorization code"), { target: { value: "pasted-code" } });
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    await waitFor(() => expect(onSignedIn).toHaveBeenCalled());

    expect(sent("runtime:cancelSignIn")).toEqual([]);
  });

  it("keeps the dialog open and says what went wrong when the child exits non-zero", async () => {
    const { onOpenChange } = renderDialog(CLAUDE, {
      finish: { ok: false, state: "failed", problem: "Claude Code exited with code 1 without signing in.", transcript: "Error: invalid code" },
    });
    await signIn();

    fireEvent.change(await screen.findByLabelText("Authorization code"), { target: { value: "wrong" } });
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));

    expect(await screen.findByText(/exited with code 1/)).toBeInTheDocument();
    // What the CLI printed, so a person is not left guessing at EO's
    // paraphrase of it.
    expect(screen.getByText("Error: invalid code")).toBeInTheDocument();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });
});

describe("the Codex flow", () => {
  it("offers no code field and waits for the child to finish it", async () => {
    const { sent } = renderDialog(CODEX);
    await signIn();

    expect(await screen.findByText(/no code to paste/)).toBeInTheDocument();
    expect(screen.queryByLabelText("Authorization code")).not.toBeInTheDocument();
    // The wait starts by itself: for Codex there is nothing for the
    // person to do here but sign in over there.
    await waitFor(() => expect(sent("runtime:submitSignInCode")[0]?.payload).toEqual({ sessionId: "session-1", code: null }));
  });

  it("falls back to a device code when the browser did not open", async () => {
    const { sent } = renderDialog(CODEX, {
      start: (mode) => (mode === "device" ? { verificationCode: "WDJB-MJHT", url: "https://auth.example.com/device" } : {}),
    });
    await signIn();

    fireEvent.click(await screen.findByRole("button", { name: /Browser didn't open/ }));

    // Both halves: the page to open and the code to type into it, which
    // is the opposite direction from Claude's.
    expect(await screen.findByText("WDJB-MJHT")).toBeInTheDocument();
    expect(screen.getByText("https://auth.example.com/device")).toBeInTheDocument();
    await waitFor(() => expect(sent("runtime:startSignIn").at(-1)?.payload).toMatchObject({ mode: "device" }));
  });
});

describe("when it does not work", () => {
  it("reports a cancellation rather than closing as though it had succeeded", async () => {
    const { sent, onOpenChange, onSignedIn, release } = renderDialog(CODEX);
    await signIn();
    await screen.findByText(/no code to paste/);

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    // What the main process answers the pending wait with once the
    // child has been killed.
    release({ state: "cancelled", problem: "Sign-in was cancelled, so Codex is still signed out." });

    expect(await screen.findByText(/still signed out/)).toBeInTheDocument();
    expect(sent("runtime:cancelSignIn")[0]?.payload).toEqual({ sessionId: "session-1" });
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    expect(onSignedIn).not.toHaveBeenCalled();
  });

  it("shows what the CLI printed when no URL ever arrived", async () => {
    renderDialog(CLAUDE, {
      start: {
        ok: false,
        sessionId: null,
        url: null,
        problem: "Claude Code printed no sign-in URL within 30 seconds. It printed:\nChecking for updates…",
        transcript: "Checking for updates…",
      },
    });
    await signIn();

    expect(await screen.findByText(/printed no sign-in URL/)).toBeInTheDocument();
    // And a way back in: a flow that failed is not a dialog you have to
    // close and find your way to again.
    expect(screen.getByRole("button", { name: /Try again/ })).toBeInTheDocument();
  });

  it("lets a retired wait land without taking the device flow down with it", async () => {
    // "Browser didn't open" kills the browser child and starts the
    // device one, and the killed child's wait is still outstanding when
    // it does. That wait comes back saying "cancelled" — about a session
    // nobody is looking at any more. Acting on it would clear the code
    // off the screen while the device child is still running and still
    // waiting for somebody to type it into the page.
    const { sent, onOpenChange, release } = renderDialog(CODEX, {
      start: (mode) =>
        mode === "device"
          ? { sessionId: "session-2", url: "https://auth.example.com/device", verificationCode: "WDJB-MJHT" }
          : { sessionId: "session-1" },
    });
    await signIn();
    await screen.findByText(/no code to paste/);

    fireEvent.click(screen.getByRole("button", { name: /Browser didn't open/ }));
    expect(await screen.findByText("WDJB-MJHT")).toBeInTheDocument();
    await waitFor(() => expect(sent("runtime:submitSignInCode").at(-1)?.payload).toEqual({ sessionId: "session-2", code: null }));

    // The browser child's wait, landing after the fallback took over.
    release({ state: "cancelled", problem: "Sign-in was cancelled, so Codex is still signed out." }, "session-1");

    // Still the device flow, still on screen, still the person's to
    // finish or to abandon.
    expect(await screen.findByText("WDJB-MJHT")).toBeInTheDocument();
    expect(screen.getByText("https://auth.example.com/device")).toBeInTheDocument();
    expect(screen.queryByText(/still signed out/)).not.toBeInTheDocument();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);

    // And cancelling now cancels the device child, not the one that was
    // killed to make room for it.
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(sent("runtime:cancelSignIn").at(-1)?.payload).toEqual({ sessionId: "session-2" }));
  });

  it("kills a child whose start lands after the dialog was closed", async () => {
    // The window between "EO spawned the CLI" and "EO has a session id"
    // is not instant — it lasts as long as the scrape for a URL does —
    // and Close is on screen for all of it, because the dialog only
    // reaches its waiting phase once the start has answered. Closing
    // there used to send nothing at all: there was no session id yet, so
    // there was nothing the close path knew how to cancel, and the flow
    // surfaced a moment later with no UI left to stop it.
    const view = renderDialog(CLAUDE, { holdStart: true });
    await signIn();

    fireEvent.click(screen.getByRole("button", { name: "Close dialog" }));
    // Nothing to cancel yet, which is precisely the trap.
    expect(view.sent("runtime:cancelSignIn")).toHaveLength(0);

    view.releaseStart();

    // The child is named at last, and killed on sight.
    await waitFor(() => expect(view.sent("runtime:cancelSignIn")).toHaveLength(1));
    expect(view.sent("runtime:cancelSignIn")[0]?.payload).toEqual({ sessionId: "session-1" });
    // And it does not climb back onto a dialog already dismissed.
    expect(screen.queryByText(/auth\.example\.com/)).not.toBeInTheDocument();
    expect(view.sent("runtime:submitSignInCode")).toHaveLength(0);
  });

  it("kills a child whose start lands after the dialog was unmounted", async () => {
    // The same window, but the dialog is gone rather than merely closed.
    // React drops a mutation's observer on unmount, so `onSuccess` is
    // not guaranteed to run at all — the cancellation has to be armed on
    // the promise itself, not on the callback.
    const view = renderDialog(CODEX, { holdStart: true });
    await signIn();

    view.unmount();
    view.releaseStart();

    await waitFor(() => expect(view.sent("runtime:cancelSignIn")).toHaveLength(1));
    expect(view.sent("runtime:cancelSignIn")[0]?.payload).toEqual({ sessionId: "session-1" });
    // Codex's browser half is a wait on the child. Never started here,
    // so nothing is left holding localhost:1455.
    expect(view.sent("runtime:submitSignInCode")).toHaveLength(0);
  });

  it("kills a running child when the dialog is closed outright", async () => {
    // Abandoning the dialog must not leave a child holding Codex's fixed
    // port with nobody to answer it.
    const { sent } = renderDialog(CODEX);
    await signIn();
    await screen.findByText(/no code to paste/);

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(sent("runtime:cancelSignIn")).toHaveLength(1));
  });
});

/**
 * The API-key way in (EO-84).
 *
 * Offered beside the subscription for both runtimes, and shaped by who
 * ends up holding the key. The failure worth guarding against is a
 * dialog that takes a billable secret without saying where it is going:
 * for Codex the CLI keeps it, for Claude EO does, and those are
 * different decisions for a person to make.
 */
describe("signing in with an API key", () => {
  async function chooseApiKey(): Promise<void> {
    fireEvent.click(await screen.findByRole("button", { name: "Use an API key" }));
  }

  it("is offered for both runtimes, beside the subscription sign-in", async () => {
    renderDialog(CODEX);
    expect(await screen.findByRole("button", { name: "Use an API key" })).toBeInTheDocument();

    renderDialog(CLAUDE);
    expect((await screen.findAllByRole("button", { name: "Use an API key" })).length).toBeGreaterThan(0);
  });

  it("pipes a Codex key to the CLI, and says the CLI is what keeps it", async () => {
    const view = renderDialog(CODEX);
    await chooseApiKey();

    expect(screen.getByText(/EO pipes the key to `codex login --with-api-key`/)).toBeInTheDocument();
    expect(screen.getByText(/EO keeps no copy/)).toBeInTheDocument();
    expect(screen.getByText(/never appears on a command line/)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("API key"), { target: { value: "sk-codex-secret" } });
    fireEvent.click(screen.getByRole("button", { name: "Use this key" }));

    await waitFor(() => expect(view.sent("runtime:signInWithApiKey")).toHaveLength(1));
    expect(view.sent("runtime:signInWithApiKey")[0]?.payload).toEqual({ provider: "codex", apiKey: "sk-codex-secret" });
    // The status re-probes rather than the dialog assuming the answer.
    await waitFor(() => expect(view.onSignedIn).toHaveBeenCalled());
    expect(view.onOpenChange).toHaveBeenCalledWith(false);
  });

  it("offers Claude the Console flow as well, and runs it as an ordinary sign-in", async () => {
    // `claude auth login --console` is API billing through the same
    // browser-plus-paste shape as the subscription login, and it leaves
    // the credential with the CLI rather than with EO.
    const view = renderDialog(CLAUDE);
    await chooseApiKey();

    fireEvent.click(await screen.findByRole("button", { name: "Sign in through the Anthropic Console" }));

    await waitFor(() => expect(view.sent("runtime:startSignIn")).toHaveLength(1));
    expect(view.sent("runtime:startSignIn")[0]?.payload).toMatchObject({ provider: "claude", mode: "console" });
    // And it is the same flow from there: a URL, then the code the page
    // displays.
    expect(await screen.findByLabelText("Authorization code")).toBeInTheDocument();
  });

  it("says that EO itself will hold a Claude key typed into it", async () => {
    // The one place EO stores a billable secret. Someone pasting one is
    // entitled to know that before they paste it, not after.
    renderDialog(CLAUDE);
    await chooseApiKey();

    expect(screen.getByText(/stores this one with your operating system's keychain/)).toBeInTheDocument();
    expect(screen.getByText(/never reaches EO's database, a comment or a log/)).toBeInTheDocument();
  });

  it("keeps the key out of the field once the call it was typed for has answered", async () => {
    // A rejected key is the case where it is most likely to be the wrong
    // string, and a secret sitting in a mounted component's state after
    // its call is a secret held for no reason.
    const view = renderDialog(CLAUDE, { withKey: { ok: false, heldBy: null, problem: "That key was rejected." } });
    await chooseApiKey();

    fireEvent.change(screen.getByLabelText("API key"), { target: { value: "sk-ant-secret" } });
    fireEvent.click(screen.getByRole("button", { name: "Use this key" }));

    expect(await screen.findByText("That key was rejected.")).toBeInTheDocument();
    expect(view.onOpenChange).not.toHaveBeenCalledWith(false);
    // Back to the key field, with nothing left in it.
    fireEvent.click(screen.getByRole("button", { name: "Use an API key" }));
    expect(await screen.findByLabelText("API key")).toHaveValue("");
  });

  it("does not offer the device fallback beside a field that opens no browser", async () => {
    renderDialog(CODEX);
    expect(await screen.findByRole("button", { name: "Browser didn't open" })).toBeInTheDocument();

    await chooseApiKey();

    expect(screen.queryByRole("button", { name: "Browser didn't open" })).not.toBeInTheDocument();
  });
});
