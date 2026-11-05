import js from "@eslint/js";
import tseslint from "typescript-eslint";

export const base = tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
      },
    },
    rules: {
      // An error, not a warning. A warning is a rule nobody has to act on,
      // and the suite ran clean under it — so this costs nothing today and
      // stops an unused binding arriving quietly tomorrow.
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
  {
    ignores: ["dist/**", "out/**", "release/**", "node_modules/**"],
  },
);

// Forbids importing the given module specifiers (supports gitignore-style
// globs, e.g. "node:*"). Used to enforce purity — see packages/engine.
export function withForbiddenImports(specifiers) {
  return [
    ...base,
    {
      rules: {
        "no-restricted-imports": [
          "error",
          {
            patterns: specifiers.map((specifier) => ({
              group: [specifier],
              message: `"${specifier}" is forbidden here — this package must stay pure (no Node/Electron/DB imports).`,
            })),
          },
        ],
      },
    },
  ];
}

/**
 * The rules that need the type-checker, for the files a tsconfig covers.
 *
 * `no-floating-promises` is the one that pays for itself: a promise
 * dropped on the floor in the main process is an unhandled rejection
 * that takes nothing down and tells nobody, which is the exact shape of
 * "the run finished and the comment never posted". The other two are
 * its neighbours — a promise handed to a callback that wanted a value,
 * and an `await` of something that was never going to wait.
 *
 * Type-aware, so it costs a type-check per lint. That is the trade: the
 * suite ran clean under the ordinary rules and still carried six of
 * these, because a floating promise is not a syntax error.
 *
 * `project` is one or more tsconfig paths relative to `tsconfigRootDir`;
 * `files` narrows which sources those projects apply to, because a
 * desktop app has three tsconfigs for three trees and a file must be
 * linted against the one that actually includes it.
 */
export function withTypeAwareRules({ project, tsconfigRootDir, files, ignores = [] }) {
  return {
    files,
    ignores: ["**/*.d.ts", ...ignores],
    languageOptions: { parserOptions: { project, tsconfigRootDir } },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/await-thenable": "error",
    },
  };
}
