import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
  },
  preload: {
    // Electron's sandboxed preload loader can only require() a small
    // built-in allowlist — it can't resolve external packages at all, so
    // anything the preload actually imports has to be bundled in.
    //
    // zod is here because @eo/core imports it: the moment zod became a
    // direct dependency of this app, externalizeDepsPlugin started
    // leaving it out, and the preload failed at runtime with "module not
    // found: zod" — taking window.eo, and so the whole renderer, with it.
    // Anything @eo/core gains a dependency on has to be added here too.
    plugins: [externalizeDepsPlugin({ exclude: ["@eo/core", "zod"] })],
    build: {
      // Electron's sandboxed preload loader (sandbox: true, required by
      // this app) cannot execute ES modules — force CJS output even though
      // this package is "type": "module".
      rollupOptions: {
        output: {
          format: "cjs",
          entryFileNames: "[name].js",
        },
      },
    },
  },
  renderer: {
    plugins: [react(), tailwindcss()],
  },
});
