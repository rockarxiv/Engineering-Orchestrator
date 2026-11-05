import { withForbiddenImports, withTypeAwareRules } from "@eo/eslint-config";

// packages/core is the shared vocabulary, and it stays reachable from
// everywhere by never reaching for a platform: no Node, no Electron, no
// DB. That was true by habit until EO-105 put slug allocation here on
// the strength of it — "a package that imports no `node:*` module" is
// only a property worth relying on if something checks.
export default [...withForbiddenImports(["node:*", "electron", "better-sqlite3"]), withTypeAwareRules({ project: ["./tsconfig.json"], tsconfigRootDir: import.meta.dirname, files: ["src/**/*.ts"] })];
