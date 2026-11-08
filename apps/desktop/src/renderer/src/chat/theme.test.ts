import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_PRESET_ID,
  THEME_PRESETS,
  THEME_TOKENS,
  THEME_STORAGE_KEY,
  colourAsHex,
  contrastRatio,
  hexForSeed,
  hexToOklch,
  oklchToHex,
  paletteFor,
  paletteOf,
  readThemeChoice,
  seedFromHex,
  seedOf,
  setThemeChoice,
  statusClash,
  titleBarColours,
  type Palette,
  type ThemeSeed,
  type ThemeToken,
} from "./theme";

const SLATE_LIKE: ThemeSeed = { ground: { h: 262, c: 0.016 }, accent: { h: 258, c: 0.18 } };

/** The status scale and the step-kind scale, which no theme touches, as `styles.css` declares them. */
const STYLES = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../../../../../packages/ui/src/styles.css"), "utf8");
const STATUS: Record<string, string> = Object.fromEntries(
  ["--color-running", "--color-reviewing", "--color-paused", "--color-danger", "--color-warning", "--color-success", "--color-kind-agent", "--color-kind-script"].map((token) => [
    token,
    new RegExp(`${token}:\\s*(oklch\\([^)]*\\));`).exec(STYLES)![1]!,
  ]),
);

/** `scripts/design-tokens.mjs`'s pairs: the ones ARCHITECTURE.md, "What the checker enforces", calls not advisory. */
const PAIRS: { fg: string; bg: string; min: number }[] = (() => {
  const pairs: { fg: string; bg: string; min: number }[] = [];
  const surfaces = ["--color-canvas", "--color-canvas-subtle", "--color-canvas-raised"];
  for (const surface of surfaces) {
    for (const ink of ["--color-ink", "--color-ink-muted", "--color-ink-subtle"]) pairs.push({ fg: ink, bg: surface, min: 4.5 });
  }
  pairs.push({ fg: "--color-accent-ink", bg: "--color-accent", min: 4.5 });
  pairs.push({ fg: "--color-accent-soft", bg: "--color-accent-subtle", min: 4.5 });
  pairs.push({ fg: "--color-accent", bg: "--color-canvas", min: 3 });
  pairs.push({ fg: "--color-focus", bg: "--color-canvas", min: 3 });
  pairs.push({ fg: "--color-focus", bg: "--color-canvas-raised", min: 3 });
  for (const status of [...Object.keys(STATUS), "--color-idle"]) {
    for (const surface of surfaces) pairs.push({ fg: status, bg: surface, min: 3 });
  }
  return pairs;
})();

afterEach(() => {
  window.localStorage.removeItem(THEME_STORAGE_KEY);
});

