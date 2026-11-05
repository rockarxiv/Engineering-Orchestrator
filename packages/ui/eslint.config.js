import { withForbiddenImports, withTypeAwareRules } from "@eo/eslint-config";

// packages/ui must stay renderable in a plain browser (U-01), so it may
// not reach for Electron or Node. The purity test checks the same thing
// against the built source; this catches it while you type.
const config = withForbiddenImports(["electron", "@eo/core", "@eo/engine"]);

export default [
  ...config,
  withTypeAwareRules({ project: ["./tsconfig.json"], tsconfigRootDir: import.meta.dirname, files: ["src/**/*.{ts,tsx}"] }),
  {
    // The purity test reads the source tree from disk, so it is the one
    // file that legitimately needs Node.
    files: ["src/purity.test.ts"],
    rules: { "no-restricted-imports": "off" },
  },
];
