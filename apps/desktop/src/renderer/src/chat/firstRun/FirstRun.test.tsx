import { QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GalleryTemplateView, RuntimeStatusView } from "@eo/core";
import { ThemeProvider } from "@eo/ui";
import { setBridge } from "../../ipc/bridge";
import { createQueryClient } from "../../query/client";
import { absent, signedIn, signedOut } from "../views/agents/testRuntimes";
import { DEFAULT_PRESET_ID, paletteOf, setThemeChoice, THEME_STORAGE_KEY } from "../theme";
import { FirstRun } from "./FirstRun";
import { FirstRunGate } from "./FirstRunGate";

/**
 * First run, in the order the design settled (EO-317, the original design).
 *
 * "Mode, then gallery, then optional Preview with no sign-in, then the
 * template's own blanks, then the needs check … then the first real
 * item." What is asserted here is the **order** — the thing the finding
 * was about — and the one question that comes before everything else.
 * The gallery's own three screens are asserted where they live.
 */

const TEMPLATE: GalleryTemplateView = {
  slug: "weekly-report",
  token: "weekly-v1",
  title: "Weekly report",
  description: "Every week, EO reads a folder and writes the report.",
  version: "1.0",
  source: "Bundled with EO",
  bundled: true,
  pipelineName: "Weekly report",
  needs: [],
  blanks: [],
  roleSlots: [],
  solo: true,
  previewable: true,
};

/**
 * `runtimes` is what this machine has, by default a signed-in Claude, so
 * the tests about step 1 go on to the gallery as they always have. The
 * sign-in channels sign Claude in, the way a finished `claude auth login`
 * would, and `runtime:install` answers `installProblem` when given one.
 */
function mockIpc(
  state: { done: boolean; mode: "solo" | "organisation" | null },
  options: { runtimes?: RuntimeStatusView[]; installProblem?: string; templates?: GalleryTemplateView[]; signInProblem?: string } = {},
) {
  const stored = { ...state };
  const runtimes = [...(options.runtimes ?? [signedIn("claude", "Claude Code"), absent("codex", "Codex")])];
  const invoke = vi.fn(async (channel: string, payload: unknown) => {
    switch (channel) {
      case "runtime:status": {
        const provider = (payload as { provider: string }).provider;
        return { ok: true, data: { runtime: runtimes.find((runtime) => runtime.id === provider) ?? null } };
      }
      case "runtime:describe":
        return { ok: true, data: { unpackedBytes: 1_000_000, sourceUrl: null, problem: null } };
      case "runtime:install":
        return options.installProblem === undefined
          ? { ok: true, data: { ok: true, runtime: null, problem: null } }
          : { ok: true, data: { ok: false, runtime: null, problem: options.installProblem } };
      case "runtime:startSignIn":
        return {
          ok: true,
          data: { ok: true, sessionId: "session-1", url: "https://auth.example.com/", verificationCode: null, needsCode: true, opened: true, transcript: "", problem: null },
        };
      case "runtime:setEnabled": {
        const { provider, enabled } = payload as { provider: string; enabled: boolean };
        const index = runtimes.findIndex((runtime) => runtime.id === provider);
        runtimes[index] = { ...runtimes[index]!, enabled, state: enabled ? "ready" : "disabled" };
        return { ok: true, data: { ok: true, runtime: runtimes[index], problem: null } };
      }
      case "runtime:submitSignInCode": {
        const index = runtimes.findIndex((runtime) => runtime.id === "claude");
        runtimes[index] = signedIn("claude", "Claude Code");
        return { ok: true, data: { ok: true, state: "signed_in", transcript: "", problem: null } };
      }
      // A copy each time, not the held object: the screen compares what
      // it was given with what it has, and handing back the very object
      // it already holds is a change it cannot see.
      case "firstRun:state":
        return { ok: true, data: { ...stored } };
      case "firstRun:setMode": {
        stored.mode = (payload as { mode: "solo" | "organisation" }).mode;
        return { ok: true, data: { mode: stored.mode } };
      }
      case "session:signIn":
        return { ok: true, data: { status: { state: "signed-out" }, problem: options.signInProblem ?? null } };
      case "gallery:list":
        return { ok: true, data: { templates: options.templates ?? [], fetched: false, people: [] } };
      // A template with no job, every line green (EO-664).
      case "gallery:use":
        return { ok: true, data: { projectId: "p1", pipelineId: "pl1", jobId: null, needs: [], problem: null } };
      case "gallery:needs":
        return { ok: true, data: { needs: [], jobId: null, problem: null } };
      case "gallery:openFirstItemChat":
        return { ok: true, data: { conversation: { id: "chat-1", messages: [] }, problem: null } };
      case "firstRun:finish":
        stored.done = true;
        return { ok: true, data: { done: true } };
      default:
        return { ok: true, data: {} };
    }
  });
  window.eo.ipc.invoke = invoke as never;
  window.eo.ipc.subscribe = vi.fn(() => () => {}) as never;
  return invoke;
}

