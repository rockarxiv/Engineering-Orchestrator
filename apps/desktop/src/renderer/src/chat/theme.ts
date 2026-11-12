import { useLayoutEffect, useMemo, useSyncExternalStore, type CSSProperties } from "react";

/**
 * Colour themes for the chat layout.
 *
 * The presets are the dark schemes of products people already spend the
 * day in — Claude, Linear, GitHub, Nord, Catppuccin, Tokyo Night — each a
 * full palette tuned by hand, because what makes them look right is the
 * particular ladder of greys under them, and no two-colour rule
 * reproduces Linear's near-black and Nord's light slate both. Slate is
 * the design system's own values, written out from `styles.css`.
 *
 * A custom theme is two seeds instead — the hue and strength of the
 * ground and of the accent — with every token derived at the lightness
 * the design system settled (ARCHITECTURE.md, "Colour": the canvas ladder from 21% to
 * 36%, ink at 94/76/66, the accent at 55% under near-white text). Holding
 * lightness gets most of the way to readable, but not all: how light a
 * colour *looks* at one OKLCH lightness still moves with its hue, so a
 * green accent at 55% is too light for white text and a strong teal
 * ground lifts the cards under quiet text. So the derived palette is then
 * checked against the design system's own contrast pairs
 * (`scripts/design-tokens.mjs`) and the tokens that fall short are
 * stepped lighter, or the button's text turned dark, until they hold.
 * That is what lets a person pick any colour without picking an
 * unreadable one.
 *
 * The status scale (running, reviewing, waiting, failed) and the step
 * kinds' colours (agent, script) are themed too, but only their values:
 * what each means and roughly where it sits on the wheel are the same in
 * every theme, and each preset draws them in its own palette, so Claude's
 * green is warm and Nord's soft. A custom theme keeps Slate's. The accent
 * stays an action (ARCHITECTURE.md, "Genre: utilitarian", rule 6) — which
 * is why a custom accent too close to a status or kind hue is flagged
 * rather than refused (`statusClash`).
 *
 * The outlines are relative to the raised surface, the lightest one a line
 * is drawn on: `--color-line` is that surface mixed 14% toward the ink in
 * OKLab, stepped further until it shows at 1.4:1, and `--color-line-strong`
 * the same at 30%. A line picked as its own grey ended up 1.0–1.2:1 against
 * a panel, and in Nord and Catppuccin the panel's own colour.
 *
 * A per-device preference rather than a setting on the record, because
 * it is about how *this* window is coloured, not a fact about the work.
 * Two people on one organisation can colour their windows differently,
 * and a choice synced to a colleague's screen would be somebody else's
 * hand on their furniture.
 */

/** Every token a theme sets: the ground, line, ink, accent and focus, and the status and kind colours. */
export const THEME_TOKENS = [
  "--chat-deep",
  "--color-canvas",
  "--color-canvas-subtle",
  "--color-canvas-raised",
  "--color-canvas-hover",
  "--color-canvas-active",
  "--color-line",
  "--color-line-strong",
  "--color-ink",
  "--color-ink-muted",
  "--color-ink-subtle",
  "--color-idle",
  "--color-accent",
  "--color-accent-hover",
  "--color-accent-ink",
  "--color-accent-subtle",
  "--color-accent-soft",
  "--color-focus",
  "--color-scrim",
  "--color-running",
  "--color-success",
  "--color-reviewing",
  "--color-paused",
  "--color-warning",
  "--color-danger",
  "--color-kind-agent",
  "--color-kind-script",
] as const;

export type ThemeToken = (typeof THEME_TOKENS)[number];
export type Palette = Record<ThemeToken, string>;

export interface ThemeSeed {
  /** The ground: hue in degrees, chroma 0–0.08. */
  ground: { h: number; c: number };
  /** The accent: hue in degrees, chroma 0.04–0.24. */
  accent: { h: number; c: number };
}

export interface ThemePreset {
  id: string;
  name: string;
  palette: Palette;
}

/**
 * A preset's palette, from its few named colours.
 *
 * `deep` is the rails and the canvas behind the conversation — the
 * sidebar colour in each of these products — and `canvas` the room the
 * conversation is lit in.
 */
