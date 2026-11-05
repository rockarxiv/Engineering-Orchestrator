import { defineConfig } from "vite";

/**
 * The organisation server's bundle (EO-319, `ARCHITECTURE.md`,
 * "The server").
 *
 * Its own config rather than a fourth entry in electron.vite.config.ts,
 * because electron-vite knows three targets — main, preload, renderer —
 * and this is none of them: it is a plain Node program that happens to
 * be built from the same source tree. Nothing about the desktop build
 * changes, which is this story's third acceptance criterion.
 *
 * `ssr` is what makes it a Node bundle: ES output, Node's own module
 * resolution, and every dependency left external — which is what
 * `better-sqlite3` and `node-pty` require (they are native, and a
 * bundler cannot inline a `.node`), and what the desktop's main bundle
 * already does through `externalizeDepsPlugin`. So the artefact is one
 * file plus the `node_modules` it was built beside, exactly like
 * `out/main/index.js`.
 *
 * Deliberately *not* chained onto `pnpm build`. A failure here must not
 * be able to stop a desktop release, and the desktop is what `build`
 * means today. Run it with `pnpm --filter @eo/desktop build:server`
 * after `pnpm build`, and the server with `pnpm --filter @eo/desktop
 * start:server` — see `src/main/server/config.ts` for the environment it
 * wants, and `src/main/server/launch.test.ts` for why that script is not
 * called `server`.
 */
export default defineConfig({
  build: {
    // Beside `out/main`, which is where `serverResources` looks for the
    // source tree when nothing tells it otherwise.
    outDir: "out/server",
    emptyOutDir: true,
    target: "node22",
    ssr: "src/main/server/index.ts",
    rollupOptions: {
      output: { entryFileNames: "index.js", format: "es" },
    },
  },
});