function renderFirstRun(node: React.ReactNode) {
  return render(
    <ThemeProvider>
      <QueryClientProvider client={createQueryClient()}>
        <MemoryRouter>{node}</MemoryRouter>
      </QueryClientProvider>
    </ThemeProvider>,
  );
}

beforeEach(() => window.sessionStorage.clear());
afterEach(() => setBridge(undefined));

describe("step 1, before anything else", () => {
  it("asks solo or organisation, and shows no gallery until it is answered", async () => {
    mockIpc({ done: false, mode: null });
    renderFirstRun(<FirstRun onLeft={() => {}} />);

    expect(await screen.findByText("Is this just you, or is it for an organisation?")).toBeInTheDocument();
    expect(screen.queryByText("Start with a template")).not.toBeInTheDocument();
  });

  it("goes straight to the gallery on Just me", async () => {
    const invoke = mockIpc({ done: false, mode: null });
    renderFirstRun(<FirstRun onLeft={() => {}} />);

    fireEvent.click(await screen.findByRole("button", { name: "Just me" }));

    expect(await screen.findByText("Start with a template")).toBeInTheDocument();
    expect(invoke.mock.calls.find((call: unknown[]) => call[0] === "firstRun:setMode")?.[1]).toEqual({ mode: "solo", address: "" });
  });

  const setModeCall = (invoke: ReturnType<typeof mockIpc>) => invoke.mock.calls.find((call: unknown[]) => call[0] === "firstRun:setMode")?.[1];
  const fillAccount = (address: string) => {
    if (address !== "") fireEvent.change(screen.getByLabelText("Server address"), { target: { value: address } });
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "dana@acme.com" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "correct horse battery" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
  };

  /**
   * "Organisation asks for a server address, signs in, and pulls the
   * published packs" (EO-661): through `session:signIn`, the same call
   * Settings → Organisation makes, and the mode is recorded only once it
   * has succeeded.
   */
  it("signs in with an account and goes on as an organisation", async () => {
    const invoke = mockIpc({ done: false, mode: null });
    renderFirstRun(<FirstRun onLeft={() => {}} />);

    fireEvent.click(await screen.findByRole("button", { name: "My organisation" }));
    fireEvent.click(await screen.findByRole("button", { name: "I have an account" }));
    fillAccount("https://eo.acme.com");

    await waitFor(() => expect(setModeCall(invoke)).toEqual({ mode: "organisation", address: "https://eo.acme.com" }));
    expect(invoke.mock.calls.find((call: unknown[]) => call[0] === "session:signIn")?.[1]).toEqual({
      address: "https://eo.acme.com",
      email: "dana@acme.com",
      password: "correct horse battery",
    });
    expect(await screen.findByText("Start with a template")).toBeInTheDocument();
  });

  it("shows what the sign-in said when it fails, and keeps what was typed", async () => {
    const invoke = mockIpc({ done: false, mode: null }, { signInProblem: "That email and password do not match an account on this server." });
    renderFirstRun(<FirstRun onLeft={() => {}} />);

    fireEvent.click(await screen.findByRole("button", { name: "My organisation" }));
    fireEvent.click(await screen.findByRole("button", { name: "I have an account" }));
    fillAccount("https://eo.acme.com");

    expect(await screen.findByText("That email and password do not match an account on this server.")).toBeInTheDocument();
    expect(screen.getByLabelText("Server address")).toHaveValue("https://eo.acme.com");
    expect(screen.getByLabelText("Email")).toHaveValue("dana@acme.com");
    expect(screen.getByLabelText("Password")).toHaveValue("correct horse battery");
    expect(setModeCall(invoke)).toBeUndefined();
    expect(screen.queryByText("Start with a template")).not.toBeInTheDocument();
  });

  it("opens an invitation link in the browser, then signs in on the server it named", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const invoke = mockIpc({ done: false, mode: null });
    renderFirstRun(<FirstRun onLeft={() => {}} />);

    fireEvent.click(await screen.findByRole("button", { name: "My organisation" }));
    fireEvent.click(await screen.findByRole("button", { name: "I have an invitation link" }));
    fireEvent.change(screen.getByLabelText("Invitation link"), { target: { value: "https://eo.acme.com/invite/a1b2c3" } });
    fireEvent.click(screen.getByRole("button", { name: "Open the invitation" }));

    expect(open).toHaveBeenCalledWith("https://eo.acme.com/invite/a1b2c3", "_blank", "noopener,noreferrer");
    expect(await screen.findByText(/Choose your password there/)).toBeInTheDocument();
    expect(screen.getByLabelText("Server address")).toHaveValue("https://eo.acme.com");

    fillAccount("");
    await waitFor(() => expect(setModeCall(invoke)).toEqual({ mode: "organisation", address: "https://eo.acme.com" }));
    open.mockRestore();
  });

  it.each(["https://eo.acme.com/project", "https://eo.acme.com/invite/..", "https://eo.acme.com/invite/%2e%2e"])("refuses %s, which is not an invitation, before opening anything", async (link) => {
    // What a browser would actually open, so the case is judged by the URL semantics the link will meet.
    if (link.includes("/invite/")) expect(new URL(link).pathname).toBe("/");
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    mockIpc({ done: false, mode: null });
    renderFirstRun(<FirstRun onLeft={() => {}} />);

    fireEvent.click(await screen.findByRole("button", { name: "My organisation" }));
    fireEvent.click(await screen.findByRole("button", { name: "I have an invitation link" }));
    fireEvent.change(screen.getByLabelText("Invitation link"), { target: { value: link } });
    fireEvent.click(screen.getByRole("button", { name: "Open the invitation" }));

    expect(await screen.findByText(/One looks like https:\/\/eo\.example\.com\/invite\//)).toBeInTheDocument();
    expect(open).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("Password")).not.toBeInTheDocument();
    open.mockRestore();
  });

  it("says an invitation is needed without either, and continues on my own as solo", async () => {
    const invoke = mockIpc({ done: false, mode: null });
    renderFirstRun(<FirstRun onLeft={() => {}} />);

    fireEvent.click(await screen.findByRole("button", { name: "My organisation" }));
    expect(await screen.findByText(/you need to be invited by whoever runs your organisation's EO server/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Continue on my own" }));

    await waitFor(() => expect(setModeCall(invoke)).toEqual({ mode: "solo", address: "" }));
    expect(await screen.findByText("Start with a template")).toBeInTheDocument();
    expect(invoke.mock.calls.some((call: unknown[]) => call[0] === "session:signIn")).toBe(false);
  });

  it("resumes at the gallery for somebody who already answered", async () => {
    mockIpc({ done: false, mode: "solo" });
    renderFirstRun(<FirstRun onLeft={() => {}} />);

    expect(await screen.findByText("Start with a template")).toBeInTheDocument();
    expect(screen.queryByText("Is this just you, or is it for an organisation?")).not.toBeInTheDocument();
  });
});

/**
 * Step 2, "Connect a coding agent" (EO-659): between the welcome question
 * and the gallery, and only while nothing on this machine is signed in.
 * The three states a machine can be in are the three tests that open it.
 */
describe("connecting a coding agent", () => {
  const answerSolo = async () => fireEvent.click(await screen.findByRole("button", { name: "Just me" }));

  it("offers every managed runtime when none is installed, and installs on the Runtimes channel", async () => {
    const invoke = mockIpc({ done: false, mode: null }, { runtimes: [absent("codex", "Codex"), absent("claude", "Claude Code")] });
    renderFirstRun(<FirstRun onLeft={() => {}} />);
    await answerSolo();

    expect(await screen.findByRole("heading", { name: "Connect a coding agent" })).toBeInTheDocument();
    expect(screen.queryByText("Start with a template")).not.toBeInTheDocument();
    const list = screen.getByRole("list", { name: "Coding agents" });
    expect(within(list).getByRole("button", { name: "Install Codex" })).toBeInTheDocument();
    expect(within(list).getByRole("button", { name: "Install Claude Code" })).toBeInTheDocument();

    // The consent Agents → Runtimes shows, then the same channel.
    fireEvent.click(within(list).getByRole("button", { name: "Install Claude Code" }));
    fireEvent.click(await screen.findByRole("button", { name: "Download" }));
    await waitFor(() => expect(invoke.mock.calls.find((call: unknown[]) => call[0] === "runtime:install")?.[1]).toEqual({ provider: "claude" }));
  });

  it("says what the install channel said when the download fails", async () => {
    mockIpc(
      { done: false, mode: "solo" },
      { runtimes: [absent("codex", "Codex"), absent("claude", "Claude Code")], installProblem: "EO could not reach the npm registry: offline" },
    );
    renderFirstRun(<FirstRun onLeft={() => {}} />);

    fireEvent.click(await screen.findByRole("button", { name: "Install Codex" }));
    fireEvent.click(await screen.findByRole("button", { name: "Download" }));
    expect(await screen.findByText("EO could not reach the npm registry: offline")).toBeInTheDocument();
  });

  it("signs an installed runtime in with the sign-in dialog, and goes on to the gallery by itself", async () => {
    mockIpc({ done: false, mode: null }, { runtimes: [absent("codex", "Codex"), signedOut("claude", "Claude Code")] });
    renderFirstRun(<FirstRun onLeft={() => {}} />);
    await answerSolo();

    fireEvent.click(await screen.findByRole("button", { name: "Sign in to Claude Code" }));
    const dialog = await screen.findByRole("dialog", { name: "Sign in to Claude Code" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Sign in" }));
    fireEvent.change(await within(dialog).findByLabelText("Authorization code"), { target: { value: "pasted-code" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Submit" }));

    // No further press: the statuses are asked again and one now says signed in.
    expect(await screen.findByText("Start with a template")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Connect a coding agent" })).not.toBeInTheDocument();
  });

  it("is not shown when a backend is already signed in", async () => {
    mockIpc({ done: false, mode: null }, { runtimes: [absent("codex", "Codex"), signedIn("claude", "Claude Code")], templates: [TEMPLATE] });
    renderFirstRun(<FirstRun onLeft={() => {}} />);
    await answerSolo();

    expect(await screen.findByText("Start with a template")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Connect a coding agent" })).not.toBeInTheDocument();
    const card = await screen.findByRole("region", { name: "Weekly report" });
    expect(within(card).getByRole("button", { name: "Use this" })).toBeEnabled();
    expect(within(card).queryByRole("button", { name: "Connect a coding agent" })).toBeNull();
  });

  it("looks around first: Preview works, Use this waits, and the card leads back to this step", async () => {
    mockIpc({ done: false, mode: "solo" }, { runtimes: [absent("codex", "Codex"), absent("claude", "Claude Code")], templates: [TEMPLATE] });
    renderFirstRun(<FirstRun onLeft={() => {}} />);

    fireEvent.click(await screen.findByRole("button", { name: "Look around first" }));

    const card = await screen.findByRole("region", { name: "Weekly report" });
    expect(within(card).getByRole("button", { name: "Use this" })).toBeDisabled();
    expect(within(card).getByRole("button", { name: "Preview" })).toBeEnabled();
    expect(within(card).getByText(/needs a coding agent/)).toBeInTheDocument();

    fireEvent.click(within(card).getByRole("button", { name: "Connect a coding agent" }));
    expect(await screen.findByRole("heading", { name: "Connect a coding agent" })).toBeInTheDocument();
  });

  it("remembers Look around first across a trip to a preview item", async () => {
    mockIpc({ done: false, mode: "solo" }, { runtimes: [absent("codex", "Codex"), absent("claude", "Claude Code")] });
    const first = renderFirstRun(<FirstRun onLeft={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Look around first" }));
    expect(await screen.findByText("Start with a template")).toBeInTheDocument();
    first.unmount();

    renderFirstRun(<FirstRun onLeft={() => {}} />);
    expect(await screen.findByText("Start with a template")).toBeInTheDocument();
  });

  it("says signing in happens on the machine that runs the agent, on a served tab, and offers only Look around first", async () => {
    mockIpc({ done: false, mode: "solo" });
    setBridge({
      invoke: ((channel: string, payload: unknown) => window.eo.ipc.invoke(channel as never, payload as never)) as never,
      machineAvailable: false,
      subscribe: () => () => {},
      subscribeRefetch: () => () => {},
    });
    renderFirstRun(<FirstRun onLeft={() => {}} />);

    expect(await screen.findByRole("heading", { name: "Connect a coding agent" })).toBeInTheDocument();
    expect(screen.getByText(/happens on the machine that runs the agent/)).toBeInTheDocument();
    expect(screen.getAllByRole("button").map((button) => button.textContent)).toEqual(["Look around first"]);
  });

  /** Nothing here can establish a sign-in, so the gallery behind it stays Preview-only. */
  it("keeps the gallery to Preview on a served tab", async () => {
    mockIpc({ done: false, mode: "solo" }, { templates: [TEMPLATE] });
    setBridge({
      invoke: ((channel: string, payload: unknown) => window.eo.ipc.invoke(channel as never, payload as never)) as never,
      machineAvailable: false,
      subscribe: () => () => {},
      subscribeRefetch: () => () => {},
    });
    renderFirstRun(<FirstRun onLeft={() => {}} />);

    fireEvent.click(await screen.findByRole("button", { name: "Look around first" }));
    const card = await screen.findByRole("region", { name: "Weekly report" });
    expect(within(card).getByRole("button", { name: "Use this" })).toBeDisabled();
    expect(within(card).getByRole("button", { name: "Preview" })).toBeEnabled();
    expect(within(card).getByRole("button", { name: "Connect a coding agent" })).toBeInTheDocument();
  });

  /**
   * A managed copy somebody turned off, and nobody is signed in to: turned
   * back on here, with the Runtimes card's own call, and then signed in.
   */
  it("turns a turned-off runtime back on, and then offers its sign-in", async () => {
    const invoke = mockIpc(
      { done: false, mode: "solo" },
      { runtimes: [absent("codex", "Codex"), { ...signedOut("claude", "Claude Code"), state: "disabled", enabled: false }] },
    );
    renderFirstRun(<FirstRun onLeft={() => {}} />);

    fireEvent.click(await screen.findByRole("button", { name: "Turn on Claude Code" }));
    await waitFor(() =>
      expect(invoke.mock.calls.find((call: unknown[]) => call[0] === "runtime:setEnabled")?.[1]).toEqual({ provider: "claude", enabled: true }),
    );
    expect(await screen.findByRole("button", { name: "Sign in to Claude Code" })).toBeInTheDocument();
  });
});

/**
 * Drawn in the chat layout's look (EO-527). The flow sits above the
 * frame, so it paints this device's theme itself — the default preset on
 * a device that has never chosen one, which is every fresh installation.
 */
describe("its look", () => {
  const rootColour = (name: string) => document.documentElement.style.getPropertyValue(name);

  it("wears the default chat theme on a device that has never chosen one, and takes it off on the way out", async () => {
    window.localStorage.removeItem(THEME_STORAGE_KEY);
    mockIpc({ done: false, mode: null });
    const { unmount } = renderFirstRun(<FirstRun onLeft={() => {}} />);

    expect(await screen.findByRole("heading", { name: "Welcome to EO" })).toBeInTheDocument();
    expect(rootColour("--color-canvas")).toBe(paletteOf({ kind: "preset", id: DEFAULT_PRESET_ID })["--color-canvas"]);

    unmount();
    expect(rootColour("--color-canvas")).toBe("");
  });

  it("wears the theme this device chose", async () => {
    setThemeChoice({ kind: "preset", id: "nord" });
    mockIpc({ done: false, mode: "solo" });
    const { unmount } = renderFirstRun(<FirstRun onLeft={() => {}} />);

    expect(await screen.findByText("Start with a template")).toBeInTheDocument();
    expect(rootColour("--color-accent")).toBe(paletteOf({ kind: "preset", id: "nord" })["--color-accent"]);

    unmount();
    setThemeChoice({ kind: "preset", id: DEFAULT_PRESET_ID });
  });
});

describe("the gate", () => {
  it("shows the flow instead of the app while there is nothing of their own", async () => {
    mockIpc({ done: false, mode: null });
    renderFirstRun(
      <FirstRunGate>
        <span data-testid="the-app" />
      </FirstRunGate>,
    );

    expect(await screen.findByText("Is this just you, or is it for an organisation?")).toBeInTheDocument();
    expect(screen.queryByTestId("the-app")).not.toBeInTheDocument();
  });

  /** Which is every installation that predates this story, and every one that has finished the flow. */
  it("gets out of the way once first run is behind them", async () => {
    mockIpc({ done: true, mode: "solo" });
    renderFirstRun(
      <FirstRunGate>
        <span data-testid="the-app" />
      </FirstRunGate>,
    );

    expect(await screen.findByTestId("the-app")).toBeInTheDocument();
    expect(screen.queryByText("Is this just you, or is it for an organisation?")).not.toBeInTheDocument();
  });

  /**
   * Step 3 is watched where it happens (the original design).
   *
   * "Preview this pipeline walks an example item through every step …
   * the person sees the product work before it asks them for
   * anything" — so the item it files is let through the gate. Holding
   * the window on the gallery would be the flow talking over its own
   * demonstration.
   */
  it("lets the preview item through, so the rehearsal can be watched", async () => {
    mockIpc({ done: false, mode: "solo" });
    render(
      <ThemeProvider>
        <QueryClientProvider client={createQueryClient()}>
          <MemoryRouter initialEntries={["/items/preview-1"]}>
            <FirstRunGate>
              <span data-testid="the-app" />
            </FirstRunGate>
          </MemoryRouter>
        </QueryClientProvider>
      </ThemeProvider>,
    );

    expect(await screen.findByTestId("the-app")).toBeInTheDocument();
    expect(screen.queryByText("Start with a template")).not.toBeInTheDocument();
  });

  /**
   * A template with no job ends in the assistant (EO-664), and that is an
   * exit like the others: first run is marked behind them, and the gate
   * lets the app — the chat the brief was posted in — through at once.
   */
  it("lets the app through once the needs check opens the assistant with the first item's brief", async () => {
    const content: GalleryTemplateView = { ...TEMPLATE, slug: "content-draft-and-approve", token: "content-v1", title: "Content draft and approve", previewable: false };
    const invoke = mockIpc({ done: false, mode: "solo" }, { templates: [content] });
    renderFirstRun(
      <FirstRunGate>
        <span data-testid="the-app" />
      </FirstRunGate>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Use this" }));
    fireEvent.click(await screen.findByRole("button", { name: "Create" }));
    fireEvent.click(await screen.findByRole("button", { name: /^Plan the first .+ with the assistant$/ }));

    expect(await screen.findByTestId("the-app")).toBeInTheDocument();
    expect(invoke).toHaveBeenCalledWith("gallery:openFirstItemChat", { projectId: "p1", slug: "content-draft-and-approve", token: "content-v1", pipelineId: "pl1" });
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("firstRun:finish", undefined));
  });

  /**
   * And nothing is drawn while the question is in flight: an
   * installation halfway through first run must not be shown a flash of
   * the empty board the design exists to replace.
   */
  it("draws nothing at all before it knows", () => {
    window.eo.ipc.invoke = vi.fn(() => new Promise(() => {})) as never;
    const { container } = renderFirstRun(
      <FirstRunGate>
        <span data-testid="the-app" />
      </FirstRunGate>,
    );

    expect(container.textContent).toBe("");
    expect(screen.queryByTestId("the-app")).not.toBeInTheDocument();
  });
});