function preset(colours: {
  deep: string;
  canvas: string;
  subtle: string;
  raised: string;
  hover: string;
  active: string;
  ink: string;
  inkMuted: string;
  inkSubtle: string;
  idle: string;
  accent: string;
  accentHover: string;
  accentInk: string;
  accentSubtle: string;
  accentSoft: string;
  focus: string;
  scrim: string;
  /** Running, also success. */
  running: string;
  reviewing: string;
  /** Paused, also warning. */
  paused: string;
  danger: string;
  agent: string;
  script: string;
}): Palette {
  const { line, lineStrong } = outlinesFor(colours.raised, colours.ink);
  return {
    "--chat-deep": colours.deep,
    "--color-canvas": colours.canvas,
    "--color-canvas-subtle": colours.subtle,
    "--color-canvas-raised": colours.raised,
    "--color-canvas-hover": colours.hover,
    "--color-canvas-active": colours.active,
    "--color-line": line,
    "--color-line-strong": lineStrong,
    "--color-ink": colours.ink,
    "--color-ink-muted": colours.inkMuted,
    "--color-ink-subtle": colours.inkSubtle,
    "--color-idle": colours.idle,
    "--color-accent": colours.accent,
    "--color-accent-hover": colours.accentHover,
    "--color-accent-ink": colours.accentInk,
    "--color-accent-subtle": colours.accentSubtle,
    "--color-accent-soft": colours.accentSoft,
    "--color-focus": colours.focus,
    "--color-scrim": colours.scrim,
    ...statusColours(colours),
  };
}

/** The status and kind tokens, from the six colours they are drawn in. */
function statusColours(colours: { running: string; reviewing: string; paused: string; danger: string; agent: string; script: string }) {
  return {
    "--color-running": colours.running,
    "--color-success": colours.running,
    "--color-reviewing": colours.reviewing,
    "--color-paused": colours.paused,
    "--color-warning": colours.paused,
    "--color-danger": colours.danger,
    "--color-kind-agent": colours.agent,
    "--color-kind-script": colours.script,
  } as const;
}

/**
 * The design system's own status and kind colours (`packages/ui/src/styles.css`):
 * Slate's, and every custom theme's.
 */
const SLATE_STATUS = statusColours({
  running: "oklch(71% 0.15 150)",
  reviewing: "oklch(66% 0.16 305)",
  paused: "oklch(79% 0.13 75)",
  danger: "oklch(67% 0.18 22)",
  agent: "oklch(76% 0.11 205)",
  script: "oklch(78% 0.1 345)",
});

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const round = (value: number, places: number) => Number(value.toFixed(places));
const wrap = (degrees: number) => ((degrees % 360) + 360) % 360;

function oklch(l: number, c: number, h: number): string {
  return `oklch(${l}% ${round(c, 4)} ${round(wrap(h), 1)})`;
}

/* ── contrast, as `scripts/design-tokens.mjs` measures it ───────────── */

