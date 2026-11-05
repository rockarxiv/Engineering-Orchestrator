import { createServer, type Server } from "node:http";
import { WEBHOOK_MAX_BODY_BYTES, WEBHOOK_SIGNATURE_HEADER, WEBHOOK_TIMESTAMP_HEADER, webhookPath } from "@eo/core";
import { afterEach, describe, expect, it } from "vitest";
import { createSignInThrottle } from "./signInThrottle.js";
import { createRequestListener, type WebhookHttpDelivery } from "./http.js";

/**
 * The webhook route on the server's door (EO-332,
 * `ARCHITECTURE.md`, "Webhooks").
 *
 * A real socket and a fake receiver, which is the split the door itself
 * makes: what is checked here is everything the transport owns — the
 * method, the knocks, the bytes, the two headers, and what the answer
 * looks like — and nothing about what a delivery *means*, which is
 * `jobs/webhook.test.ts`.
 *
 * Deliberately not a whole `startServer`: this route is the one door in
 * the file no token opens, and building a database and a record to prove
 * that a GET is a 405 would test the composition rather than the door.
 */

let server: Server | null = null;

afterEach(async () => {
  const running = server;
  server = null;
  if (running === null) return;
  await new Promise<void>((resolve) => {
    running.closeAllConnections();
    running.close(() => resolve());
  });
});

interface DoorOptions {
  webhooks?: { receive(delivery: WebhookHttpDelivery): Promise<{ status: number; say: string }> };
  webhookThrottle?: ReturnType<typeof createSignInThrottle>;
}

async function listen(options: DoorOptions): Promise<string> {
  const listener = createRequestListener({
    token: "an-operator-token",
    rendererDirectory: null,
    dispatch: () => Promise.resolve({ ok: true, data: null }),
    ...options,
  });
  const running = createServer(listener);
  server = running;
  await new Promise<void>((resolve) => running.listen(0, "127.0.0.1", () => resolve()));
  const address = running.address();
  if (typeof address !== "object" || address === null) throw new Error("the test server did not bind");
  return `http://127.0.0.1:${address.port}`;
}

/** A receiver that records what it was handed and answers whatever it is told to. */
function receiver(answer: { status: number; say: string } = { status: 202, say: "created" }) {
  const seen: WebhookHttpDelivery[] = [];
  return {
    seen,
    webhooks: {
      receive: (delivery: WebhookHttpDelivery) => {
        seen.push(delivery);
        return Promise.resolve(answer);
      },
    },
  };
}

describe("the webhook route", () => {
  it("hands the path, the body and the two headers to the receiver, and answers what it says", async () => {
    const door = receiver({ status: 202, say: "created" });
    const origin = await listen(door);

    const response = await fetch(`${origin}${webhookPath("deploys")}`, {
      method: "POST",
      headers: { [WEBHOOK_SIGNATURE_HEADER]: "sha256=abc", [WEBHOOK_TIMESTAMP_HEADER]: "1700000000000" },
      body: '{"id":"evt-1"}',
    });

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ outcome: "created" });
    expect(door.seen).toEqual([
      { path: "deploys", rawBody: '{"id":"evt-1"}', signature: "sha256=abc", timestamp: "1700000000000" },
    ]);
  });

  it("carries no token, so a request with none reaches the receiver", async () => {
    // The whole point of the route: the sender is somebody else's
    // service and has never signed in. What admits it is the signature,
    // which is checked on the other side of `receive`.
    const door = receiver();
    const origin = await listen(door);

    const response = await fetch(`${origin}${webhookPath("deploys")}`, { method: "POST", body: "{}" });

    expect(response.status).toBe(202);
    expect(door.seen[0]?.signature).toBeNull();
    expect(door.seen[0]?.timestamp).toBeNull();
  });

  it("answers a GET with 405 and never reaches the receiver", async () => {
    const door = receiver();
    const origin = await listen(door);

    const response = await fetch(`${origin}${webhookPath("deploys")}`);

    expect(response.status).toBe(405);
    expect(door.seen).toEqual([]);
  });

  it("answers 404 on a door with no record behind it", async () => {
    const origin = await listen({});

    const response = await fetch(`${origin}${webhookPath("deploys")}`, { method: "POST", body: "{}" });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ outcome: "unknown" });
  });

  it("counts the knocks before anything is recorded", async () => {
    // The design's rate limit, and its point is narrower than it sounds: a
    // refused delivery is still a row, and a row a stranger can cause is
    // a database a stranger can grow.
    const door = receiver();
    const origin = await listen({ ...door, webhookThrottle: createSignInThrottle(2) });

    const first = await fetch(`${origin}${webhookPath("deploys")}`, { method: "POST", body: "{}" });
    const second = await fetch(`${origin}${webhookPath("deploys")}`, { method: "POST", body: "{}" });
    const third = await fetch(`${origin}${webhookPath("deploys")}`, { method: "POST", body: "{}" });

    expect([first.status, second.status, third.status]).toEqual([202, 202, 429]);
    expect(door.seen).toHaveLength(2);
  });

  it("counts per job, so one job's flood does not close another's address", async () => {
    const door = receiver();
    const origin = await listen({ ...door, webhookThrottle: createSignInThrottle(1) });

    await fetch(`${origin}${webhookPath("deploys")}`, { method: "POST", body: "{}" });
    const flooded = await fetch(`${origin}${webhookPath("deploys")}`, { method: "POST", body: "{}" });
    const other = await fetch(`${origin}${webhookPath("alerts")}`, { method: "POST", body: "{}" });

    expect(flooded.status).toBe(429);
    expect(other.status).toBe(202);
  });

  it("drops a body larger than a webhook carries, before it is read", async () => {
    const door = receiver();
    const origin = await listen(door);

    // The socket is destroyed the moment the count goes over — the
    // alternative is reading a body this process has already decided not
    // to answer — so the sender sees the connection go rather than a
    // status. That is `readBody`'s behaviour on every route and it is
    // asserted here rather than wished away: what matters is that the
    // receiver was never reached, so nothing was recorded for it.
    await expect(
      fetch(`${origin}${webhookPath("deploys")}`, { method: "POST", body: "x".repeat(WEBHOOK_MAX_BODY_BYTES + 1) }),
    ).rejects.toThrow();
    expect(door.seen).toEqual([]);
  });

  it("answers a path whose percent-escapes are broken rather than ending the process", async () => {
    const door = receiver();
    const origin = await listen(door);

    const response = await fetch(`${origin}/webhooks/%`, { method: "POST", body: "{}" });

    expect(response.status).toBe(400);
    expect(door.seen).toEqual([]);
  });
});
