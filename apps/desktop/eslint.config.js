import { base, withTypeAwareRules } from "@eo/eslint-config";

const here = import.meta.dirname;

export default [
  ...base,
  // One entry per tree, because a file is type-checked against the
  // tsconfig that includes it and nothing else.
  withTypeAwareRules({ project: ["./tsconfig.node.json"], tsconfigRootDir: here, files: ["src/main/**/*.ts"] }),
  withTypeAwareRules({ project: ["./tsconfig.preload.json"], tsconfigRootDir: here, files: ["src/preload/**/*.ts"] }),
  withTypeAwareRules({ project: ["./tsconfig.web.json"], tsconfigRootDir: here, files: ["src/renderer/**/*.{ts,tsx}"] }),
  // The Playwright specs are the classic home of an un-awaited
  // `expect(page…)`, and they lived in no tsconfig at all. This one
  // exists so the rule can reach them; `pnpm typecheck` does not run it,
  // because the specs are checked by running them.
  withTypeAwareRules({ project: ["./tsconfig.e2e.json"], tsconfigRootDir: here, files: ["e2e/**/*.ts", "playwright.config.ts"] }),
  {
    // Renderer code must go through the preload bridge (window.eo) — never
    // import electron directly. See F-04 acceptance criteria.
    files: ["src/renderer/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["electron", "electron/*"],
              message: "Renderer code must not import electron directly — use window.eo (the preload bridge) instead.",
            },
          ],
        },
      ],
    },
  },
];
