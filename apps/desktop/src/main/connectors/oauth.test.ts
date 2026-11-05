import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { ConnectorOAuth } from "@eo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runConnectorOAuth } from "./oauth.js";

/**
 * The `oauth` setup kind, driven end to end against a fake provider
 * (EO-315, ARCHITECTURE.md, "A connector is an MCP server with a setup flow").
 *
 * A real listener, a real redirect and a real code exchange over
 * loopback — nothing here is a stub of EO's own side. What is fake is
 * the *provider*: an HTTP server that answers `/authorize` with a 302 to
 * whatever `redirect_uri` it was handed and `/token` with a JSON body,
 * which is what an authorization server does and what makes this a drive
 * of the flow rather than an assertion about it.
 *
 * The browser is the person's, so it is injected: `openExternal` here
 * fetches the authorize URL and follows the redirect, which is the one
 * thing a browser does that this flow depends on.
 */

interface FakeProvider {
  server: Server;
  origin: string;
  /** Every `/authorize` query EO sent, so the test can check what a provider is actually told. */
  authorizeQueries: URLSearchParams[];
  /** Every `/token` body EO posted. */
  tokenBodies: URLSearchParams[];
  /** Flipped to make the provider refuse. */
  refuseWith: string | null;
}

function startFakeProvider(): Promise<FakeProvider> {
  const state: FakeProvider = {
    server: createServer(),
    origin: "",
    authorizeQueries: [],
    tokenBodies: [],
    refuseWith: null,
  };

  state.server.on("request", (request, response) => {
    const url = new URL(request.url ?? "/", state.origin);

    if (url.pathname === "/authorize") {
      state.authorizeQueries.push(url.searchParams);
      const redirect = new URL(url.searchParams.get("redirect_uri") ?? "");
      if (state.refuseWith !== null) {
        redirect.searchParams.set("error", state.refuseWith);
      } else {
        redirect.searchParams.set("code", "the-code");
      }
      redirect.searchParams.set("state", url.searchParams.get("state") ?? "");
      response.writeHead(302, { location: redirect.href });
      response.end();
      return;
    }

    if (url.pathname === "/token") {
      let body = "";
      request.on("data", (chunk) => (body += String(chunk)));
      request.on("end", () => {
        const parsed = new URLSearchParams(body);
        state.tokenBodies.push(parsed);

        // The provider checks PKCE, because a provider does: a test
        // where the challenge is sent and never verified would pass on a
        // flow that sent a constant.
        const verifier = parsed.get("code_verifier") ?? "";
        const challenge = state.authorizeQueries.at(-1)?.get("code_challenge") ?? "";
        const matches = createHash("sha256").update(verifier).digest("base64url") === challenge;

        response.writeHead(matches ? 200 : 400, { "content-type": "application/json" });
        response.end(JSON.stringify(matches ? { access_token: "xoxb-the-token", token_type: "bearer" } : { error: "invalid_grant" }));
      });
      return;
    }

    response.writeHead(404);
    response.end();
  });

  return new Promise((resolve) => {
    state.server.listen(0, "127.0.0.1", () => {
      const address = state.server.address() as AddressInfo;
      state.origin = `http://127.0.0.1:${address.port}`;
      resolve(state);
    });
  });
}

let provider: FakeProvider;

beforeEach(async () => {
  provider = await startFakeProvider();
});

afterEach(() => {
  provider.server.close();
  provider.server.closeAllConnections?.();
});

function oauth(): ConnectorOAuth {
  return {
    authorizeUrl: `${provider.origin}/authorize`,
    tokenUrl: `${provider.origin}/token`,
    clientId: "eo-desktop",
    scopes: ["chat:write", "channels:read"],
    tokenSecretName: "SLACK_BOT_TOKEN",
  };
}

/** A browser: opens the URL and follows wherever it is sent, which lands on EO's loopback listener. */
const browser = (opened: string[]) => async (url: string) => {
  opened.push(url);
  await fetch(url, { redirect: "follow" });
};

