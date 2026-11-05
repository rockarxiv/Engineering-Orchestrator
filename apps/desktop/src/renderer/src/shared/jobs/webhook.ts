import { webhookPath } from "@eo/core";

/**
 * Where a job's webhook delivery goes, for both layouts' webhook
 * surfaces (EO-519). The classic one is `jobs/Webhook.tsx`, the chat
 * one `chat/views/jobs/Webhook.tsx`.
 */

/**
 * Where the delivery goes, as a person can paste it (ARCHITECTURE.md, "Webhooks").
 *
 * Resolved against the address this page is on, exactly as
 * `InvitationLink` is and for the identical reason: only the server has
 * a public address, and the server does not reliably know what it is —
 * whatever terminates TLS in front of it does. The browser looking at
 * it *is* on that address, so it is the one end that can answer.
 *
 * A desktop's origin is its own bundle, which is not an address
 * anybody's helpdesk can post to. It gets the path and the sentence
 * saying what to put in front of it, rather than a URL that would not
 * work — which is invariant 12's rule about naming an absence rather
 * than leaving it to be found.
 */
export function webhookAddress(path: string): { url: string; reachable: boolean } {
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  const reachable = origin.startsWith("http");
  return { url: reachable ? `${origin}${webhookPath(path)}` : webhookPath(path), reachable };
}