// Up here because the presets are built when the module loads, and their
// outlines are measured.
const toLinear = (channel: number) => (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
const toGamma = (channel: number) => (channel <= 0.0031308 ? 12.92 * channel : 1.055 * channel ** (1 / 2.4) - 0.055);

/** A colour as linear-light sRGB, from `#rrggbb` or `oklch(L% C H)`; null for anything else. */
function linearRgb(value: string): [number, number, number] | null {
  const hex = /^#([0-9a-f]{6})$/i.exec(value.trim());
  if (hex) {
    const v = parseInt(hex[1]!, 16);
    return [toLinear(((v >> 16) & 255) / 255), toLinear(((v >> 8) & 255) / 255), toLinear((v & 255) / 255)];
  }
  const lch = /^oklch\(\s*([\d.]+)%\s+([\d.]+)\s+([\d.]+)\s*\)$/.exec(value.trim());
  if (!lch) return null;
  const l = Number(lch[1]) / 100;
  const rad = (Number(lch[3]) * Math.PI) / 180;
  const A = Number(lch[2]) * Math.cos(rad);
  const B = Number(lch[2]) * Math.sin(rad);
  const l_ = (l + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m_ = (l - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s_ = (l - 0.0894841775 * A - 1.291485548 * B) ** 3;
  return [
    clamp(4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_, 0, 1),
    clamp(-1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_, 0, 1),
    clamp(-0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_, 0, 1),
  ];
}

/** WCAG contrast between two colours, or null when either is not one `linearRgb` reads. */
export function contrastRatio(a: string, b: string): number | null {
  const x = linearRgb(a);
  const y = linearRgb(b);
  if (!x || !y) return null;
  const luminance = ([r, g, bl]: [number, number, number]) => 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  const [light, dark] = [luminance(x), luminance(y)].sort((p, q) => q - p);
  return (light! + 0.05) / (dark! + 0.05);
}

/** The colour at lightness `l`, stepped lighter until it reaches `min` against `ground`. */
function readableOn(l: number, c: number, h: number, ground: string, min: number): string {
  for (let step = l; step < 98; step += 1) {
    const candidate = oklch(step, c, h);
    if ((contrastRatio(candidate, ground) ?? 0) >= min) return candidate;
  }
  return oklch(98, c, h);
}

/** A colour as OKLCH (lightness 0–1), from `#rrggbb` or `oklch(L% C H)`; null for anything else. */
function asOklch(value: string): { l: number; c: number; h: number } | null {
  const lch = /^oklch\(\s*([\d.]+)%\s+([\d.]+)\s+([\d.]+)\s*\)$/.exec(value.trim());
  if (lch) return { l: Number(lch[1]) / 100, c: Number(lch[2]), h: Number(lch[3]) };
  return /^#[0-9a-f]{6}$/i.test(value.trim()) ? hexToOklch(value) : null;
}

/** `from` mixed `share` of the way toward `to` in OKLab — `color-mix(in oklab, …)` — as `oklch(L% C H)`. */
function mixOklab(from: string, to: string, share: number): string {
  const a = asOklch(from);
  const b = asOklch(to);
  // Every surface and ink a palette is written with is one of the two forms.
  if (!a || !b) throw new Error(`Cannot mix ${from} with ${to}`);
  const lab = ({ l, c, h }: { l: number; c: number; h: number }) => [l, c * Math.cos((h * Math.PI) / 180), c * Math.sin((h * Math.PI) / 180)] as const;
  const [l1, a1, b1] = lab(a);
  const [l2, a2, b2] = lab(b);
  const L = l1 + (l2 - l1) * share;
  const A = a1 + (a2 - a1) * share;
  const B = b1 + (b2 - b1) * share;
  return `oklch(${round(L * 100, 1)}% ${round(Math.hypot(A, B), 4)} ${round(wrap((Math.atan2(B, A) * 180) / Math.PI), 1)})`;
}

/** The least a line shows against the raised surface it is drawn on. */
const MIN_LINE_CONTRAST = 1.4;

/**
 * A palette's outlines, from its raised surface and its ink: the line 14%
 * of the way to the ink, or as much further as it takes to show at 1.4:1,
 * and the strong line 30% of the way.
 */
function outlinesFor(raised: string, ink: string): { line: string; lineStrong: string } {
  let line = mixOklab(raised, ink, 0.14);
  for (let share = 15; share < 30 && (contrastRatio(line, raised) ?? 0) < MIN_LINE_CONTRAST; share += 1) {
    line = mixOklab(raised, ink, share / 100);
  }
  return { line, lineStrong: mixOklab(raised, ink, 0.3) };
}

/**
 * A custom theme's button: the accent, its label's colour and its hover.
 *
 * White on the accent where it reads. Where the hue makes the accent too
 * light for white and too dark for black — greens and cyans at 55% — the
 * accent steps darker until white reads, never below 3:1 as a mark on the
 * canvas. Bounded, so a seed nothing satisfies still ends: in the darkest
 * step that is still a mark, under whichever label reads better there.
 * The hover keeps the label and moves six steps lighter, or darker where
 * lighter would lose the label — held to the 3.5:1 the design system's
 * own hover clears (white on its L61 is 3.6:1), not to body text's 4.5:
 * it is a passing state over a label already read at rest.
 */
function buttonFor(a: number, ah: number, canvas: string, light: string, dark: string): { accent: string; ink: string; hover: string } {
  const reads = (ink: string, fill: string) => (contrastRatio(ink, fill) ?? 0) >= 4.5;
  const start = Number(/oklch\(([\d.]+)%/.exec(readableOn(55, a, ah, canvas, 3))?.[1] ?? 55);
  let chosen: { l: number; ink: string } | null = null;
  let darkest = start;
  for (let l = start; l >= 30; l -= 1) {
    const fill = oklch(l, a, ah);
    if ((contrastRatio(fill, canvas) ?? 0) < 3) break;
    darkest = l;
    if (reads(light, fill)) chosen = { l, ink: light };
    else if (reads(dark, fill)) chosen = { l, ink: dark };
    if (chosen) break;
  }
  if (!chosen) {
    const fill = oklch(darkest, a, ah);
    chosen = { l: darkest, ink: (contrastRatio(light, fill) ?? 0) >= (contrastRatio(dark, fill) ?? 0) ? light : dark };
  }
  const { l, ink } = chosen;
  const hoverL = [l + 6, l + 5, l + 4, l + 3, l - 4].find((step) => (contrastRatio(ink, oklch(step, a, ah)) ?? 0) >= 3.5) ?? l;
  return { accent: oklch(l, a, ah), ink, hover: oklch(hoverL, a, ah) };
}

/**
 * Every token, derived from a seed at the design system's lightness, then
 * held to its contrast pairs.
 *
 * The names are the design system's (`packages/ui/src/styles.css`), so
 * every Tailwind utility over them — `bg-canvas-raised`, `text-accent-soft`
 * — follows the theme without a line of component code changing.
 */
export function paletteFor(seed: ThemeSeed): Palette {
  // A seed is read from storage, and a hue of 1e999 parses to Infinity:
  // anything not a finite number is the design system's own value.
  const finite = (value: number, fallback: number) => (Number.isFinite(value) ? value : fallback);
  const g = clamp(finite(seed.ground.c, SLATE_SEED.ground.c), 0, 0.08);
  const gh = finite(seed.ground.h, SLATE_SEED.ground.h);
  const a = clamp(finite(seed.accent.c, SLATE_SEED.accent.c), 0.04, 0.24);
  const ah = finite(seed.accent.h, SLATE_SEED.accent.h);
  const canvas = oklch(21, g, gh);
  // The lightest surface text and marks sit on: what holds there holds below.
  const raised = oklch(28, g * 1.12, gh);
  const accentSubtle = oklch(31, a * 0.34, ah);
  // The button's label: white where it reads; where the hue makes the
  // accent too light for white (greens, cyans) and too dark for black, the
  // accent steps darker until white reads — still a mark on the canvas.
  const light = oklch(98, 0.01, ah);
  const dark = oklch(18, 0.02, ah);
  const button = buttonFor(a, ah, canvas, light, dark);
  // Ink carries a trace of the ground, as the design system's does, and
  // no more: enough chroma to belong to the room, not enough to tint text.
  const ink = oklch(94, Math.min(g * 0.4, 0.012), gh);
  const { line, lineStrong } = outlinesFor(raised, ink);
  return {
    // One step below the canvas, so the conversation reads as the lit middle.
    "--chat-deep": `color-mix(in oklab, ${canvas}, black 22%)`,
    "--color-canvas": canvas,
    "--color-canvas-subtle": oklch(24, g * 1.06, gh),
    "--color-canvas-raised": raised,
    "--color-canvas-hover": oklch(32, g * 1.18, gh),
    "--color-canvas-active": oklch(36, g * 1.25, gh),
    "--color-line": line,
    "--color-line-strong": lineStrong,
    "--color-ink": ink,
    "--color-ink-muted": readableOn(76, Math.min(g * 0.6, 0.02), gh, raised, 4.5),
    "--color-ink-subtle": readableOn(66, Math.min(g * 0.75, 0.025), gh, raised, 4.5),
    "--color-idle": readableOn(58, Math.min(g * 0.75, 0.025), gh, raised, 3),
    "--color-accent": button.accent,
    "--color-accent-hover": button.hover,
    "--color-accent-ink": button.ink,
    "--color-accent-subtle": accentSubtle,
    "--color-accent-soft": readableOn(80, a * 0.67, ah, accentSubtle, 4.5),
    "--color-focus": readableOn(70, a * 0.83, ah, raised, 3),
    "--color-scrim": `oklch(12% ${round(g * 1.25, 4)} ${round(wrap(gh), 1)} / 0.7)`,
    // The status and kind colours are the design system's: a seed says
    // nothing about them, and Slate's hold on any ground the seeds make.
    ...SLATE_STATUS,
  };
}

/** The design system's own slate, as a seed: where the pickers start when nothing else says. */
const SLATE_SEED: ThemeSeed = { ground: { h: 262, c: 0.016 }, accent: { h: 258, c: 0.18 } };

/** Slate's outlines, from its raised surface and its ink, as `styles.css` writes them out. */
const SLATE_OUTLINES = outlinesFor("oklch(28% 0.018 262)", "oklch(94% 0.006 262)");

/**
 * The presets, default first.
 *
 * The colours are each product's dark scheme as it is drawn, adjusted only
 * where EO needs something the product does not: a solid accent that
 * carries text (GitHub's primary button is green, which here means
 * running, so it is GitHub's blue), and a step between rows the product
 * draws with a translucent overlay.
 */
export const THEME_PRESETS: readonly ThemePreset[] = [
  {
    id: "claude",
    name: "Claude",
    // Claude's clay sits between failed (22°) and waiting (75°), where no
    // hue is 35° from both. It is kept because it is the scheme. It is the
    // action colour — buttons, links, the selected swatch — and the status
    // marks on a board and a run are the status scale's, never the
    // accent's, so a row never says "failed" in clay.
    palette: preset({
      deep: "#1f1e1d",
      canvas: "#262624",
      subtle: "#2b2b29",
      raised: "#30302e",
      hover: "#383835",
      active: "#3f3e3b",
      ink: "#f0eee6",
      inkMuted: "#c3c1b8",
      inkSubtle: "#9c9a92",
      idle: "#83817a",
      // A shade under the clay on claude.ai, so white text on it reads at 4.5:1.
      accent: "#b85a3a",
      accentHover: "#c6613f",
      accentInk: "#ffffff",
      accentSubtle: "#3e2b23",
      accentSoft: "#e8a68a",
      focus: "#d97757",
      scrim: "rgb(15 14 13 / 0.7)",
      running: "oklch(75% 0.15 142)",
      reviewing: "oklch(72% 0.14 308)",
      paused: "oklch(81% 0.14 76)",
      danger: "oklch(67% 0.19 20)",
      agent: "oklch(78% 0.11 200)",
      script: "oklch(78% 0.12 346)",
    }),
  },
  {
    id: "slate",
    name: "Slate",
    // `packages/ui/src/styles.css`, value for value.
    palette: {
      "--chat-deep": "color-mix(in oklab, oklch(21% 0.016 262), black 22%)",
      "--color-canvas": "oklch(21% 0.016 262)",
      "--color-canvas-subtle": "oklch(24% 0.017 262)",
      "--color-canvas-raised": "oklch(28% 0.018 262)",
      "--color-canvas-hover": "oklch(32% 0.019 262)",
      "--color-canvas-active": "oklch(36% 0.02 262)",
      "--color-line": SLATE_OUTLINES.line,
      "--color-line-strong": SLATE_OUTLINES.lineStrong,
      "--color-ink": "oklch(94% 0.006 262)",
      "--color-ink-muted": "oklch(76% 0.01 262)",
      "--color-ink-subtle": "oklch(66% 0.012 262)",
      "--color-idle": "oklch(58% 0.012 262)",
      "--color-accent": "oklch(55% 0.18 258)",
      "--color-accent-hover": "oklch(61% 0.18 258)",
      "--color-accent-ink": "oklch(98% 0.01 258)",
      "--color-accent-subtle": "oklch(31% 0.06 258)",
      "--color-accent-soft": "oklch(80% 0.12 258)",
      "--color-focus": "oklch(70% 0.15 258)",
      "--color-scrim": "oklch(12% 0.02 262 / 0.7)",
      ...SLATE_STATUS,
    },
  },
  {
    id: "linear",
    name: "Linear",
    palette: preset({
      deep: "#08090a",
      canvas: "#0f1011",
      subtle: "#141516",
      raised: "#1a1b1d",
      hover: "#212224",
      active: "#28292c",
      ink: "#f7f8f8",
      inkMuted: "#b4b7bd",
      inkSubtle: "#8a8f98",
      idle: "#6b6f76",
      // Linear's indigo turned 7° bluer, out of the review purple's 35°.
      accent: "#4f6ed3",
      accentHover: "#5d7ee1",
      accentInk: "#ffffff",
      accentSubtle: "#1d2040",
      accentSoft: "#a3aaf2",
      focus: "#7c85e6",
      scrim: "rgb(0 0 0 / 0.7)",
      running: "oklch(74% 0.16 150)",
      reviewing: "oklch(70% 0.15 300)",
      paused: "oklch(80% 0.14 78)",
      danger: "oklch(66% 0.2 22)",
      agent: "oklch(77% 0.12 198)",
      script: "oklch(77% 0.13 345)",
    }),
  },
  {
    id: "github-dimmed",
    name: "GitHub Dimmed",
    palette: preset({
      deep: "#1c2128",
      canvas: "#22272e",
      subtle: "#272d35",
      raised: "#2d333b",
      hover: "#373e47",
      active: "#3f4650",
      ink: "#cdd9e5",
      inkMuted: "#adbac7",
      inkSubtle: "#909daa",
      idle: "#737e8b",
      // GitHub's accent emphasis, a step lighter to read as a mark on the dimmed canvas.
      accent: "#336fcc",
      accentHover: "#4184e4",
      accentInk: "#ffffff",
      accentSubtle: "#253650",
      accentSoft: "#6cb6ff",
      focus: "#539bf5",
      scrim: "rgb(28 33 40 / 0.75)",
      running: "#57ab5a",
      reviewing: "#986ee2",
      paused: "#c69026",
      danger: "#e5534b",
      agent: "#39c5cf",
      script: "#e275ad",
    }),
  },
  {
    id: "nord",
    name: "Nord",
    palette: preset({
      deep: "#272c36",
      canvas: "#2e3440",
      subtle: "#333a47",
      raised: "#3b4252",
      hover: "#434c5e",
      active: "#4c566a",
      ink: "#eceff4",
      inkMuted: "#d8dee9",
      inkSubtle: "#a7b1c2",
      idle: "#8290a9",
      // Frost under Polar Night text, as Nord draws a primary button.
      accent: "#88c0d0",
      accentHover: "#9fcfdc",
      accentInk: "#2e3440",
      accentSubtle: "#364a58",
      accentSoft: "#88c0d0",
      // A ring a step lighter than the button it goes round.
      focus: "#d8e9ef",
      scrim: "rgb(36 41 51 / 0.75)",
      running: "#a3be8c",
      reviewing: "oklch(75% 0.07 333)",
      paused: "#ebcb8b",
      danger: "oklch(72% 0.13 18)",
      // Near the frost accent, which is a known open point (EO-683): the
      // accent is a button and the agent a chip, and they are kept apart by
      // shape rather than by hue here.
      agent: "oklch(79% 0.08 188)",
      script: "oklch(74% 0.085 285)",
    }),
  },
  {
    id: "catppuccin-mocha",
    name: "Catppuccin Mocha",
    palette: preset({
      deep: "#181825",
      canvas: "#1e1e2e",
      subtle: "#262637",
      raised: "#313244",
      hover: "#3b3d51",
      active: "#45475a",
      ink: "#cdd6f4",
      inkMuted: "#bac2de",
      inkSubtle: "#a6adc8",
      idle: "#7f849c",
      accent: "#89b4fa",
      accentHover: "#a3c4fb",
      accentInk: "#1e1e2e",
      accentSubtle: "#2c3550",
      accentSoft: "#b4befe",
      focus: "#b4befe",
      scrim: "rgb(17 17 27 / 0.75)",
      running: "#a6e3a1",
      reviewing: "#cba6f7",
      paused: "#f9e2af",
      danger: "#f38ba8",
      agent: "#94e2d5",
      script: "oklch(80% 0.1 48)",
    }),
  },
  {
    id: "tokyo-night",
    name: "Tokyo Night",
    palette: preset({
      deep: "#16161e",
      canvas: "#1a1b26",
      subtle: "#1f2030",
      raised: "#24283b",
      hover: "#292e42",
      active: "#2f3549",
      ink: "#c0caf5",
      inkMuted: "#a9b1d6",
      inkSubtle: "#868eb8",
      idle: "#68729d",
      accent: "#7aa2f7",
      accentHover: "#8fb2f9",
      accentInk: "#1a1b26",
      accentSubtle: "#283457",
      accentSoft: "#7dcfff",
      // A ring a step lighter than the button it goes round.
      focus: "#a9c8ff",
      scrim: "rgb(13 14 20 / 0.75)",
      running: "#9ece6a",
      reviewing: "#bb9af7",
      paused: "#e0af68",
      danger: "#f7768e",
      agent: "#73daca",
      script: "oklch(78% 0.1 40)",
    }),
  },
];

export const DEFAULT_PRESET_ID = "claude";

export type ThemeChoice = { kind: "preset"; id: string } | { kind: "custom"; seed: ThemeSeed };

/**
 * The status and kind hues the accent has to stay clear of, by what each
 * means. Slate's: each theme draws them in its own palette, but near
 * these hues, which is where a person has learnt to read them.
 */
const STATUS_HUES: readonly { hue: number; means: string }[] = [
  { hue: 150, means: "running" },
  { hue: 305, means: "waiting for review" },
  { hue: 75, means: "waiting on a person" },
  { hue: 22, means: "failed" },
  { hue: 205, means: "an agent's step" },
  { hue: 345, means: "a script's step" },
];

/** The separation ARCHITECTURE.md, "What the checker enforces", asks between the accent and any status or kind colour. */
const MIN_SEPARATION = 35;

/**
 * The status or step kind an accent is too close to, or null. A clash is only a clash
 * with colour in it: a near-grey accent has no hue to mistake.
 */
export function statusClash(accent: ThemeSeed["accent"]): string | null {
  if (accent.c < 0.06) return null;
  for (const status of STATUS_HUES) {
    const apart = Math.abs(((wrap(accent.h) - status.hue + 540) % 360) - 180);
    if (apart < MIN_SEPARATION) return status.means;
  }
  return null;
}

/* ── #rrggbb ⇄ OKLCH, for the custom pickers ─────────────────────────── */

/** A `#rrggbb` colour as OKLCH: lightness 0–1, chroma, hue in degrees. */
export function hexToOklch(hex: string): { l: number; c: number; h: number } | null {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) return null;
  const value = parseInt(match[1]!, 16);
  const r = toLinear(((value >> 16) & 255) / 255);
  const g = toLinear(((value >> 8) & 255) / 255);
  const b = toLinear((value & 255) / 255);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return { l: L, c: Math.sqrt(A * A + B * B), h: wrap((Math.atan2(B, A) * 180) / Math.PI) };
}

/** An OKLCH colour as `#rrggbb`, clipped into sRGB. */
export function oklchToHex(l: number, c: number, h: number): string {
  const rad = (h * Math.PI) / 180;
  const A = c * Math.cos(rad);
  const B = c * Math.sin(rad);
  const l_ = (l + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m_ = (l - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s_ = (l - 0.0894841775 * A - 1.291485548 * B) ** 3;
  const channels = [
    4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
    -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
    -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_,
  ];
  return `#${channels
    .map((channel) => Math.round(clamp(toGamma(clamp(channel, 0, 1)), 0, 1) * 255).toString(16).padStart(2, "0"))
    .join("")}`;
}

/**
 * A palette colour as `#rrggbb`, or null for a form this does not read.
 *
 * For what cannot read CSS itself: Electron's title bar overlay (EO-668)
 * takes hex, and the palettes are written in hex, `oklch(L% C H)`, and —
 * the deep, in Slate and every custom theme — `color-mix(in oklab, …,
 * black N%)`. Mixing toward black in OKLab scales every coordinate toward
 * zero, so in OKLCH it is the lightness and the chroma scaled alike, with
 * the hue kept.
 */
export function colourAsHex(value: string): string | null {
  const text = value.trim();
  if (/^#[0-9a-f]{6}$/i.test(text)) return text.toLowerCase();
  const lch = /^oklch\(\s*([\d.]+)%\s+([\d.]+)\s+([\d.]+)\s*\)$/.exec(text);
  if (lch) return oklchToHex(Number(lch[1]) / 100, Number(lch[2]), Number(lch[3]));
  const mix = /^color-mix\(in oklab,\s*(.+),\s*black\s+([\d.]+)%\s*\)$/.exec(text);
  if (!mix) return null;
  const base = colourAsHex(mix[1]!);
  const colour = base === null ? null : hexToOklch(base);
  if (colour === null) return null;
  const keep = 1 - clamp(Number(mix[2]) / 100, 0, 1);
  return oklchToHex(colour.l * keep, colour.c * keep, colour.h);
}

/**
 * The window controls' colours for a palette (EO-668): the ground they are
 * drawn on, which is whatever the top row is at the window's right edge —
 * the deep of the canvas and the overview, or the conversation's canvas —
 * and the rail's muted ink for their symbols.
 */
export function titleBarColours(palette: Palette, under: "deep" | "canvas"): { color: string; symbolColor: string } | null {
  const color = colourAsHex(palette[under === "deep" ? "--chat-deep" : "--color-canvas"]);
  const symbolColor = colourAsHex(palette["--color-ink-muted"]);
  return color === null || symbolColor === null ? null : { color, symbolColor };
}

/**
 * A picked colour as a seed half: its hue and how much colour it has,
 * with the strength held to what that half of the palette can carry.
 */
export function seedFromHex(hex: string, part: "ground" | "accent"): { h: number; c: number } | null {
  const colour = hexToOklch(hex);
  if (!colour) return null;
  // A ground picked at full strength would be a coloured wall; a third of
  // its chroma, capped, keeps the hue and the room still reads as dark.
  return part === "ground" ? { h: colour.h, c: clamp(colour.c * 0.35, 0, 0.08) } : { h: colour.h, c: clamp(colour.c, 0.04, 0.24) };
}

/** What a picker shows for a seed half: the colour at the lightness its swatch is drawn at. */
export function hexForSeed(part: "ground" | "accent", seed: { h: number; c: number }): string {
  return part === "ground" ? oklchToHex(0.3, seed.c / 0.35, seed.h) : oklchToHex(0.55, seed.c, seed.h);
}

/* ── the stored choice ───────────────────────────────────────────────── */

export const THEME_STORAGE_KEY = "eo.chatTheme";

const listeners = new Set<() => void>();
let cachedRaw: string | null | undefined;
let cached: ThemeChoice = { kind: "preset", id: DEFAULT_PRESET_ID };

function isSeedHalf(value: unknown): value is { h: number; c: number } {
  if (typeof value !== "object" || value === null) return false;
  const { h, c } = value as { h: unknown; c: unknown };
  // `JSON.parse` turns 1e999 into Infinity, which is a number and no hue.
  return typeof h === "number" && Number.isFinite(h) && typeof c === "number" && Number.isFinite(c);
}

function parse(raw: string | null): ThemeChoice {
  if (raw === null) return { kind: "preset", id: DEFAULT_PRESET_ID };
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value === "object" && value !== null) {
      const choice = value as { kind?: unknown; id?: unknown; seed?: { ground?: unknown; accent?: unknown } };
      if (choice.kind === "preset" && typeof choice.id === "string" && THEME_PRESETS.some((preset) => preset.id === choice.id)) {
        return { kind: "preset", id: choice.id };
      }
      if (choice.kind === "custom" && isSeedHalf(choice.seed?.ground) && isSeedHalf(choice.seed?.accent)) {
        return { kind: "custom", seed: { ground: choice.seed.ground, accent: choice.seed.accent } };
      }
    }
  } catch {
    // A value somebody hand-edited into nonsense is the default theme.
  }
  return { kind: "preset", id: DEFAULT_PRESET_ID };
}

/** The same object for the same stored text, as `useSyncExternalStore` needs. */
function read(): ThemeChoice {
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(THEME_STORAGE_KEY);
  } catch {
    raw = null;
  }
  if (raw !== cachedRaw) {
    cachedRaw = raw;
    cached = parse(raw);
  }
  return cached;
}

/** The stored choice as this device holds it now. */
export const readThemeChoice: () => ThemeChoice = read;

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key === THEME_STORAGE_KEY) listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

export function setThemeChoice(choice: ThemeChoice): void {
  try {
    if (choice.kind === "preset" && choice.id === DEFAULT_PRESET_ID) window.localStorage.removeItem(THEME_STORAGE_KEY);
    else window.localStorage.setItem(THEME_STORAGE_KEY, JSON.stringify(choice));
  } catch {
    // Nothing to remember it in; the default stays, which is honest.
  }
  for (const listener of listeners) listener();
}

const DEFAULT_CHOICE: ThemeChoice = { kind: "preset", id: DEFAULT_PRESET_ID };

export function useThemeChoice(): ThemeChoice {
  return useSyncExternalStore(subscribe, read, () => DEFAULT_CHOICE);
}

function presetOf(id: string): ThemePreset {
  return THEME_PRESETS.find((candidate) => candidate.id === id) ?? THEME_PRESETS[0]!;
}

/** The palette a choice paints. */
export function paletteOf(choice: ThemeChoice): Palette {
  return choice.kind === "custom" ? paletteFor(choice.seed) : presetOf(choice.id).palette;
}

/**
 * The seed a choice stands for: a custom theme's own, or a preset's room
 * and accent read back as hue and strength — which is where the pickers
 * start from when somebody adjusts a preset.
 */
export function seedOf(choice: ThemeChoice): ThemeSeed {
  if (choice.kind === "custom") return choice.seed;
  const palette = presetOf(choice.id).palette;
  const ground = hexToOklch(palette["--color-canvas"]);
  const accent = hexToOklch(palette["--color-accent"]);
  if (!ground || !accent) return SLATE_SEED;
  return { ground: { h: ground.h, c: ground.c }, accent: { h: accent.h, c: accent.c } };
}

/**
 * Paints the chosen theme onto the document while it is mounted.
 *
 * On the root element rather than on the frame, so what renders in a
 * portal — a dialog, a dropdown — wears the same colours as the window
 * it opens over. Every property it set is removed when it unmounts,
 * which leaves the root as `styles.css` draws it: Slate, the design
 * system's own palette.
 */
export function useChatTheme(): void {
  const choice = useThemeChoice();
  // Before paint: the first frame of the window is in its theme, never a
  // frame of the design system's palette first.
  useLayoutEffect(() => {
    const root = document.documentElement;
    const palette = paletteOf(choice);
    for (const name of THEME_TOKENS) root.style.setProperty(name, palette[name]);
    return () => {
      for (const name of THEME_TOKENS) root.style.removeProperty(name);
    };
  }, [choice]);
}

/**
 * The chosen theme as a style for one element, rather than the document
 * (EO-527).
 *
 * For what is drawn over a window — the keep-or-move sheet — and has to
 * wear the chosen theme's colours without repainting whatever it is
 * drawn over. The tokens are CSS variables, so setting
 * them on an element reaches everything inside it; what it portals out
 * of itself does not come with it, which is why a whole-window screen
 * uses `useChatTheme` instead.
 */
export function useChatPalette(): CSSProperties {
  const choice = useThemeChoice();
  return useMemo(() => {
    const palette = paletteOf(choice);
    return Object.fromEntries(THEME_TOKENS.map((name) => [name, palette[name]])) as CSSProperties;
  }, [choice]);
}
