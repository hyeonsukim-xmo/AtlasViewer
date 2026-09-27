import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/postcss";
const path = (relative: string) => fileURLToPath(new URL(relative, import.meta.url));
export default defineConfig(({ mode }) => ({
  root: path(mode === "desktop" ? "./desktop/ui" : "./web"),
  publicDir: path("./public"),
  plugins: [react()],
  resolve: { alias: { "@": path("./") } },
  css: { postcss: { plugins: [tailwindcss()] } },
  server: { watch: { usePolling: true } },
  build: { outDir: path(mode === "desktop" ? "./dist-desktop" : "./dist"), emptyOutDir: true },
}));
