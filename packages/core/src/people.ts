import { z } from "zod";
import type { CredentialKind } from "./identity.js";
import type { Uuid } from "./index.js";

/**
 * Somebody EO can name — an owner, a creator, an assignee, the target
 * of a mention (EO-302, ARCHITECTURE.md, "Identity").
 *
 * Identity arrives with jobs rather than with the server, because a job
 * needs an owner and "have Anna approve it" needs an assignee before
 * any server exists. In solo mode there is exactly one row and it is
 * the person sitting in front of the app; managed mode (7b) adds the
 * rest and a list to pick from.
 */
export interface Person {
  id: Uuid;
  /** What a person is called. `"you"` for the implicit local row. */
  name: string;
  /** Null until there is a server that knows one. Unique across the list since EO-323. */
  email: string | null;
  createdAt: number;
  /**
   * "One admin flag. Everyone with it may edit on the server" (EO-323,
   * the original design). False for the implicit local person:
   * in solo mode there is no server to administer.
   */
  isAdmin: boolean;
  /** When an admin invited them, or null on a row that was never an invitation. */
  invitedAt: number | null;
  /** When they accepted and set a credential. Null while the invitation is outstanding. */
  acceptedAt: number | null;
  /** Which credential they chose (the design asks for the choice to be recorded). Null until accepted. */
  credentialKind: CredentialKind | null;
}

/**
 * The implicit local person — "you" — created by migration 0077 on the
 * launch that applies it, which for a new installation is its first.
 *
 * A UUIDv7, minted once with this package's own `uuidv7()` and frozen
 * here as a literal. That is how every seeded row EO ships is written
 * down: the three agents in `0001_seed_default_pipeline.sql` carry
 * fixed v7 literals, and the system agent's
 * `019fb8c6-de92-7a41-9c33-4471f0c2b1de` is named by id in 0036, 0062
 * and 0065 — a well-known id repeated across migrations is the
 * established shape of this, not an exception to it.
 *
 * A reserved id rather than one generated per installation, because
 * migration 0077 both creates this row and rewrites every human mention
 * onto it, and the two statements need the same value in hand. (SQL
 * could mint one — `0069_item_types.sql` builds v7-shaped ids from
 * `randomblob` — but a minted id is a different id on every machine,
 * which is the one thing a constant the TypeScript also holds cannot
 * be.)
 *
 * Being reserved is also what the original design's first-sign-in rewrite needs:
 * "mentions that targeted the local person become the signing-in
 * person's" has to find that row among however many the server sends,
 * and comparing against a known id answers it without the "is this me"
 * flag the scope's four columns do not have.
 */
export const LOCAL_PERSON_ID = "01a0a0af-6d78-73d8-9954-953391d30f68" as Uuid;

/**
 * What the implicit local person is called.
 *
 * Lower case because it is read in a sentence — "waiting on you" — and
 * because nothing displays a person's name in solo mode anyway: there
 * is one person and every "the human" in EO already means them.
 */
export const LOCAL_PERSON_NAME = "you";

/**
 * Who a row in the inbox is waiting on (EO-305,
 * ARCHITECTURE.md, "The inbox, the archive and jobs", "Identity").
 *
 * Three shapes, because ARCHITECTURE.md, "The inbox, the archive and jobs" names three sentences
 * and no fourth:
 * "Waiting on you", "Waiting on Anna", "Unclaimed". Which one a row
 * gets is decided in `listInbox` and written down here so the renderer,
 * the Unassigned filter and the tests all read the same answer rather
 * than each deriving it from `assigneeId` in its own way.
 *
 * `you` is deliberately its own case rather than `person` carrying the
 * local person's name. The label is read as a sentence, and "Waiting on
 * you" is what a person needs to see; comparing an id against
 * `LOCAL_PERSON_ID` in three renderers is how that becomes "Waiting on
 * you" in two of them and "Waiting on you (you)" in the third.
 */
export const WaitingOnSchema = z.discriminatedUnion("who", [
  z.object({ who: z.literal("you") }),
  z.object({ who: z.literal("person"), personId: z.string(), name: z.string() }),
  z.object({ who: z.literal("unclaimed") }),
]);
export type WaitingOn = z.infer<typeof WaitingOnSchema>;

/** The sentence the design puts on an inbox row. */
export function waitingOnLabel(waitingOn: WaitingOn): string {
  if (waitingOn.who === "you") return "Waiting on you";
  if (waitingOn.who === "unclaimed") return "Unclaimed";
  return `Waiting on ${firstName(waitingOn.name)}`;
}

/**
 * What to call a person where there is room for one word — the card's
 * assignee slot and the inbox's label.
 *
 * "Anna", not "Anna Ruiz": a card has a line of about twenty
 * characters to say the type, the badge, the elapsed time and who has
 * it, and a surname in that line costs more than it tells you. The
 * column head (ARCHITECTURE.md, "The board") has the room for the full name and uses it.
 */
export function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] ?? name;
}
