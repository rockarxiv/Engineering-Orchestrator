import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "@eo/ui";
import { createQueryClient } from "../../query/client";
import { setBridge, type RendererBridge } from "../../ipc/bridge";
import { DEFAULT_PRESET_ID, paletteOf } from "../theme";
import { browserName, ServedSignIn, ServedSignInGate } from "./ServedSignIn";

/**
 * Signing in to a server from the browser it serves (EO-326, ARCHITECTURE.md, "The server",
 * "Identity").
 *
 * What these hold is the shape of the answer rather than the form: a
 * browser that signs in comes away holding a **device token**, and is
 * therefore a row in the admin's Devices list, revocable there like a
 * laptop. That is what makes the design's second half possible at all — an
 * admin's decision is recorded against a person because the credential
 * it arrived on belongs to one, and the operator's key belongs to
 * nobody.
 */
function servedBridge(invoke: RendererBridge["invoke"]): void {
  setBridge({
    invoke,
    machineAvailable: false,
    subscribe: () => () => {},
    subscribeRefetch: () => () => {},
  });
}

afterEach(() => {
  setBridge(undefined);
  window.sessionStorage.clear();
  window.localStorage.clear();
});

function mount(node: React.ReactNode) {
  render(
    <ThemeProvider>
      <QueryClientProvider client={createQueryClient()}>{node}</QueryClientProvider>
    </ThemeProvider>,
  );
}

describe("the gate in front of a served browser", () => {
  it("lets a desktop straight through", () => {
    // There is no token on a desktop and none is wanted: the person at
    // the keyboard owns the machine. A sign-in form in front of a solo
    // installation would be asking somebody to prove they are themselves.
    setBridge({
      invoke: vi.fn(),
      machineAvailable: true,
      subscribe: () => () => {},
      subscribeRefetch: () => () => {},
    } as unknown as RendererBridge);

    mount(
      <ServedSignInGate>
        <p>the board</p>
      </ServedSignInGate>,
    );

    expect(screen.getByText("the board")).toBeInTheDocument();
  });

  it("lets a tab holding the operator's key straight through", () => {
    // Untouched by this story, and deliberately: it is how somebody
    // reaches a server whose people list is still empty, which is every
    // server on its first boot.
    servedBridge(vi.fn());
    window.sessionStorage.setItem("eo.serverToken", "the-operator-key");

    mount(
      <ServedSignInGate>
        <p>the board</p>
      </ServedSignInGate>,
    );

    expect(screen.getByText("the board")).toBeInTheDocument();
  });

  it("asks a tab holding nothing to sign in", () => {
    // Rather than letting it draw a board out of eleven refusals that
    // each say "this EO server needs its admin token" — a sentence about
    // a stand-in, to somebody who has an account.
    servedBridge(vi.fn());

    mount(
      <ServedSignInGate>
        <p>the board</p>
      </ServedSignInGate>,
    );

    expect(screen.queryByText("the board")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Sign in to this EO server" })).toBeInTheDocument();
    // In the chat layout's look, with no theme ever chosen here (EO-527).
    expect(document.documentElement.style.getPropertyValue("--color-canvas")).toBe(paletteOf({ kind: "preset", id: DEFAULT_PRESET_ID })["--color-canvas"]);
  });
});

describe("signing in from a browser", () => {
  it("keeps the token it is given, and the device row it is for", async () => {
    const invoke = vi.fn(async () => ({
      ok: true as const,
      data: { session: { token: "a-device-token", deviceId: "device-7", person: { id: "p-dana", name: "Dana", email: "dana@example.com", isAdmin: true, invitedAt: null, acceptedAt: null, credentialKind: null } }, problem: null },
    }));
    servedBridge(invoke as unknown as RendererBridge["invoke"]);

    mount(<ServedSignIn />);
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "dana@example.com" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "correct horse battery staple" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() => expect(window.sessionStorage.getItem("eo.serverToken")).toBe("a-device-token"));
    // The token in `sessionStorage`, so a credential does not outlive the
    // tab it was typed into; the device id in `localStorage`, which is
    // not a secret and is what stops the admin's Devices list growing a
    // row every time somebody opens the address.
    expect(window.localStorage.getItem("eo.deviceId")).toBe("device-7");
  });

  it("signs in onto the row this browser held before", async () => {
    // Typed as the bridge's own `invoke` so the recorded call is a
    // `(channel, payload)` pair rather than an empty tuple — `vi.fn`
    // infers the arguments from the implementation, and one that takes
    // none records none.
    const invoke = vi.fn(async (_channel: string, _payload: unknown) => ({
      ok: true as const,
      data: { session: { token: "a-second-token", deviceId: "device-7", person: { id: "p-dana", name: "Dana", email: null, isAdmin: true, invitedAt: null, acceptedAt: null, credentialKind: null } }, problem: null },
    }));
    servedBridge(invoke as unknown as RendererBridge["invoke"]);
    window.localStorage.setItem("eo.deviceId", "device-7");

    mount(<ServedSignIn />);
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "dana@example.com" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() => expect(invoke).toHaveBeenCalled());
    expect(invoke).toHaveBeenCalledWith("auth:signIn", expect.objectContaining({ email: "dana@example.com", deviceId: "device-7" }));
  });

  it("shows the server's one sentence when it will not have you", async () => {
    // One sentence for every failure, which is the server's own rule:
    // telling "no such person" from "wrong password" is how a form
    // becomes a way to learn who is on the list.
    const invoke = vi.fn(async () => ({ ok: true as const, data: { session: null, problem: "That email and password do not match." } }));
    servedBridge(invoke as unknown as RendererBridge["invoke"]);

    mount(<ServedSignIn />);
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "dana@example.com" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "nope" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByText("That email and password do not match.")).toBeInTheDocument();
    expect(window.sessionStorage.getItem("eo.serverToken")).toBeNull();
  });
});

describe("what the admin's Devices list will call a browser", () => {
  it("names the browser, coarsely", () => {
    // Coarse on purpose: the list exists so somebody can recognise a row
    // they want to revoke, and a full user-agent string is unreadable
    // and more about the machine than anybody asked for.
    expect(browserName("Mozilla/5.0 (X11; Linux x86_64; rv:129.0) Gecko/20100101 Firefox/129.0")).toBe("Firefox");
    expect(browserName("Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15")).toBe("Safari");
    // Edge and Opera both carry `Chrome/` in their own strings, so the
    // order the tests are written in is the order the checks have to be.
    expect(browserName("Mozilla/5.0 (Windows NT 10.0) Chrome/126.0 Safari/537.36 Edg/126.0")).toBe("Edge");
    expect(browserName("Mozilla/5.0 (Windows NT 10.0) Chrome/126.0 Safari/537.36")).toBe("Chrome");
  });

  it("says something honest about one it does not recognise", () => {
    expect(browserName("something nobody has heard of")).toBe("A browser");
  });
});
