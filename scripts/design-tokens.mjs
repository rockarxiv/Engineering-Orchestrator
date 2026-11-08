/**
 * Checks contrast for the design system and regenerates `tokens.css`.
 *
 * Two jobs, one script, because they read the same parse:
 *
 *   1. Contrast is *computed*, not asserted. An earlier version of this
 *      system's header claimed "38 pairs, both themes" and shipped a 3.4:1
 *      label, so a claim in a comment is worth exactly nothing. This fails
 *      the build instead.
 *
 *   2. `tokens.css` at the repo root is generated from the `@theme` block
 *      in `packages/ui/src/styles.css`. It used to be a hand-maintained
 *      "portable copy", which meant two files had to be kept in step by
 *      hand. Now it is an artifact — edit styles.css, run this.
 *
 * Usage:  node scripts/design-tokens.mjs [--check]
 *         --check verifies tokens.css is current without writing it.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const STYLES_CSS = join(root, "packages/ui/src/styles.css");
const TOKENS_CSS = join(root, "tokens.css");

/* ── colour ─────────────────────────────────────────────────────────── */

/** oklch(L% C H [/ A]) → {l, c, h, alpha}. Returns null for anything else. */
function parseOklch(value) {
  const match = /^oklch\(\s*([\d.]+)%\s+([\d.]+)\s+([\d.]+)\s*(?:\/\s*([\d.]+)\s*)?\)$/.exec(
    value.trim(),
  );
  if (!match) return null;
  return {
    l: Number(match[1]) / 100,
    c: Number(match[2]),
    h: Number(match[3]),
    alpha: match[4] === undefined ? 1 : Number(match[4]),
  };
}

/** OKLCH → linear sRGB, clamped into gamut. */
function oklchToLinearRgb({ l, c, h }) {
  const rad = (h * Math.PI) / 180;
  const a = c * Math.cos(rad);
  const b = c * Math.sin(rad);

  const lp = l + 0.3963377774 * a + 0.2158037573 * b;
  const mp = l - 0.1055613458 * a - 0.0638541728 * b;
  const sp = l - 0.0894841775 * a - 1.291485548 * b;

  const L = lp ** 3;
  const M = mp ** 3;
  const S = sp ** 3;

  const clamp = (x) => Math.min(1, Math.max(0, x));
  return {
    r: clamp(4.0767416621 * L - 3.3077115913 * M + 0.2309699292 * S),
    g: clamp(-1.2684380046 * L + 2.6097574011 * M - 0.3413193965 * S),
    b: clamp(-0.0041960863 * L - 0.7034186147 * M + 1.707614701 * S),
  };
}

