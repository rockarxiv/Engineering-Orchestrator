import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  BUNDLED_SOURCE,
  GALLERY_INDEX_URL,
  GALLERY_INDEX_VERSION,
  GalleryIndexSchema,
  type PackTemplate,
  type PipelineExport,
} from "@eo/core";
import { parseExport } from "../modules/pipelineTransfer.js";

/**
 * The gallery, in both of the places it lives (EO-316,
 * the original design).
 *
 * "Both, with a clear split. The app **bundles** a small set of
 * templates so first run works offline and on the day the installer
 * does. The app also **fetches** an index from a website … The bundled
 * set is the fallback and is never hidden."
 *
 * Which produces the rule the whole module is built around: **a
 * network that is not there is not an error**. First run for a
 * non-developer is the one screen in EO where a red line about a failed
 * request would be the first thing the product ever said to somebody,
 * about a thing they did not ask for and cannot fix. So an unreachable
 * index, a timed-out one, a 500, a body that is not JSON and a body that
 * is JSON of the wrong shape all produce the same outcome: the bundled
 * templates, and nothing said.
 */

/** One card in the gallery: what it says, where it came from, and the pack behind it. */
export interface GalleryTemplate {
  /** `PackTemplate.slug` — what a card is chosen by, and what a person reads it as. */
  slug: string;
  /**
   * **Which document this is**, as opposed to which template (EO-316).
   *
   * A slug names a template across versions — that is what it is for —
   * so it cannot name the pack somebody is looking at. A site republishes
   * `board-pack` at 2.5 while a person is half way through its form, the
   * gallery refetches on focus, and the slug now points at a document
   * with different blanks than the ones they have been filling in.
   * Submitting installs the one they never saw.
   *
   * So a card carries this as well, the buttons send it back, and
   * `gallery:use` installs *this* document. A digest of the pack rather
   * than a minted id, so that re-listing an unchanged pack answers the
   * same thing and a form survives any number of refetches that changed
   * nothing — which is nearly all of them.
   */
  token: string;
  title: string;
  description: string;
  version: string;
  /** "Bundled with EO", or what the index called itself (ARCHITECTURE.md, "The gallery"). */
  source: string;
  /** Whether it shipped inside the app. The bundled set is the one that is never hidden. */
  bundled: boolean;
  /** The pack, parsed and through the import gate, exactly as a dragged-in file is. */
  document: PipelineExport;
  /** The pack's own words about itself, without a second copy of them here. */
  template: PackTemplate;
}

/**
 * The templates shipped inside the app.
 *
 * Read on demand rather than cached, because the directory is four small
 * files and a list that went stale would be a gallery showing what the
 * previous release bundled.
 *
 * A file that will not parse is **skipped rather than thrown on**, and
 * that is the one decision here worth arguing with. It means a damaged
 * bundled template shows as an absent card rather than as a broken
 * gallery — which is the right way round for a screen whose whole job is
 * to be the first thing that works. It is also why `bundledTemplates`
 * is asserted over in a test: the skip is silent, so the only thing that
 * can notice a template EO forgot to ship is a test that counts them.
 *
 * A pack with no `template` block is skipped too. It is a pipeline
 * export somebody dropped in the directory, not a gallery card: it has
 * no title, no description and no version, and inventing three for it
 * would be EO writing copy about a stranger's graph.
 */
export function bundledTemplates(directory: string): GalleryTemplate[] {
  let names: string[];
  try {
    names = readdirSync(directory).filter((name) => name.endsWith(".json")).sort();
  } catch {
    // No directory at all — an unpackaged tree somebody moved, or a
    // build that did not ship it. The gallery is empty rather than
    // broken, which the screen already has words for.
    return [];
  }

  const templates: GalleryTemplate[] = [];
  for (const name of names) {
    let text: string;
    try {
      text = readFileSync(join(directory, name), "utf8");
    } catch {
      continue;
    }
    const template = templateOf(text, BUNDLED_SOURCE, true);
    if (template !== null) templates.push(template);
  }
  return templates;
}

