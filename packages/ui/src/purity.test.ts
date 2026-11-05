import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const srcDir = dirname(fileURLToPath(import.meta.url));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(entry) && !entry.endsWith(".test.ts") && !entry.endsWith(".test.tsx") ? [path] : [];
  });
}

// U-01: "packages/ui has zero Electron imports (it must stay renderable
// in a browser for the web-later option)". Checked rather than trusted —
// the import that breaks this will be added casually, by someone reaching
// for `app.getPath` in a component, and nothing else would catch it.
const FORBIDDEN = [/from\s+["']electron["']/, /require\(["']electron["']\)/, /from\s+["']node:/, /from\s+["']@eo\/(core|engine)["']/];

/**
 * Tailwind v4 dropped v3's `bg-[--var]` form for referencing a CSS
 * variable. The class is still emitted, it just resolves to nothing — so
 * the failure looks like a design mistake rather than a syntax one, and
 * it took a computed-style check in a running window to notice. Colours
 * belong in @theme, which generates real utilities.
 */
const TAILWIND_V3_VAR_SYNTAX = /(?:bg|text|border|shadow|fill|stroke|ring)-\[--/;

describe("styling uses Tailwind v4 syntax", () => {
  it.each(sourceFiles(srcDir).map((file) => [file.slice(srcDir.length + 1), file]))("%s uses theme tokens, not bg-[--var]", (_name, file) => {
    expect(readFileSync(file, "utf8")).not.toMatch(TAILWIND_V3_VAR_SYNTAX);
  });
});

describe("packages/ui stays browser-renderable", () => {
  const files = sourceFiles(srcDir);

  it("finds source files to check", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files.map((file) => [file.slice(srcDir.length + 1), file]))("%s imports nothing Electron- or Node-only", (_name, file) => {
    const source = readFileSync(file, "utf8");
    for (const pattern of FORBIDDEN) {
      expect(source, `${file} matches ${pattern}`).not.toMatch(pattern);
    }
  });
});
