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

const STYLES = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../../../../../packages/ui/src/styles.css"), "utf8");

/** The status scale and the step-kind scale: themed, each preset in its own palette. */
const STATUS = ["--color-running", "--color-reviewing", "--color-paused", "--color-danger", "--color-warning", "--color-success", "--color-kind-agent", "--color-kind-script"] as const;

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
  for (const status of [...STATUS, "--color-idle"]) {
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

  it("sets every token in every preset, the status and kind colours among them", () => {
    for (const status of STATUS) expect(THEME_TOKENS as readonly string[]).toContain(status);
    for (const preset of THEME_PRESETS) {
      expect(Object.keys(preset.palette).sort(), preset.id).toEqual([...THEME_TOKENS].sort());
    }
  });

  it("draws the status and kind colours in each preset's own palette, success as running and warning as paused", () => {
    // running · reviewing · paused · danger · agent · script, as EO-684 lists them.
    const expected: Record<string, readonly string[]> = {
      claude: ["oklch(75% 0.15 142)", "oklch(72% 0.14 308)", "oklch(81% 0.14 76)", "oklch(67% 0.19 20)", "oklch(78% 0.11 200)", "oklch(78% 0.12 346)"],
      slate: ["oklch(71% 0.15 150)", "oklch(66% 0.16 305)", "oklch(79% 0.13 75)", "oklch(67% 0.18 22)", "oklch(76% 0.11 205)", "oklch(78% 0.1 345)"],
      linear: ["oklch(74% 0.16 150)", "oklch(70% 0.15 300)", "oklch(80% 0.14 78)", "oklch(66% 0.2 22)", "oklch(77% 0.12 198)", "oklch(77% 0.13 345)"],
      "github-dimmed": ["#57ab5a", "#986ee2", "#c69026", "#e5534b", "#39c5cf", "#e275ad"],
      nord: ["#a3be8c", "oklch(75% 0.07 333)", "#ebcb8b", "oklch(72% 0.13 18)", "oklch(79% 0.08 188)", "oklch(74% 0.085 285)"],
      "catppuccin-mocha": ["#a6e3a1", "#cba6f7", "#f9e2af", "#f38ba8", "#94e2d5", "oklch(80% 0.1 48)"],
      "tokyo-night": ["#9ece6a", "#bb9af7", "#e0af68", "#f7768e", "#73daca", "oklch(78% 0.1 40)"],
    };
    expect(THEME_PRESETS.map((preset) => preset.id).sort()).toEqual(Object.keys(expected).sort());
    for (const preset of THEME_PRESETS) {
      const p = preset.palette;
      expect(
        [p["--color-running"], p["--color-reviewing"], p["--color-paused"], p["--color-danger"], p["--color-kind-agent"], p["--color-kind-script"]],
        preset.id,
      ).toEqual(expected[preset.id]);
      expect(p["--color-success"], preset.id).toBe(p["--color-running"]);
      expect(p["--color-warning"], preset.id).toBe(p["--color-paused"]);
    }
  });

  it("keeps Slate's status and kind colours in a custom theme", () => {
    for (const seed of [SLATE_LIKE, { ground: { h: 30, c: 0.08 }, accent: { h: 120, c: 0.2 } }]) {
      const palette = paletteFor(seed);
      for (const status of STATUS) expect(palette[status], status).toBe(slate()[status]);
    }
  });

  it("draws every theme's outlines to show against a raised panel", () => {
    const palettes: [string, Palette][] = [
      ...THEME_PRESETS.map((preset): [string, Palette] => [preset.id, preset.palette]),
      ...[0, 90, 180, 270].flatMap((h) => [0, 0.04, 0.08].map((c): [string, Palette] => [`custom h${h} c${c}`, paletteFor({ ground: { h, c }, accent: { h: 258, c: 0.18 } })])),
    ];
    for (const [name, palette] of palettes) {
      const raised = palette["--color-canvas-raised"];
      expect(palette["--color-line"], name).not.toBe(raised);
      const line = contrastRatio(palette["--color-line"], raised);
      const strong = contrastRatio(palette["--color-line-strong"], raised);
      expect(line, name).toBeGreaterThanOrEqual(1.4);
      // The strong line is a real step further, not the same grey twice.
      expect(strong!, name).toBeGreaterThan(line! + 0.3);
    }
    // The two that used to draw their line in the panel's own colour.
    for (const id of ["nord", "catppuccin-mocha"]) {
      const palette = paletteOf({ kind: "preset", id });
      expect(colourAsHex(palette["--color-line"]), id).not.toBe(colourAsHex(palette["--color-canvas-raised"]));
    }
  });

  it("mixes the outlines from the raised surface toward the ink, 14% and 30%, in OKLab", () => {
    // Slate's 14% already clears 1.4:1, so its line is the mix as it stands.
    const lightness = (value: string) => Number(/oklch\(([\d.]+)%/.exec(value)?.[1]);
    expect(lightness(slate()["--color-line"])).toBeCloseTo(28 + (94 - 28) * 0.14, 1);
    expect(lightness(slate()["--color-line-strong"])).toBeCloseTo(28 + (94 - 28) * 0.3, 1);
    // A preset written in hex mixes the same way: its strong line sits 30% up the lightness between them.
    const tokyo = paletteOf({ kind: "preset", id: "tokyo-night" });
    const raised = hexToOklch(tokyo["--color-canvas-raised"])!.l * 100;
    const ink = hexToOklch(tokyo["--color-ink"])!.l * 100;
    expect(lightness(tokyo["--color-line-strong"])).toBeCloseTo(raised + (ink - raised) * 0.3, 0);
    // And its line at least 14% up, further only as far as 1.4:1 needs.
    expect(lightness(tokyo["--color-line"])).toBeGreaterThanOrEqual(raised + (ink - raised) * 0.14 - 0.05);
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
      const colour = (token: string) => palette[token as ThemeToken];
      for (const pair of PAIRS) {
        const ratio = contrastRatio(colour(pair.fg), colour(pair.bg));
        if (ratio === null) failures.push(`${name}: ${pair.fg} on ${pair.bg} could not be measured`);
        else if (ratio < pair.min) failures.push(`${name}: ${pair.fg} on ${pair.bg} is ${ratio.toFixed(2)}, needs ${pair.min}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it("keeps every preset's accent clear of the status and kind colours, but Claude's clay and Nord's frost", () => {
    // Nord's frost accent sits near the agent's hue: a known open point (EO-683).
    const known: Record<string, string> = { claude: "failed", nord: "an agent's step" };
    for (const preset of THEME_PRESETS) {
      const accent = hexToOklch(preset.palette["--color-accent"]);
      if (accent === null) continue;
      expect(statusClash(accent), preset.id).toBe(known[preset.id] ?? null);
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

  it("is named for an agent's step when it is within 35° of the agent hue", () => {
    expect(statusClash({ h: 205, c: 0.17 })).toBe("an agent's step");
    expect(statusClash({ h: 230, c: 0.17 })).toBe("an agent's step");
    expect(statusClash({ h: 241, c: 0.17 })).toBeNull();
  });

  it("is named for a script's step when it is within 35° of the script hue", () => {
    // The script's hue sits between review's and failed's, so the band only it claims is narrow.
    expect(statusClash({ h: 345, c: 0.17 })).toBe("a script's step");
    expect(statusClash({ h: 342, c: 0.17 })).toBe("a script's step");
    expect(statusClash({ h: 345, c: 0.04 })).toBeNull();
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
