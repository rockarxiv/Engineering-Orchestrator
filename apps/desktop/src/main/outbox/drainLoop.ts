import type { Db } from "../db/client.js";
import type { OutboxChannel } from "../db/repos/index.js";
import { drainChannel, type ChannelSender } from "./drain.js";

/**
 * The timer that empties the outbox (J-04, generalised in F-06).
 *
 * Its own loop, deliberately not folded into the 5s dispatch tick: a
 * slow server must not slow down agents, and a busy agent must not hold
 * up something someone is watching for. Twenty seconds is often enough
 * that a project looks live and rare enough that an offline server is not
 * being hammered.
 *
 * Never overlaps itself. A drain that takes longer than the interval
 * would otherwise start again underneath the first one and send the same
 * comment twice.
 */
export function startOutboxDrain(
  db: Db,
  senders: Partial<Record<OutboxChannel, ChannelSender>>,
  intervalMs = 20_000,
  drain: typeof drainChannel = drainChannel,
): () => void {
  let running = false;
  let stopped = false;

  const tick = async (): Promise<void> => {
    if (running || stopped) return;
    running = true;
    try {
      // Sequentially, and each channel's failure is its own: one
      // server's outage must not stop another's channel being tried.
      for (const [channel, sender] of Object.entries(senders)) {
        if (stopped) break;
        // Skipped, not a reason to stop: `senders` is a Partial, so a key
        // present with no sender is a channel this build does not drain,
        // and breaking there would take every channel after it down too —
        // the opposite of what the comment above promises.
        if (!sender) continue;
        try {
          await drain(db, channel as OutboxChannel, sender);
        } catch (error) {
          console.error(`[eo] ${channel} drain failed:`, error);
        }
      }
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => void tick(), intervalMs);
  // Node keeps the process alive for a pending timer; this one should
  // not be the reason a quit hangs.
  timer.unref?.();

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
