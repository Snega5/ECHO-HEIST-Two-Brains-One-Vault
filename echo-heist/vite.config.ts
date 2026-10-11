import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
const target = "http://localhost:8787";
export default defineConfig({
  root: "web",
  plugins: [react()],
  build: { outDir: "../dist", emptyOutDir: true },
  server: { host: true, proxy: { "/api": target, "/ws": { target, ws: true } } },
});
