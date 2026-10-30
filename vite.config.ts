import { copyFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { transformSync } from "esbuild";
import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

function copyExtensionStatic() {
  return {
    name: "copy-extension-static",
    closeBundle() {
      const dist = resolve(__dirname, "dist");
      mkdirSync(dist, { recursive: true });
      copyFileSync(resolve(__dirname, "manifest.json"), resolve(dist, "manifest.json"));
      const contentTarget = resolve(dist, "src/content");
      mkdirSync(contentTarget, { recursive: true });
      // Registered content scripts are classic scripts; keep this small entry free of ESM imports.
      const monitor = readFileSync(resolve(__dirname, "src/content/workProtectionMonitor.ts"), "utf8");
      writeFileSync(resolve(contentTarget, "workProtection.js"), transformSync(
        monitor + "\ninstallWorkProtectionMonitor();", { loader: "ts", format: "iife", target: "chrome132", minify: true }
      ).code);
      const licenseTarget = resolve(dist, "licenses");
      mkdirSync(licenseTarget, { recursive: true });
      copyFileSync(resolve(__dirname, "src/shared/fonts/Archivo-OFL.txt"), resolve(licenseTarget, "Archivo-OFL.txt"));
      // MIT asks that its notice travel with every copy, including the store package.
      copyFileSync(resolve(__dirname, "LICENSE"), resolve(licenseTarget, "Coppice-LICENSE.txt"));

      const iconSource = resolve(__dirname, "icons");
      const iconTarget = resolve(dist, "icons");
      rmSync(iconTarget, { recursive: true, force: true });
      mkdirSync(iconTarget, { recursive: true });
      for (const entry of readdirSync(iconSource, { withFileTypes: true })) {
        if (!entry.isFile()) {
          continue;
        }
        copyFileSync(resolve(iconSource, entry.name), resolve(iconTarget, entry.name));
      }
    }
  };
}

export default defineConfig(({ mode }) => ({
  plugins: [copyExtensionStatic()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: mode !== "release",
    // Chromium extension pages load their module graph from the extension
    // world. Vite's HTML modulepreload hints are ignored there and produce
    // noisy cross-world resource warnings without improving startup.
    modulePreload: false,
    rollupOptions: {
      input: {
        background: resolve(__dirname, "src/background/index.ts"),
        offscreen: resolve(__dirname, "src/offscreen/offscreen.html"),
        popup: resolve(__dirname, "src/popup/popup.html"),
        options: resolve(__dirname, "src/options/options.html")
      },
      output: {
        entryFileNames(chunk) {
          if (chunk.name === "background") {
            return "src/background/index.js";
          }
          return "assets/[name]-[hash].js";
        },
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]"
      }
    }
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"]
  }
}));