/**
 * One pack document as a card, or null if it is not one.
 *
 * Through `parseExport` rather than through `PipelineExportSchema`
 * directly, so a template gets the version check and the admin-grant
 * refusal that every other door into this build already has. A gallery
 * that read packs its own way would be the second path invariant #11's
 * note warns about — and the fetched half is the least trusted document
 * EO reads.
 */
function templateOf(text: string, source: string, bundled: boolean): GalleryTemplate | null {
  const parsed = parseExport(text);
  if (!parsed.ok) return null;
  const template = parsed.document.template;
  if (template === null) return null;
  return {
    slug: template.slug,
    token: tokenFor(parsed.document),
    title: template.title,
    description: template.description,
    version: template.version,
    source: source.trim() === "" ? BUNDLED_SOURCE : source,
    bundled,
    document: parsed.document,
    template,
  };
}

/**
 * What this document is, in one string — see `GalleryTemplate.token`.
 *
 * Over the **parsed** document rather than the bytes it arrived as, so
 * that a pack reformatted on its way through a CDN is still the same
 * pack: zod builds its result in schema order, so two documents that
 * parse equal stringify equal. Two that do not are treated as different,
 * which is the conservative direction — the worst it costs is a person
 * being asked to choose a card again.
 *
 * Not a security boundary and not trying to be: what makes a fetched
 * pack safe is `parseExport` and the import gate, which every document
 * here has already been through. This only has to tell two of them
 * apart.
 */
export function tokenFor(document: PipelineExport): string {
  return createHash("sha256").update(JSON.stringify(document)).digest("hex").slice(0, 32);
}

/** How long EO waits for the index before deciding it is offline. */
const FETCH_TIMEOUT_MS = 4_000;

/** What `listGalleryTemplates` needs from the world. Injected so a test can be offline, or served a fake index. */
export interface GalleryOptions {
  /** Where the bundled packs are — `ResourcePaths.gallery`. */
  directory: string;
  /** Overridable so a test can serve its own, and so managed mode can point elsewhere later (ARCHITECTURE.md, "The gallery"). */
  indexUrl?: string;
  /** The global by default. A test passes one that refuses, or one that answers. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/**
 * The fetched half, or nothing.
 *
 * Every failure is the same answer — see this module's own note. The
 * `catch` is deliberately bare and deliberately total: a DNS failure, a
 * TLS failure, an abort, a 404 and a body that parses to the wrong shape
 * are all "the index is not available", and there is no case among them
 * where telling the person something would help them.
 */
export async function fetchedTemplates(options: GalleryOptions): Promise<GalleryTemplate[]> {
  const url = options.indexUrl ?? GALLERY_INDEX_URL;
  const call = options.fetchImpl ?? globalThis.fetch;
  if (typeof call !== "function") return [];

  try {
    const response = await call(url, { signal: AbortSignal.timeout(options.timeoutMs ?? FETCH_TIMEOUT_MS) });
    if (!response.ok) return [];
    const index = GalleryIndexSchema.safeParse(await response.json());
    // A newer index is ignored rather than guessed at, for the reason
    // `parseExport` refuses a newer pack: half-read is worse than
    // unread, and here "unread" has a good answer already on screen.
    if (!index.success || index.data.eoGalleryIndex > GALLERY_INDEX_VERSION) return [];

    return index.data.templates.flatMap((entry) => {
      const template = templateOf(JSON.stringify(entry.pack), entry.source === "" ? hostOf(url) : entry.source, false);
      return template === null ? [] : [template];
    });
  } catch {
    return [];
  }
}

/** The index's host, for an entry that named no source of its own. Falls back to the whole URL. */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * The gallery as the screen shows it: bundled first, then whatever the
 * index added.
 *
 * **Bundled wins a collision.** A fetched entry carrying a slug EO
 * already ships is the same template arriving by the other road, and
 * the original design's "the bundled set is the fallback and is never hidden" decides
 * which copy stays. Two cards with one title would be the alternative,
 * and a person choosing between them would have nothing to choose on.
 */
export async function listGalleryTemplates(options: GalleryOptions): Promise<GalleryTemplate[]> {
  const bundled = bundledTemplates(options.directory);
  const taken = new Set(bundled.map((template) => template.slug));
  const fetched = (await fetchedTemplates(options)).filter((template) => !taken.has(template.slug));
  return [...bundled, ...fetched];
}