/** WCAG relative luminance. Input is already linear-light, so no decode. */
function luminance(colour) {
  const { r, g, b } = oklchToLinearRgb(colour);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(fg, bg) {
  const a = luminance(fg);
  const b = luminance(bg);
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

/* ── parse ──────────────────────────────────────────────────────────── */

const css = readFileSync(STYLES_CSS, "utf8");

/**
 * Every declaration inside the `@theme { … }` block.
 *
 * Comments are stripped first. The brace walk below counts raw braces, so
 * a `}` inside a comment — easy to write when the prose is about CSS —
 * ended the block early, and the checker then cheerfully verified the
 * handful of tokens it had found and wrote a truncated tokens.css.
 */
function parseTheme(source) {
  source = source.replace(/\/\*[\s\S]*?\*\//g, "");
  const start = source.indexOf("@theme {");
  if (start === -1) return new Map();

  // Walk braces so a nested block can't end the parse early.
  let depth = 0;
  let end = start;
  for (let i = source.indexOf("{", start); i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }

  const body = source.slice(start, end);
  const tokens = new Map();
  const declRe = /^\s*(--[a-z0-9-]+)\s*:\s*([^;]+);/gim;
  let decl;
  while ((decl = declRe.exec(body)) !== null) {
    tokens.set(decl[1], decl[2].trim().replace(/\s+/g, " "));
  }
  return tokens;
}

const tokens = parseTheme(css);

if (tokens.size === 0) {
  console.error("No @theme block found in packages/ui/src/styles.css.");
  process.exit(1);
}

/* ── the pairs that must hold ───────────────────────────────────────── */

/*
 * 4.5:1 is body text. 3:1 is what WCAG asks of large text, icons, and
 * non-text indicators — which is what the status scale actually is: a dot,
 * a rule, an icon, never a paragraph.
 */
const TEXT = 4.5;
const NON_TEXT = 3;

const surfaces = ["--color-canvas", "--color-canvas-subtle", "--color-canvas-raised"];

const pairs = [];
const add = (fg, bg, min, label) => pairs.push({ fg, bg, min, label });

for (const surface of surfaces) {
  add("--color-ink", surface, TEXT, "body text");
  add("--color-ink-muted", surface, TEXT, "muted text");
  add("--color-ink-subtle", surface, TEXT, "subtle text");
}

// The accent as a filled control, and as text on its own tint.
add("--color-accent-ink", "--color-accent", TEXT, "text on accent fill");
add("--color-accent-soft", "--color-accent-subtle", TEXT, "accent text on tint");
add("--color-accent", "--color-canvas", NON_TEXT, "accent mark");
add("--color-focus", "--color-canvas", NON_TEXT, "focus ring");
add("--color-focus", "--color-canvas-raised", NON_TEXT, "focus ring on panel");

// Status marks recur on every row, over the surfaces rows sit on.
for (const status of [
  "--color-running",
  "--color-reviewing",
  "--color-paused",
  "--color-idle",
  "--color-danger",
  "--color-warning",
  "--color-success",
]) {
  add(status, "--color-canvas", NON_TEXT, "status mark");
  add(status, "--color-canvas-subtle", NON_TEXT, "status mark on row");
  add(status, "--color-canvas-raised", NON_TEXT, "status mark on card");
}

// A step's kind is a chip of its own colour (ARCHITECTURE.md, "Colour"):
// its text and border are that colour, on every surface a step is drawn on.
const KINDS = ["--color-kind-agent", "--color-kind-script"];
for (const kind of KINDS) {
  for (const surface of surfaces) add(kind, surface, NON_TEXT, "step kind chip");
}

/* ── check ──────────────────────────────────────────────────────────── */

let failures = 0;
let checked = 0;
const rows = [];

for (const { fg, bg, min, label } of pairs) {
  /*
   * Every skip used to be silent, so a palette the checker could not read
   * reported "all pass". A token written as `oklch(0.30 0.006 262)` — valid
   * CSS, and the fractional form Tailwind itself emits — parsed as nothing,
   * skipped its pairs, and passed a 1.1:1 body text.
   */
  for (const [role, name] of [["foreground", fg], ["background", bg]]) {
    if (!tokens.has(name)) {
      failures += 1;
      rows.push(`  FAIL  ${name} is missing, so the ${role} of [${label}] was never checked`);
    } else if (!parseOklch(tokens.get(name))) {
      failures += 1;
      rows.push(`  FAIL  ${name} is not parseable oklch(L% C H) — got \`${tokens.get(name)}\``);
    }
  }

  const fgColour = parseOklch(tokens.get(fg) ?? "");
  const bgColour = parseOklch(tokens.get(bg) ?? "");
  if (!fgColour || !bgColour) continue;

  const ratio = contrast(fgColour, bgColour);
  checked += 1;
  if (ratio < min) {
    failures += 1;
    rows.push(`  FAIL  ${ratio.toFixed(2)}:1 (needs ${min}) — ${fg} on ${bg}  [${label}]`);
  }
}

/*
 * The three-step ink ladder has to actually be three steps. In an earlier
 * palette `ink-muted` and `ink-subtle` were 3% of lightness apart — both
 * cleared contrast against the canvas and were indistinguishable from each
 * other, so the hierarchy the whole design leaned on silently collapsed to
 * two without failing anything.
 */
const muted = parseOklch(tokens.get("--color-ink-muted") ?? "");
const subtle = parseOklch(tokens.get("--color-ink-subtle") ?? "");
if (muted && subtle) {
  const separation = Math.abs(muted.l - subtle.l);
  if (separation < 0.08) {
    failures += 1;
    rows.push(
      `  FAIL  ink-muted and ink-subtle are ${(separation * 100).toFixed(1)}% apart ` +
        `(needs 8%) — the ink ladder collapses to two steps`,
    );
  }
}

/*
 * The accent must not be mistakable for a run state. This is the rule an
 * earlier indigo broke at 18° from the reviewing blue, and the reason
 * `reviewing` is violet here rather than the blue it wants to be.
 */
const accent = parseOklch(tokens.get("--color-accent") ?? "");
if (accent && accent.c >= 0.04) {
  for (const status of ["--color-running", "--color-reviewing", "--color-paused"]) {
    const colour = parseOklch(tokens.get(status) ?? "");
    if (!colour || colour.c < 0.04) continue;
    const delta = Math.abs(((accent.h - colour.h + 540) % 360) - 180);
    if (delta < 35) {
      failures += 1;
      rows.push(
        `  FAIL  accent is ${delta.toFixed(0)}° from ${status} (needs 35°) — ` +
          `"you can act" and "the machine is working" read as one family`,
      );
    }
  }
}

/*
 * A step kind must not be mistakable for a run state either. The scale is
 * fixed like the status scale, and a chip within 35° of one would read as
 * that state — which is why the first proposal's green (running's own hue)
 * was refused.
 */
for (const kind of KINDS) {
  const colour = parseOklch(tokens.get(kind) ?? "");
  if (!colour) continue; // its contrast pairs have already failed it
  for (const status of ["--color-running", "--color-reviewing", "--color-paused", "--color-danger"]) {
    const other = parseOklch(tokens.get(status) ?? "");
    if (!other) {
      failures += 1;
      rows.push(`  FAIL  ${status} is missing or unparseable, so ${kind} was never held apart from it`);
      continue;
    }
    const delta = Math.abs(((colour.h - other.h + 540) % 360) - 180);
    if (delta < 35) {
      failures += 1;
      rows.push(`  FAIL  ${kind} is ${delta.toFixed(0)}° from ${status} (needs 35°) — a step's kind reads as a run state`);
    }
  }
}

if (checked !== pairs.length) {
  failures += 1;
  rows.push(
    `  FAIL  only ${checked} of ${pairs.length} pairs were computed — ` +
      `an unchecked pair is not a passing one`,
  );
}

console.log(`Pairs computed: ${checked} of ${pairs.length}`);
console.log(rows.length === 0 ? "  all pass" : rows.join("\n"));

/* ── emit tokens.css ────────────────────────────────────────────────── */

function renderTokens() {
  const lines = [
    "/* GENERATED — do not edit. Run `pnpm design`.",
    " *",
    " * The portable copy of the design system.",
    " * `packages/ui/src/styles.css` is the implementation the app loads;",
    " * `ARCHITECTURE.md`, \"The visual design system\", says why any value is what it is.",
    " */",
    "",
    ":root {",
  ];

  for (const [name, value] of tokens) {
    lines.push(`  ${name}: ${value};`);
  }

  lines.push("}", "");
  return lines.join("\n");
}

const generated = renderTokens();

if (process.argv.includes("--check")) {
  let current = "";
  try {
    current = readFileSync(TOKENS_CSS, "utf8");
  } catch {
    current = "";
  }
  if (current !== generated) {
    console.error("\ntokens.css is stale — run `pnpm design`.");
    process.exit(1);
  }
  console.log("tokens.css is current.");
} else if (failures > 0) {
  // Writing from a bad parse is how a truncated tokens.css ships.
  console.error("\nRefusing to write tokens.css while the system fails its own checks.");
} else {
  writeFileSync(TOKENS_CSS, generated);
  console.log(`\nWrote ${TOKENS_CSS}`);
}

if (failures > 0) {
  console.error(`\n${failures} contrast/system failure(s).`);
  process.exit(1);
}
