import type { GalleryTemplate } from "./templates.js";

/**
 * The templates the gallery has put on screen (EO-316,
 * `ARCHITECTURE.md`, "The gallery").
 *
 * **A card's buttons act on the document the card was drawn from.**
 * Without this they did not: `gallery:list` fetched the index, drew the
 * cards, and then Preview and Use this each went and fetched it again.
 * Between the two the connection drops and the button answers "EO has no
 * template called board-pack" about a card the person is looking at; or
 * the site publishes version 2.5 and the button installs a pipeline that
 * is not the one whose description they just read. Neither is a rare
 * race — a laptop lid and a publish are both ordinary — and the second
 * is the worse one, because nothing about it looks wrong.
 *
 * ## Two maps, because there are two questions
 *
 * **By slug** is "what is on the card for `board-pack` right now", which
 * is what a caller holding only a slug can ask, and it is replaced
 * wholesale by each listing: a template that has left the index leaves
 * with it.
 *
 * **By token** is "the document that *particular* card was drawn from",
 * and it deliberately outlives the listing that produced it. The reason
 * is a form left open. The renderer refetches on window focus, so
 * `gallery:list` runs again while somebody is half way through filling
 * one in; if the site republished the same slug in between, the slug map
 * now points at a different pack and submitting would install the one
 * they never saw. The card carries its token, the buttons send it back,
 * and this is what still has the pack when they press Create.
 *
 * `HELD` bounds that. A refetch that changed nothing produces the same
 * token — `tokenFor` is a digest of the parsed document — so the common
 * case adds no entry at all; only a genuinely republished pack does.
 * Thirty-two is far past any session a person could produce by hand, and
 * the oldest goes first, so a form open across a fortnight of republishes
 * is the one case that can still be asked to choose its card again.
 *
 * **Not a cache**, and the difference matters. A cache exists to make
 * something faster and may be missed without consequence; this exists so
 * that a gesture and its subject stay the same thing.
 *
 * Module-level, like `registry.ts`'s own current value, and for the same
 * reason: it is a property of the running process rather than of any one
 * call, and every reader wants the same answer. One window, one gallery
 * (invariant #10's world), so there is nothing to key it by.
 */
let shown = new Map<string, GalleryTemplate>();

/**
 * How many distinct documents are kept reachable by token.
 *
 * Small on purpose. What it has to cover is "a form is open while the
 * index moves on", which needs a handful; what it must not become is a
 * copy of every pack the process has ever seen.
 */
const HELD = 32;

/** Insertion-ordered, so the oldest entry is the first one `Map` iteration yields. */
let byToken = new Map<string, GalleryTemplate>();

/** Replaces what is listed, and adds to what is still reachable. */
export function rememberListed(templates: readonly GalleryTemplate[]): void {
  shown = new Map(templates.map((template) => [template.slug, template]));

  for (const template of templates) {
    // Deleted first so a document seen again moves to the back of the
    // queue: what a listing just showed is the last thing that should be
    // evicted.
    byToken.delete(template.token);
    byToken.set(template.token, template);
  }
  while (byToken.size > HELD) {
    const oldest = byToken.keys().next();
    if (oldest.done) break;
    byToken.delete(oldest.value);
  }
}

/** The document behind the card with this slug, as the gallery last listed it. */
export function listedTemplate(slug: string): GalleryTemplate | undefined {
  return shown.get(slug);
}

/** The exact document a card was drawn from, whatever has been listed since. */
export function listedByToken(token: string): GalleryTemplate | undefined {
  return byToken.get(token);
}

/**
 * Forgets everything.
 *
 * For tests, which share a process and would otherwise inherit each
 * other's listings — and the one case where that is not merely untidy is
 * the case this module exists for, so a test proving it must be able to
 * start from nothing.
 */
export function forgetListed(): void {
  shown = new Map();
  byToken = new Map();
}
