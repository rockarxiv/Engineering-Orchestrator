/**
 * How often one caller may try the front door (EO-323,
 * `ARCHITECTURE.md`, "Identity").
 *
 * `auth:signIn` and `auth:acceptInvitation` are the two channels a
 * request reaches without a token, which makes them the two an
 * unauthenticated stranger may call as often as they like. scrypt makes
 * each attempt expensive to *check* — a hundred milliseconds of CPU —
 * and that cuts both ways: a few hundred concurrent guesses is both a
 * password search and a way to make this process do nothing else.
 *
 * So: a fixed number of attempts per address per window, counted in
 * memory. Deliberately modest in what it claims. It is not rate
 * limiting for a public internet — that belongs to whatever terminates
 * TLS in front of this, which the design already assumes exists — and a
 * distributed attempt from many addresses walks past it. What it stops
 * is the single client hammering one address, which is the shape every
 * off-the-shelf credential-stuffing tool has and the shape a runaway
 * retry loop in EO's own client would have.
 *
 * In memory rather than in SQLite, because the window is a minute and a
 * restart is an acceptable reset for a counter whose whole purpose is to
 * bound a burst. Writing a row per sign-in attempt would hand an
 * attacker a way to grow the database from outside it.
 */

/** Attempts per address per window. Generous for a person mistyping a password; useless for a search. */
const ATTEMPT_LIMIT = 10;

/** A minute. Long enough to matter, short enough that a locked-out person is not stuck. */
const WINDOW_MS = 60_000;

/**
 * How many addresses are remembered at once.
 *
 * A bound rather than an expiry sweep: without one, an attacker sending
 * a request per forged address grows this map without limit, which is a
 * memory exhaustion in the code that exists to prevent an exhaustion.
 * When it is full the oldest window is dropped — the entry closest to
 * expiring anyway.
 */
const MAX_TRACKED = 10_000;

export interface Throttle {
  /**
   * Whether this attempt may proceed, counting it if so.
   *
   * The counter advances on every *attempt*, not on every failure. A
   * caller who guesses right on the ninth try has still made nine
   * requests, and counting only misses is a way to be slowed down by
   * nothing at all while stuffing a list of known-good pairs.
   */
  allow(key: string, now?: number): boolean;
}

export function createSignInThrottle(limit: number = ATTEMPT_LIMIT, windowMs: number = WINDOW_MS): Throttle {
  const windows = new Map<string, { started: number; count: number }>();

  return {
    allow(key, now = Date.now()) {
      const current = windows.get(key);
      if (current === undefined || now - current.started >= windowMs) {
        if (windows.size >= MAX_TRACKED) {
          const oldest = [...windows.entries()].reduce((a, b) => (a[1].started <= b[1].started ? a : b));
          windows.delete(oldest[0]);
        }
        windows.set(key, { started: now, count: 1 });
        return true;
      }
      current.count += 1;
      return current.count <= limit;
    },
  };
}

/** What a caller who has run out of attempts is told. One sentence, and no count to tune against. */
export const TOO_MANY_ATTEMPTS = "Too many sign-in attempts from this address. Wait a minute and try again.";
