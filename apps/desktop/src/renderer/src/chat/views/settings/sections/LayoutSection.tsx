import { useEffect, useState } from "react";
import { Check } from "lucide-react";
import { cn } from "@eo/ui";
import { Button, CardSection } from "../../../kit";
import {
  DEFAULT_PRESET_ID,
  THEME_PRESETS,
  hexForSeed,
  paletteOf,
  seedFromHex,
  seedOf,
  setThemeChoice,
  statusClash,
  useThemeChoice,
  type Palette,
  type ThemeSeed,
} from "../../../theme";
import { Note } from "../core/fields";

/**
 * Settings → Colours: how the window is coloured, applied the moment it
 * is chosen and remembered on this device (`theme.ts` says why it is not
 * a setting on the record). At `?section=layout`, the address it has
 * always had, so a link to it from before the layout choice went still
 * opens here.
 */
export function LayoutSection() {
  return <ColoursCard />;
}

/**
 * The colours: presets drawn as small windows of their
 * own, a theme of one's own from two pickers, and a way back to the
 * default. The status colours are the one part of the palette that
 * carries meaning, so they are the one part a theme never touches.
 */
function ColoursCard() {
  const choice = useThemeChoice();
  const seed = seedOf(choice);
  // Only an accent somebody picked is checked: the presets' were each
  // tuned against the status colours, and a custom background picked over
  // a preset keeps that preset's accent.
  const clash = choice.kind === "custom" && !isPresetAccent(seed.accent) ? statusClash(seed.accent) : null;
  // The last theme made here, so trying a preset is not the end of it:
  // the Custom swatch brings it back.
  const [lastCustom, setLastCustom] = useState<ThemeSeed | null>(choice.kind === "custom" ? choice.seed : null);
  useEffect(() => {
    if (choice.kind === "custom") setLastCustom(choice.seed);
  }, [choice]);
  const defaultName = THEME_PRESETS.find((preset) => preset.id === DEFAULT_PRESET_ID)?.name ?? DEFAULT_PRESET_ID;

  const pick = (part: "ground" | "accent", hex: string) => {
    const half = seedFromHex(hex, part);
    if (half === null) return;
    setThemeChoice({ kind: "custom", seed: { ...seed, [part]: half } });
  };

  return (
    <CardSection
      title="Colours"
      description="How the window is coloured, on this device. Running, waiting and failed keep their colours in every theme, so they always mean the same thing."
    >
      <div role="group" aria-label="Colour themes" className="grid grid-cols-[repeat(auto-fill,minmax(8rem,1fr))] gap-2">
        {THEME_PRESETS.map((preset) => (
          <ThemeSwatch
            key={preset.id}
            name={preset.name}
            palette={preset.palette}
            selected={choice.kind === "preset" && choice.id === preset.id}
            onSelect={() => setThemeChoice({ kind: "preset", id: preset.id })}
          />
        ))}
        {lastCustom ? (
          <ThemeSwatch
            name="Custom"
            palette={paletteOf({ kind: "custom", seed: lastCustom })}
            selected={choice.kind === "custom"}
            onSelect={() => setThemeChoice({ kind: "custom", seed: lastCustom })}
          />
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
        <ColourField label="Background" part="ground" seed={seed.ground} onPick={(hex) => pick("ground", hex)} />
        <ColourField label="Accent" part="accent" seed={seed.accent} onPick={(hex) => pick("accent", hex)} />
        {choice.kind === "preset" && choice.id === DEFAULT_PRESET_ID ? null : (
          <Button variant="ghost" size="sm" onClick={() => setThemeChoice({ kind: "preset", id: DEFAULT_PRESET_ID })}>
            Reset to {defaultName}
          </Button>
        )}
      </div>
      <Note>
        Pick any colour: the layout holds its text to the same contrast as the presets, lightening a shade or darkening a button where it has to.
      </Note>
      {clash ? (
        <p role="status" className="rounded-[12px] bg-paused/15 px-3.5 py-2.5 text-[12.5px] leading-relaxed text-ink">
          This accent is close to the colour that means {clash}, so a button can be mistaken for a status. A hue further round the wheel keeps them apart.
        </p>
      ) : null}
    </CardSection>
  );
}

/** A theme drawn as a small window of its own: the rail, the room, a reply and an action. */
function ThemeSwatch({ name, palette, selected, onSelect }: { name: string; palette: Palette; selected: boolean; onSelect: () => void }) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onSelect}
      className={cn(
        "flex min-w-0 flex-col gap-1.5 rounded-[12px] p-1.5 text-left outline-offset-0",
        selected ? "bg-canvas-raised outline outline-[1.5px] outline-accent" : "hover:bg-canvas-subtle",
      )}
    >
      <span aria-hidden className="flex h-14 overflow-hidden rounded-[9px]" style={{ background: palette["--color-canvas"], border: `1px solid ${palette["--color-line"]}` }}>
        <span className="w-4 shrink-0" style={{ background: palette["--chat-deep"] }} />
        <span className="flex flex-1 flex-col justify-end gap-1 p-1.5">
          <span className="h-1.5 w-3/4 rounded-full" style={{ background: palette["--color-canvas-active"] }} />
          <span className="h-1.5 w-1/2 rounded-full" style={{ background: palette["--color-canvas-raised"] }} />
          <span className="h-2.5 w-8 self-end rounded-full" style={{ background: palette["--color-accent"] }} />
        </span>
      </span>
      <span className="flex items-center gap-1 px-0.5 text-[12.5px] text-ink">
        <span className="min-w-0 flex-1 truncate">{name}</span>
        {selected ? <Check aria-hidden size={13} className="shrink-0 text-accent-soft" /> : null}
      </span>
    </button>
  );
}

/**
 * A native colour picker over one half of the seed. What a person drags
 * to is kept as they picked it while it still stands for the seed in use:
 * showing it back at the palette's own lightness would move the thumb out
 * from under their pointer mid-drag.
 */
function ColourField({ label, part, seed, onPick }: { label: string; part: "ground" | "accent"; seed: { h: number; c: number }; onPick: (hex: string) => void }) {
  const [picked, setPicked] = useState<string | null>(null);
  const fromPicked = picked === null ? null : seedFromHex(picked, part);
  const value = picked !== null && fromPicked !== null && sameHalf(fromPicked, seed) ? picked : hexForSeed(part, seed);
  return (
    <label className="flex items-center gap-2 text-[12.5px] text-ink-muted">
      <input
        type="color"
        aria-label={label}
        value={value}
        onChange={(event) => {
          setPicked(event.target.value);
          onPick(event.target.value);
        }}
        className="h-7 w-9 cursor-pointer rounded-[8px] border-0 bg-canvas-raised p-0.5"
      />
      {label}
    </label>
  );
}

function sameHalf(a: { h: number; c: number }, b: { h: number; c: number }): boolean {
  return Math.abs(a.h - b.h) < 0.01 && Math.abs(a.c - b.c) < 0.0001;
}

/** Whether an accent is one a preset already has: what a custom background picked over that preset carries. */
function isPresetAccent(accent: ThemeSeed["accent"]): boolean {
  return THEME_PRESETS.some((preset) => sameHalf(seedOf({ kind: "preset", id: preset.id }).accent, accent));
}
