import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const appDir = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  plugins: [react()],
  server: { proxy: { "/api": { target: process.env.API_PROXY || "http://localhost:3001", changeOrigin: true } } },
  build: { rollupOptions: { input: {
    main: resolve(appDir, "index.html"),
    admin: resolve(appDir, "admin.html"),
    agent: resolve(appDir, "agent.html"),
    leadscout: resolve(appDir, "leadscout.html")
  } } }
});