describe("a theme's palette", () => {
  const slate = () => THEME_PRESETS.find((preset) => preset.id === "slate")!.palette;

  it("opens on Claude", () => {
    expect(DEFAULT_PRESET_ID).toBe("claude");
    expect(THEME_PRESETS[0]!.id).toBe("claude");
    expect(paletteOf({ kind: "preset", id: DEFAULT_PRESET_ID })["--color-canvas"]).toBe("#262624");
  });

  it("is the design system's own values for Slate, token for token", () => {
    for (const token of THEME_TOKENS) {
      if (token === "--chat-deep") continue;
      const declared = new RegExp(`${token}:\\s*([^;]+);`).exec(STYLES)?.[1];
      expect(slate()[token], token).toBe(declared);
    }
  });

  it("sets every token in every preset, and never a status colour", () => {
    for (const preset of THEME_PRESETS) {
      expect(Object.keys(preset.palette).sort(), preset.id).toEqual([...THEME_TOKENS].sort());
    }
    for (const status of ["--color-running", "--color-reviewing", "--color-paused", "--color-danger", "--color-success", "--color-warning", "--color-kind-agent", "--color-kind-script"]) {
      expect(THEME_TOKENS as readonly string[]).not.toContain(status);
    }
  });

  it("holds every preset, and any colour a person picks, to the design system's contrast pairs", () => {
    const seeds: ThemeSeed[] = [];
    for (let gh = 0; gh < 360; gh += 45) {
      for (const gc of [0, 0.04, 0.08]) {
        for (let ah = 0; ah < 360; ah += 30) for (const ac of [0.06, 0.15, 0.24]) seeds.push({ ground: { h: gh, c: gc }, accent: { h: ah, c: ac } });
      }
    }
    const palettes: [string, Palette][] = [
      ...THEME_PRESETS.map((preset): [string, Palette] => [preset.id, preset.palette]),
      ...seeds.map((seed): [string, Palette] => [`custom ${JSON.stringify(seed)}`, paletteFor(seed)]),
    ];
    const failures: string[] = [];
    for (const [name, palette] of palettes) {
      const colour = (token: string) => (token in palette ? palette[token as ThemeToken] : STATUS[token]!);
      for (const pair of PAIRS) {
        const ratio = contrastRatio(colour(pair.fg), colour(pair.bg));
        if (ratio === null) failures.push(`${name}: ${pair.fg} on ${pair.bg} could not be measured`);
        else if (ratio < pair.min) failures.push(`${name}: ${pair.fg} on ${pair.bg} is ${ratio.toFixed(2)}, needs ${pair.min}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it("keeps every preset's accent clear of the status colours, but Claude's clay", () => {
    for (const preset of THEME_PRESETS) {
      const accent = hexToOklch(preset.palette["--color-accent"]);
      if (accent === null) continue;
      expect(statusClash(accent), preset.id).toBe(preset.id === "claude" ? "failed" : null);
    }
  });

  it("derives a custom theme from the design system's lightness, stepping lighter only where a pair needs it", () => {
    const lightness = (value: string) => Number(/oklch\(([\d.]+)%/.exec(value)?.[1]);
    const quiet = paletteFor(SLATE_LIKE);
    // A seed the design system's own lightness already suits is drawn at exactly that lightness.
    for (const name of THEME_TOKENS) {
      if (name === "--chat-deep" || name === "--color-scrim") continue;
      expect(lightness(quiet[name]), name).toBe(lightness(slate()[name]));
    }
    const loud = paletteFor({ ground: { h: 30, c: 0.4 }, accent: { h: 200, c: 0.5 } });
    for (const name of THEME_TOKENS) {
      if (name === "--chat-deep" || name === "--color-scrim" || name === "--color-accent-ink") continue;
      expect(lightness(loud[name]), name).toBeGreaterThanOrEqual(lightness(slate()[name]));
    }
    // And holds a picked colour to what the ground and the accent can carry.
    expect(loud["--color-canvas"]).toBe("oklch(21% 0.08 30)");
    expect(loud["--color-accent"]).toBe("oklch(55% 0.24 200)");
  });

  it("keeps the label readable on hover too, to the design system's own hover", () => {
    for (let ah = 0; ah < 360; ah += 10) {
      for (const ac of [0.06, 0.15, 0.24]) {
        const palette = paletteFor({ ground: { h: 262, c: 0.016 }, accent: { h: ah, c: ac } });
        // The design system's own hover is 3.6:1; no custom hover falls below its bar.
        expect(contrastRatio(palette["--color-accent-ink"], palette["--color-accent-hover"]), `h${ah} c${ac}`).toBeGreaterThanOrEqual(3.5);
      }
    }
  });

  it("ends, in the design system's colours, for a seed that is no number", () => {
    const palette = paletteFor({ ground: { h: Number.NaN, c: Number.POSITIVE_INFINITY }, accent: { h: Number.POSITIVE_INFINITY, c: 0.18 } });
    expect(palette["--color-accent"]).toBe("oklch(55% 0.18 258)");
    expect(palette["--color-canvas"]).toBe("oklch(21% 0.016 262)");
  });

  it("puts dark text on an accent too light for white", () => {
    const green = paletteFor({ ground: { h: 262, c: 0.016 }, accent: { h: 180, c: 0.24 } });
    expect(green["--color-accent-ink"]).toMatch(/^oklch\(18%/);
    expect(paletteFor(SLATE_LIKE)["--color-accent-ink"]).toMatch(/^oklch\(98%/);
  });

  it("starts the pickers from a preset's own room and accent", () => {
    const seed = seedOf({ kind: "preset", id: "nord" });
    expect(seed.ground.h).toBeCloseTo(hexToOklch("#2e3440")!.h, 5);
    expect(seed.accent.h).toBeCloseTo(hexToOklch("#88c0d0")!.h, 5);
  });
});

describe("an accent too close to a status", () => {
  it("is named by what that status means", () => {
    expect(statusClash({ h: 145, c: 0.17 })).toBe("running");
    expect(statusClash({ h: 300, c: 0.17 })).toBe("waiting for review");
    expect(statusClash({ h: 80, c: 0.17 })).toBe("waiting on a person");
    expect(statusClash({ h: 5, c: 0.17 })).toBe("failed");
  });

  it("is not a clash when it has too little colour to mistake", () => {
    expect(statusClash({ h: 150, c: 0.04 })).toBeNull();
  });
});

describe("a picked colour", () => {
  it("survives the trip to OKLCH and back", () => {
    for (const hex of ["#3b82f6", "#10b981", "#7c3aed", "#f59e0b", "#1f2937"]) {
      const colour = hexToOklch(hex)!;
      expect(oklchToHex(colour.l, colour.c, colour.h)).toBe(hex);
    }
  });

  it("becomes a seed with its hue, and shows back as near enough the same seed", () => {
    for (const part of ["ground", "accent"] as const) {
      const seed = seedFromHex("#2563eb", part)!;
      expect(seed.h).toBeCloseTo(hexToOklch("#2563eb")!.h, 5);
      const again = seedFromHex(hexForSeed(part, seed), part)!;
      // Within what eight bits a channel and the sRGB gamut leave of it.
      expect(Math.abs(again.h - seed.h), part).toBeLessThan(3);
      expect(Math.abs(again.c - seed.c), part).toBeLessThan(0.02);
    }
  });

  it("is refused when it is not a colour", () => {
    expect(seedFromHex("blue", "accent")).toBeNull();
  });
});

describe("the stored choice", () => {
  it("is the default when a stored hue is not a finite number", () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, '{"kind":"custom","seed":{"ground":{"h":262,"c":0.016},"accent":{"h":1e999,"c":0.18}}}');
    expect(readThemeChoice()).toEqual({ kind: "preset", id: DEFAULT_PRESET_ID });
  });

  it("forgets the default rather than storing it", () => {
    setThemeChoice({ kind: "preset", id: "nord" });
    expect(JSON.parse(window.localStorage.getItem(THEME_STORAGE_KEY)!)).toEqual({ kind: "preset", id: "nord" });
    setThemeChoice({ kind: "preset", id: "claude" });
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
  });
});

/**
 * The window controls' colours (EO-668): Electron's overlay reads hex, and
 * the palettes are written in hex, OKLCH and `color-mix` toward black.
 */
describe("the title bar's colours", () => {
  it("reads every form a palette is written in", () => {
    expect(colourAsHex("#B85A3A")).toBe("#b85a3a");
    expect(colourAsHex("oklch(21% 0.016 262)")).toBe(oklchToHex(0.21, 0.016, 262));
    // Toward black in OKLab: the lightness scaled, the hue kept.
    const deep = hexToOklch(colourAsHex("color-mix(in oklab, oklch(21% 0.016 262), black 22%)")!)!;
    expect(deep.l).toBeCloseTo(0.21 * 0.78, 2);
    expect(deep.h).toBeCloseTo(262, -1);
    expect(colourAsHex("color-mix(in oklab, #ffffff, black 100%)")).toBe("#000000");
    expect(colourAsHex("rgb(15 14 13 / 0.7)")).toBeNull();
  });

  it("has a ground and a symbol colour for every preset and a custom theme, on either ground", () => {
    const palettes = [...THEME_PRESETS.map((preset) => preset.palette), paletteFor(SLATE_LIKE), paletteFor({ ground: { h: 150, c: 0.08 }, accent: { h: 30, c: 0.2 } })];
    for (const palette of palettes) {
      for (const under of ["deep", "canvas"] as const) {
        const colours = titleBarColours(palette, under);
        expect(colours).toEqual({ color: expect.stringMatching(/^#[0-9a-f]{6}$/), symbolColor: expect.stringMatching(/^#[0-9a-f]{6}$/) });
        // The symbols read on the ground they are drawn on.
        expect(contrastRatio(colours!.symbolColor, colours!.color)).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("matches what the window opens with, until the renderer says otherwise", () => {
    // `mainWindowChrome` starts the overlay on the default theme's deep and muted ink.
    expect(titleBarColours(paletteOf({ kind: "preset", id: DEFAULT_PRESET_ID }), "deep")).toEqual({ color: "#1f1e1d", symbolColor: "#c3c1b8" });
  });

  it("changes with the theme", () => {
    const claude = titleBarColours(paletteOf({ kind: "preset", id: "claude" }), "deep");
    const nord = titleBarColours(paletteOf({ kind: "preset", id: "nord" }), "deep");
    expect(nord).toEqual({ color: "#272c36", symbolColor: "#d8dee9" });
    expect(nord).not.toEqual(claude);
  });
});
