import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { ConnectorOAuth } from "@eo/core";

/**
 * The `oauth` setup kind, performed (EO-315,
 * the original design).
 *
 * "The person sees Connect Slack, signs in, and the step's list gains an
 * entry." This is the middle of that sentence: EO opens the provider's
 * authorize URL in the person's own browser and receives the redirect on
 * a loopback listener it started for the purpose — RFC 8252's
 * arrangement for a native app, and the only one that does not put a
 * credential somewhere another process can read it.
 *
 * `schemas/mcpServers.ts` has a long note explaining why `McpAuthKind`
 * has no `oauth` member, and it is still true: that enum is about how an
 * MCP *transport* authenticates, and EO still performs no flow on its
 * behalf. This is a different question. A connector's OAuth ends with a
 * token in the keychain under a name the definition declared, and the
 * server underneath is then delivered exactly as a server with a bearer
 * token in its environment has always been. Nothing about the transport
 * learns that a browser was involved.
 *
 * **Public client, PKCE always.** A desktop app cannot keep a client
 * secret (RFC 8252 §8.5) — one shipped in a pack is one everybody who
 * has the pack has — so there is no `clientSecret` in the definition and
 * a code challenge is sent on every flow whether or not the provider
 * asks for one. A provider that ignores PKCE is no worse off; one that
 * honours it is what stops a code intercepted on the loopback redirect
 * being redeemable by anything else.
 *
 * Every dependency on the world outside is injected — the browser, the
 * HTTP client, the clock — so a test drives the whole flow against a
 * fake provider under plain Node, which is what the acceptance criterion
 * asks for.
 */

export interface ConnectorOAuthFlow {
  oauth: ConnectorOAuth;
  /**
   * How the authorize URL reaches the person's real browser.
   *
   * The platform's, never `shell.openExternal` directly: this file has
   * to stay importable under plain Node, the same rule
   * `runtimes/signIn.ts` is held to.
   */
  openExternal: (url: string) => Promise<void>;
  /** Injected so a test can answer the token endpoint without a network. */
  fetchImpl?: typeof fetch;
  /**
   * How long to hold the listener open.
   *
   * Five minutes: long enough for somebody to find the browser window
   * they lost behind the app, short enough that a flow abandoned halfway
   * does not leave a port bound until EO is quit. A timeout is a
   * refusal with a sentence, never a hang — invariant 9's spirit, one
   * level down from a run.
   */
  timeoutMs?: number;
}

export type ConnectorOAuthResult = { ok: true; token: string } | { ok: false; reason: string };

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * What a provider that accepted the connection and then said nothing is
 * answered with.
 *
 * Its own sentence rather than the unreachable one: "EO could not reach
 * the provider" is what a person acts on by checking their network, and
 * this is a provider that was reached and did not answer.
 */
const TOKEN_ENDPOINT_TIMEOUT = "The provider took the sign-in and then did not answer, so EO stopped waiting for the token.";

/** Said the same way whether the body was not JSON or was JSON of the wrong shape: either way there is no token in it. */
const NOT_THE_JSON_EO_ASKED_FOR = "The provider's answer was not the JSON EO asked for, so there was no token to store.";

/** The deadline winning its race, as a value nothing on the wire could impersonate. */
const EXPIRED = Symbol("the token exchange ran out of time");

/** Base64url without padding — what a code verifier and a state have to be (RFC 7636 §4.1). */
function randomUrlSafe(bytes: number): string {
  return randomBytes(bytes).toString("base64url");
}

