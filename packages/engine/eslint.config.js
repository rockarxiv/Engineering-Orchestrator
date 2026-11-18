import { withForbiddenImports, withTypeAwareRules } from "@eo/eslint-config";

// packages/engine must stay pure: no Node, no Electron, no DB access.
// Data in, data out. See ARCHITECTURE.md, "`packages/engine` is pure".
export default [
  ...withForbiddenImports(["node:*", "electron", "better-sqlite3"]),
  withTypeAwareRules({ project: ["./tsconfig.json"], tsconfigRootDir: import.meta.dirname, files: ["src/**/*.ts"] }),
  {
    // The domain-neutrality scan reads this package's own source tree
    // from disk, so it legitimately needs Node —
    // the same exception, for the same reason, that `packages/ui` makes
    // for its purity test. `tsconfig.build.json` excludes `*.test.ts`,
    // so nothing Node-shaped reaches `dist/`.
    //
    // `teamExamples.test.ts` (EO-850) reads the team example a person
    // imports from `docs/examples/teams/`, so the pure engine is tested
    // against the very file the documentation offers, not a copy of it.
    files: ["src/domainNeutrality.test.ts", "src/teamExamples.test.ts"],
    rules: { "no-restricted-imports": "off" },
  },
];
