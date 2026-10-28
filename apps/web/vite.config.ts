import { resolve } from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: { proxy: { "/api": { target: process.env.API_PROXY || "http://localhost:3001", changeOrigin: true } } },
  build: { rollupOptions: { input: {
    main: resolve(import.meta.dirname, "index.html"),
    admin: resolve(import.meta.dirname, "admin.html"),
    agent: resolve(import.meta.dirname, "agent.html")
  } } }
});
