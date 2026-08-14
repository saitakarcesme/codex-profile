import { defineConfig } from "vite";
import { resolve } from "node:path";

export default defineConfig({
  root: "ui",
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  build: {
    outDir: "../dist",
    emptyOutDir: true,
    target: ["es2021", "chrome105", "safari13"],
    minify: "esbuild",
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, "ui/index.html"),
        launcher: resolve(import.meta.dirname, "ui/launcher.html"),
      },
    },
  },
});
