import { z } from "zod";
import { PipelineExportSchema } from "./pipelineExport.js";

/**
 * The gallery's index, as the website serves it (EO-316,
 * the original design).
 *
 * "The app bundles a small set of templates so first run works offline
 * and on the day the installer does. The app also fetches an index from
 * a website, and a fetched template is shown with its source and
 * version."
 *
 * **The packs travel inside the index.** One request, so the gallery
 * either has the fetched list whole or does not have it at all. An index
 * of links would mean a card that can half-load: the title arrives, the
 * "what this needs" list does not — because that list is derived from
 * the pack's own preflight and there is nothing to preflight until the
 * pack is in hand — and a person is shown a template EO cannot yet say
 * anything true about. It also means one refusal to write: a fetch that
 * failed leaves the bundled set showing and says nothing, rather than
 * leaving four cards each failing separately.
 *
 * Every entry is a **pack document**, parsed by the same schema and
 * refused by the same gate as a file somebody dragged in — including
 * invariant #11's admin-grant refusal. A template fetched from a website
 * is the least trusted document EO reads, and it goes through the most
 * trusted door rather than around it.
 */
export const GalleryIndexEntrySchema = z.object({
  /**
   * Where this came from, in the person's words: "eo.dev", "Acme
   * internal".
   *
   * The index says it rather than EO deriving it from the URL, because
   * in managed mode "the admin's published packs replace the fetched
   * list entirely" (the original design) and the line a person needs then is the
   * organisation's name rather than a hostname. EO falls back to the
   * host when an entry says nothing.
   */
  source: z.string().default(""),
  pack: PipelineExportSchema,
});

export const GalleryIndexSchema = z.object({
  /**
   * Bumped when this document's shape changes, for
   * `PIPELINE_EXPORT_VERSION`'s reason and with a softer consequence: a
   * newer index is ignored rather than refused, and the bundled set is
   * what shows. A first run that cannot reach the network is already a
   * supported state, so "cannot read the index" has a well-trodden
   * answer that costs the person nothing.
   */
  eoGalleryIndex: z.number().int().positive(),
  templates: z.array(GalleryIndexEntrySchema).default([]),
});

export type GalleryIndexEntry = z.infer<typeof GalleryIndexEntrySchema>;
export type GalleryIndex = z.infer<typeof GalleryIndexSchema>;

/** The shape this build reads. */
export const GALLERY_INDEX_VERSION = 1;

/**
 * One version of a bundled template, as the app ships it (EO-531).
 *
 * Every version a bundled template has ever had ships inside the app, at
 * `gallery/history/<slug>/<version>.json`, so that a pipeline made from
 * one of them always has its base to be compared against when a later
 * release improves the template. The pack is the whole document as that
 * version shipped it; its `template` block names the slug and the
 * version, and the file's own path has to agree with both.
 *
 * `notes` are the version's release notes: a sentence or two saying what
 * changed and why, in words a person reads on the notice that tells them
 * their pipeline was updated. They belong to the version rather than to
 * the pack, which is why they sit beside it rather than in it — a pack
 * passed on from somebody's downloads folder has no release to describe.
 */
export const TemplateHistoryEntrySchema = z.object({
  /** Bumped when this file's shape changes, for `GALLERY_INDEX_VERSION`'s reason. */
  eoTemplateHistory: z.number().int().positive(),
  notes: z.string().min(1),
  pack: PipelineExportSchema,
});
export type TemplateHistoryEntry = z.infer<typeof TemplateHistoryEntrySchema>;

/** The template history shape this build reads. */
export const TEMPLATE_HISTORY_VERSION = 1;

/**
 * Where EO looks for the fetched half of the gallery (ARCHITECTURE.md, "The gallery").
 *
 * Shipped as a constant rather than a setting, because it is EO's own
 * address and a person who wants a different one wants managed mode.
 * Unreachable is not an error — see `listGallery`.
 */
export const GALLERY_INDEX_URL = "https://eo.dev/gallery/index.json";

/** What a bundled template's source line says, where a fetched one names a site. */
export const BUNDLED_SOURCE = "Bundled with EO";

/**
 * One blank on the "Use this" form, as the screen draws it (ARCHITECTURE.md, "The gallery").
 *
 * The pack's `TemplateBlank` plus the ones derived from module steps'
 * declared inputs, flattened into one list — the person is answering a
 * short form, not two.
 */
export const GalleryBlankViewSchema = z.object({
  key: z.string(),
  /**
   * What the field is. `stepInput` is the derived kind — see
   * `TemplateBlankKindSchema` — and is drawn as a plain text field; the
   * other four have controls of their own.
   */
  kind: z.string(),
  label: z.string(),
  help: z.string(),
  required: z.boolean(),
  /** Always text: a field holds text, and `valueType` says what it means. */
  default: z.string(),
  /**
   * The type a module declared for this input — `string`, `number` or
   * `boolean` (EO-316).
   *
   * `string` for every blank a template asks in its own right, all four
   * of which are text. On the wire so the form draws a number as a
   * number and a flag as a pair of words rather than as a box somebody
   * can type anything into; the main process parses against the module's
   * own manifest either way, so this is what the person sees rather than
   * what is trusted.
   */
  valueType: z.string(),
  connector: z.string().nullable(),
});