describe("a connector's OAuth flow", () => {
  it("opens the provider's URL and completes on the loopback callback", async () => {
    const opened: string[] = [];

    const result = await runConnectorOAuth({ oauth: oauth(), openExternal: browser(opened), timeoutMs: 10_000 });

    expect(result).toEqual({ ok: true, token: "xoxb-the-token" });
    expect(opened).toHaveLength(1);

    const query = provider.authorizeQueries[0]!;
    expect(query.get("response_type")).toBe("code");
    expect(query.get("client_id")).toBe("eo-desktop");
    expect(query.get("scope")).toBe("chat:write channels:read");
    // Loopback by address, and a redirect EO can only have built from a
    // port it actually bound (RFC 8252).
    expect(query.get("redirect_uri")).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    // PKCE on every flow, whether or not the provider asks: a desktop
    // app is a public client and has no secret to fall back on.
    expect(query.get("code_challenge_method")).toBe("S256");
    expect(query.get("code_challenge")).toBeTruthy();

    const body = provider.tokenBodies[0]!;
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code")).toBe("the-code");
    expect(body.get("redirect_uri")).toBe(query.get("redirect_uri"));
  });

  it("omits scope entirely when the connector asks for none", async () => {
    // Rather than sending `scope=`: a provider reading that as "no
    // scopes" and one reading it as "the default set" both exist, and an
    // absent parameter is the only spelling they agree on.
    await runConnectorOAuth({ oauth: { ...oauth(), scopes: [] }, openExternal: browser([]), timeoutMs: 10_000 });

    expect(provider.authorizeQueries[0]!.has("scope")).toBe(false);
  });

  it("reports a provider that refuses, in the provider's own words", async () => {
    provider.refuseWith = "access_denied";

    const result = await runConnectorOAuth({ oauth: oauth(), openExternal: browser([]), timeoutMs: 10_000 });

    expect(result).toEqual({ ok: false, reason: "The provider refused the sign-in: access_denied." });
    // Nothing was redeemed: a refusal must not reach the token endpoint.
    expect(provider.tokenBodies).toHaveLength(0);
  });

  /**
   * The listener is on loopback, where anything else running as the
   * person could reach it. The state is what says a redirect belongs to
   * the flow EO started, and a mismatch is never redeemed.
   */
  it("ignores a callback that did not belong to the request it made", async () => {
    const forge = async (url: string) => {
      const redirect = new URL(new URL(url).searchParams.get("redirect_uri") ?? "");
      redirect.searchParams.set("code", "somebody-elses-code");
      redirect.searchParams.set("state", "not-the-state-eo-sent");
      await fetch(redirect.href);
    };

    const result = await runConnectorOAuth({ oauth: oauth(), openExternal: forge, timeoutMs: 10_000 });

    expect(result).toEqual({ ok: false, reason: "That sign-in did not belong to the request EO made, so it was ignored." });
    expect(provider.tokenBodies).toHaveLength(0);
  });

  it("refuses rather than waiting when the browser will not open", async () => {
    const result = await runConnectorOAuth({
      oauth: oauth(),
      openExternal: () => Promise.reject(new Error("no browser here")),
      timeoutMs: 10_000,
    });

    expect(result).toEqual({ ok: false, reason: "EO could not open your browser, so the sign-in was not started." });
  });

  /**
   * Invariant 9's rule one level down from a run: a flow nobody finishes
   * ends, with a sentence, rather than holding a port and a promise open
   * until EO is quit.
   */
  it("stops waiting, and says so, when nobody completes the sign-in", async () => {
    const result = await runConnectorOAuth({ oauth: oauth(), openExternal: async () => {}, timeoutMs: 40 });

    expect(result).toEqual({ ok: false, reason: "The sign-in was not completed in five minutes, so EO stopped waiting for it." });
  });

  /**
   * The half the first cut left unbounded. The listener's timer ends
   * once the callback arrives, so a token endpoint that accepts the
   * connection and never answers held the Connect button pending and the
   * loopback port bound until EO was quit. One deadline covers both
   * halves now — which is also why the promise a person is waiting on
   * cannot take twice the timeout they were told about.
   */
  it("stops waiting when the provider takes the sign-in and never answers", async () => {
    const started = Date.now();

    const result = await runConnectorOAuth({
      oauth: oauth(),
      openExternal: browser([]),
      timeoutMs: 300,
      // Accepts and never settles — and ignores the abort signal, which
      // is what makes this a test of the race rather than of `fetch`.
      fetchImpl: () => new Promise<Response>(() => {}),
    });

    expect(result).toEqual({ ok: false, reason: "The provider took the sign-in and then did not answer, so EO stopped waiting for the token." });
    // The whole flow inside the deadline it was given, rather than the
    // callback's timer and then a second one of its own.
    expect(Date.now() - started).toBeLessThan(1_500);
  });

  it("tears the request down as well as answering, when it can", async () => {
    let seen: AbortSignal | undefined;

    await runConnectorOAuth({
      oauth: oauth(),
      openExternal: browser([]),
      timeoutMs: 120,
      fetchImpl: (_url, init) => {
        seen = init?.signal ?? undefined;
        return new Promise<Response>(() => {});
      },
    });

    // The race is what guarantees the answer; the signal is what stops a
    // hung endpoint going on costing a socket.
    expect(seen?.aborted).toBe(true);
  });

  /**
   * `connectorDefinitionProblems` refuses this where a pack author can
   * still fix it, so this is the row hand-edited into a database — and
   * `new URL` answers a bad string by throwing, which would reach the
   * renderer as an envelope error rather than as a sentence beside the
   * button.
   */
  it("refuses a URL it cannot open rather than throwing out of `new URL`", async () => {
    const opened: string[] = [];

    const result = await runConnectorOAuth({
      oauth: { ...oauth(), authorizeUrl: "not a url at all" },
      openExternal: async (url) => void opened.push(url),
      timeoutMs: 10_000,
    });

    expect(result).toEqual({ ok: false, reason: '"not a url at all" is not a URL EO can open, so the sign-in was not started.' });
    // Nothing was opened, and no port is left bound.
    expect(opened).toEqual([]);
  });

  /**
   * "Answered" is not "finished": a provider that sends its headers and
   * then stalls mid-body is the same hang one step further along, which
   * is why the timer stays armed until the body has been read.
   */
  it("stops waiting when the provider sends headers and then stalls mid-body", async () => {
    const result = await runConnectorOAuth({
      oauth: oauth(),
      openExternal: browser([]),
      timeoutMs: 200,
      fetchImpl: () =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: () => new Promise<unknown>(() => {}),
        } as unknown as Response),
    });

    expect(result).toEqual({ ok: false, reason: "The provider took the sign-in and then did not answer, so EO stopped waiting for the token." });
  });

  it("says so when the provider's answer carries no token", async () => {
    const result = await runConnectorOAuth({
      oauth: oauth(),
      openExternal: browser([]),
      timeoutMs: 10_000,
      fetchImpl: async () => new Response(JSON.stringify({ token_type: "bearer" }), { headers: { "content-type": "application/json" } }),
    });

    expect(result).toEqual({ ok: false, reason: "The provider's answer carried no access token." });
  });

  /**
   * The message is deliberately not `String(error)`. What is in hand at
   * that point is an authorization code, and an error string that quoted
   * the request would be the one message in this flow that could carry
   * it.
   */
  it("does not quote the request when the token endpoint cannot be reached", async () => {
    const result = await runConnectorOAuth({
      oauth: oauth(),
      openExternal: browser([]),
      timeoutMs: 10_000,
      fetchImpl: () => Promise.reject(new Error("POST https://slack.test/token code=the-code")),
    });

    expect(result).toEqual({ ok: false, reason: "EO could not reach the provider to finish the sign-in." });
    expect(JSON.stringify(result)).not.toContain("the-code");
  });
});