function codeChallengeFor(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

/**
 * What the browser is left looking at.
 *
 * Plain text in an HTML shell, with nothing fetched from anywhere: the
 * page is served by a listener bound to loopback for one request, and a
 * stylesheet or a font on it would be a network call made from a page
 * whose whole job is that the person can close it.
 */
function closingPage(heading: string, detail: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${heading}</title></head><body style="font-family: system-ui, sans-serif; padding: 3rem; max-width: 34rem;"><h1 style="font-size: 1.25rem;">${heading}</h1><p>${detail}</p></body></html>`;
}

/**
 * Runs the round trip and answers with the access token.
 *
 * Refuses; never throws. Every way this fails — the browser would not
 * open, the person declined, the provider redirected with an error, the
 * state did not match, the token endpoint said no — is something a
 * person did or a provider decided, and the caller's job is to put it on
 * the screen beside the Connect button.
 */
export async function runConnectorOAuth(flow: ConnectorOAuthFlow): Promise<ConnectorOAuthResult> {
  const fetchImpl = flow.fetchImpl ?? fetch;
  const timeoutMs = flow.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  // **One deadline for the whole flow**, rather than one per step.
  //
  // The first cut bounded only the wait for the callback, which left the
  // half after it unbounded: a token endpoint that accepts the
  // connection and never answers held the Connect button pending and the
  // loopback port bound until EO was quit. Two five-minute timers would
  // have fixed the hang and made the promise a person is waiting on take
  // up to ten minutes; a deadline stamped once is the only version where
  // "this ends in five minutes" is true of the thing somebody is
  // actually watching.
  const deadlineAt = Date.now() + timeoutMs;
  const remaining = () => deadlineAt - Date.now();
  const state = randomUrlSafe(24);
  const verifier = randomUrlSafe(32);

  const server = createServer();
  // Loopback by address rather than by name: `localhost` can resolve to
  // an interface something else is listening on, and the redirect this
  // builds has to name the socket EO actually bound.
  const listening = await new Promise<AddressInfo | null>((resolve) => {
    server.once("error", () => resolve(null));
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(typeof address === "object" && address !== null ? address : null);
    });
  });

  if (listening === null) {
    server.close();
    return { ok: false, reason: "EO could not open a local port to receive the sign-in, so the flow was not started." };
  }

  const redirectUri = `http://127.0.0.1:${listening.port}/callback`;

  // `connectorDefinitionProblems` refuses a URL that is not one, so a
  // definition that reached here has already been read — but a row
  // hand-edited into the database, or one written before that check
  // existed, has not, and `new URL` answers a bad string by throwing.
  // An exception out of here reaches the renderer as an IPC envelope
  // error rather than as a sentence beside the button, which is what
  // this whole file refuses to do. Belt and braces, deliberately: the
  // boundary check is what a pack author sees, and this is what the
  // person who clicked Connect sees if one ever gets past it.
  let authorize: URL;
  try {
    authorize = new URL(flow.oauth.authorizeUrl);
  } catch {
    server.close();
    return { ok: false, reason: `"${flow.oauth.authorizeUrl}" is not a URL EO can open, so the sign-in was not started.` };
  }
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("client_id", flow.oauth.clientId);
  authorize.searchParams.set("redirect_uri", redirectUri);
  authorize.searchParams.set("state", state);
  authorize.searchParams.set("code_challenge", codeChallengeFor(verifier));
  authorize.searchParams.set("code_challenge_method", "S256");
  // Omitted rather than sent empty: a provider reading `scope=` as "no
  // scopes" and one reading it as "the default set" both exist, and an
  // absent parameter is the only spelling they agree on.
  if (flow.oauth.scopes.length > 0) authorize.searchParams.set("scope", flow.oauth.scopes.join(" "));

  const awaited = new Promise<{ ok: true; code: string } | { ok: false; reason: string }>((resolve) => {
    const timer = setTimeout(
      () => resolve({ ok: false, reason: "The sign-in was not completed in five minutes, so EO stopped waiting for it." }),
      Math.max(0, remaining()),
    );
    // `unref` so a forgotten flow cannot hold a test process — or the
    // app's own shutdown — open for five minutes.
    timer.unref?.();

    const settle = (answer: { ok: true; code: string } | { ok: false; reason: string }) => {
      clearTimeout(timer);
      resolve(answer);
    };

    server.on("request", (request: IncomingMessage, response: ServerResponse) => {
      const url = new URL(request.url ?? "/", `http://127.0.0.1:${listening.port}`);
      if (url.pathname !== "/callback") {
        response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        response.end("Not found");
        return;
      }

      const error = url.searchParams.get("error");
      const code = url.searchParams.get("code");
      const returned = url.searchParams.get("state");

      const fail = (reason: string) => {
        response.writeHead(400, { "content-type": "text/html; charset=utf-8" });
        response.end(closingPage("Sign-in did not finish", reason));
        settle({ ok: false, reason });
      };

      if (error !== null) {
        fail(`The provider refused the sign-in: ${error}.`);
        return;
      }
      // Checked before the code is looked at, and a mismatch is never
      // redeemed: this listener is on loopback, where anything else
      // running as the person could have reached it, and the state is
      // what says the redirect belongs to the flow EO started.
      if (returned !== state) {
        fail("That sign-in did not belong to the request EO made, so it was ignored.");
        return;
      }
      if (code === null) {
        fail("The provider came back without an authorization code.");
        return;
      }

      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(closingPage("You are signed in", "EO has what it needs. You can close this tab and go back to the app."));
      settle({ ok: true, code });
    });
  });

  try {
    try {
      await flow.openExternal(authorize.href);
    } catch {
      // `openExternal` resolving is not proof a browser appeared —
      // `runtimes/signIn.ts` makes the same point — but it rejecting *is*
      // proof one did not, and waiting five minutes for a redirect that
      // cannot come is the worst of both.
      return { ok: false, reason: "EO could not open your browser, so the sign-in was not started." };
    }

    const callback = await awaited;
    if (!callback.ok) return callback;

    return await exchange(fetchImpl, flow.oauth, callback.code, verifier, redirectUri, remaining());
  } finally {
    // Closed on every path, including the timeout: a bound port left
    // behind is a port the next flow cannot have, and this one is only
    // ever wanted for a single request.
    server.close();
    server.closeAllConnections?.();
  }
}

/**
 * The code for a token.
 *
 * Form-encoded and `Accept: application/json`, which is what every
 * provider that answers either way needs to be told: GitHub's endpoint
 * replies in `application/x-www-form-urlencoded` unless asked, and a
 * `JSON.parse` of that is an exception rather than a refusal.
 */
async function exchange(
  fetchImpl: typeof fetch,
  oauth: ConnectorOAuth,
  code: string,
  verifier: string,
  redirectUri: string,
  budgetMs: number,
): Promise<ConnectorOAuthResult> {
  if (budgetMs <= 0) return { ok: false, reason: TOKEN_ENDPOINT_TIMEOUT };

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: oauth.clientId,
    code_verifier: verifier,
  });

  // **Aborted and raced, rather than either alone, and over the body as
  // well as the headers.**
  //
  // The signal is what actually tears the socket down, so a hung
  // endpoint stops costing a connection. The race is what guarantees
  // this function *settles*: `fetchImpl` is injected, and a caller's
  // stand-in is under no obligation to honour a signal — the real fetch
  // is, a fake is whatever somebody wrote. Without the race, one
  // ill-behaved implementation is a Connect button pending forever,
  // which is precisely the failure this bound exists to remove.
  //
  // The body is inside the bound too, because "answered" is not the same
  // as "finished": a provider that sends its headers and then stalls
  // mid-body is the same hang one step further along, and clearing the
  // timer at the end of the fetch would have left `response.json()` to
  // wait for it forever.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), budgetMs);
  timer.unref?.();
  // A symbol rather than a string, so nothing a provider could legally
  // send back is mistaken for EO's own sentinel.
  const expired = new Promise<typeof EXPIRED>((resolve) => {
    const race = setTimeout(() => resolve(EXPIRED), budgetMs);
    race.unref?.();
  });

  try {
    let response: Response;
    try {
      const raced = await Promise.race([
        fetchImpl(oauth.tokenUrl, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
          body: body.toString(),
          signal: controller.signal,
        }),
        expired,
      ]);
      if (raced === EXPIRED) return { ok: false, reason: TOKEN_ENDPOINT_TIMEOUT };
      response = raced;
    } catch {
      // The message is deliberately not `String(error)`. What is in hand
      // at this point is an authorization code, and an error string that
      // quoted the request would be the one message in this flow that
      // could carry it.
      //
      // An abort lands here too, and "EO could not reach the provider"
      // is the wrong half of a true sentence about one — the provider
      // was reached, and then said nothing. Which of the two settles
      // first is genuinely a race: the abort and the `expired` timer
      // fire in the same tick, and a real `fetch` rejects a microtask
      // later, so either can win. The signal is what the answer is read
      // off, rather than the ordering.
      return { ok: false, reason: controller.signal.aborted ? TOKEN_ENDPOINT_TIMEOUT : "EO could not reach the provider to finish the sign-in." };
    }

    if (!response.ok) return { ok: false, reason: `The provider refused to issue a token (HTTP ${response.status}).` };

    let payload: unknown;
    try {
      payload = await Promise.race([response.json(), expired]);
    } catch {
      return { ok: false, reason: NOT_THE_JSON_EO_ASKED_FOR };
    }
    if (payload === EXPIRED) return { ok: false, reason: TOKEN_ENDPOINT_TIMEOUT };

    if (typeof payload !== "object" || payload === null) return { ok: false, reason: NOT_THE_JSON_EO_ASKED_FOR };

    const record = payload as Record<string, unknown>;
    const error = record["error"];
    if (typeof error === "string") return { ok: false, reason: `The provider refused to issue a token: ${error}.` };

    const token = record["access_token"];
    if (typeof token !== "string" || token === "") return { ok: false, reason: "The provider's answer carried no access token." };

    // Only the access token is kept, and that is a decision rather than
    // an omission. A refresh token is a second value with a lifetime and
    // a rotation rule, and nothing in EO refreshes anything yet —
    // storing one would be a credential sitting in the keychain that no
    // code path can ever use, and a person believing their connection
    // renews itself. When a refresh lands it is a second declared secret
    // name and a reader for it, which is a change this shape does not
    // stand in the way of.
    return { ok: true, token };
  } finally {
    // Disarmed on every path, so a flow that finished in a second does
    // not leave an abort pending for the rest of the budget.
    clearTimeout(timer);
  }
}