/**
 * One slot the template names rather than filling (ARCHITECTURE.md, "The gallery").
 *
 * Hidden in solo mode, which is what `solo` on the list answer decides:
 * "the approver slot is pre-filled with 'you' and hidden."
 */
export const GalleryRoleSlotViewSchema = z.object({
  /** The pack's own step id. Sent straight back on `gallery:use`. */
  stepId: z.string(),
  name: z.string(),
});

/**
 * The one button a red line carries (EO-317, ARCHITECTURE.md, "The needs check").
 *
 * "Each red line says why it is red and carries the one button that
 * fixes it." One button, named here by what it *does* rather than by
 * what it says, because the screen has to know how to perform it: a
 * folder is a picker and a write, a backend is the sign-in dialog, a
 * connector is EO-315's own flow. A line with nothing anybody can press
 * — a binary missing from PATH — carries `null` rather than a button
 * that would apologise, and says why in its own words instead.
 */
export const GalleryNeedFixSchema = z.object({
  /**
   * `addRepository` is the one kind a green line carries (EO-662): a
   * project can span several repositories, so the repository line offers
   * another once one works, attached the way Settings → Projects does.
   */
  kind: z.enum(["folder", "repository", "addRepository", "backend", "connector", "secret", "role", "module"]),
  /** What the button says: "Choose folder", "Choose a repository", "Sign in". */
  label: z.string(),
  /**
   * What it acts on, in the kind's own terms: the path a folder line is
   * about, the server name a connector line is about, the secret's name,
   * the role's slug, the backend a pack was built on, the module's id.
   *
   * One field rather than one per kind, because the screen branches on
   * `kind` anyway and a shape with five nullable members is five ways to
   * read the wrong one.
   */
  target: z.string().nullable().default(null),
});

/**
 * One thing a line is made of, with its own status (EO-662): each
 * repository the repository line counts, by name, so a broken one among
 * several says its own reason on its own row while the line itself stays
 * green on the one that works.
 */
export const GalleryNeedPartSchema = z.object({
  key: z.string(),
  line: z.string(),
  met: z.boolean(),
  why: z.string().nullable().default(null),
});

/**
 * One line of the needs check (ARCHITECTURE.md, "The needs check").
 *
 * Three facts and a button: what is needed, whether it is here, why it
 * is not, and the one thing that fixes it. `why` is taken from the
 * preflight's own reason rather than composed by the screen — "OAuth
 * failed", "wrong account", "path missing" — so the sentence a person
 * reads is the sentence the check actually made.
 */
export const GalleryNeedSchema = z.object({
  key: z.string(),
  line: z.string(),
  met: z.boolean(),
  /** Why this line is red, in the words of whatever decided it. Null on a green one. */
  why: z.string().nullable().default(null),
  fix: GalleryNeedFixSchema.nullable().default(null),
  /** What the line counts, row by row. Absent on a line about one thing. */
  parts: z.array(GalleryNeedPartSchema).optional(),
});

/** One card (ARCHITECTURE.md, "The gallery"). */
export const GalleryTemplateViewSchema = z.object({
  slug: z.string(),
  /**
   * Which *document* this card was drawn from, as opposed to which
   * template (EO-316).
   *
   * Sent back by Preview and by Use this, so that what a person presses
   * is what EO installs. A slug names a template across versions, which
   * is exactly what makes it the wrong thing to act on: a site
   * republishes the same slug while somebody is half way through its
   * form, the gallery refetches on focus, and submitting would install
   * the pack they never saw.
   */
  token: z.string(),
  title: z.string(),
  description: z.string(),
  version: z.string(),
  /** "Bundled with EO", or the index's own word for itself. */
  source: z.string(),
  bundled: z.boolean(),
  /** What the pipeline it creates is called, which need not be the title. */
  pipelineName: z.string(),
  /** "What this needs", derived from the pack's preflight — the same lines the needs check shows. */
  needs: z.array(GalleryNeedSchema),
  blanks: z.array(GalleryBlankViewSchema),
  roleSlots: z.array(GalleryRoleSlotViewSchema),
  /**
   * Whether this installation has one person (EO-305).
   *
   * On the card rather than on a channel of its own, because the one
   * thing it decides is whether the role-slot pickers are drawn at all
   * — and drawing them is the form's business.
   */
  solo: z.boolean(),
  /** Whether this template ships an example for Preview to walk (ARCHITECTURE.md, "Preview"). */
  previewable: z.boolean(),
});

export type GalleryBlankView = z.infer<typeof GalleryBlankViewSchema>;
export type GalleryRoleSlotView = z.infer<typeof GalleryRoleSlotViewSchema>;
export type GalleryNeedFix = z.infer<typeof GalleryNeedFixSchema>;
export type GalleryNeedFixKind = GalleryNeedFix["kind"];
export type GalleryNeedPart = z.infer<typeof GalleryNeedPartSchema>;
export type GalleryNeedView = z.infer<typeof GalleryNeedSchema>;
export type GalleryTemplateView = z.infer<typeof GalleryTemplateViewSchema>;
