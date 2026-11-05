import { withForbiddenImports, withTypeAwareRules } from "@eo/eslint-config";

// packages/engine must stay pure: no Node, no Electron, no DB access.
// Data in, data out. See ARCHITECTURE.md, "`packages/engine` is pure".
export default [
  ...withForbiddenImports(["node:*", "electron", "better-sqlite3"]),
  withTypeAwareRules({ project: ["./tsconfig.json"], tsconfigRootDir: import.meta.dirname, files: ["src/**/*.ts"] }),
  {
    // The domain-neutrality scan reads this package's own source tree
    // from disk, so it is the one file that legitimately needs Node —
    // the same exception, for the same reason, that `packages/ui` makes
    // for its purity test. `tsconfig.build.json` excludes `*.test.ts`,
    // so nothing Node-shaped reaches `dist/`.
    files: ["src/domainNeutrality.test.ts"],
    rules: { "no-restricted-imports": "off" },
  },
];
