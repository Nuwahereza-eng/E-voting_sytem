import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Vite config for the Sauti web frontend. We polyfill `global` and
// `Buffer` because @stellar/stellar-sdk expects them in the browser.
export default defineConfig({
  plugins: [react()],
  server: {
    // Use polling to avoid ENOSPC on machines with a low
    // `fs.inotify.max_user_watches`. Slightly higher CPU, much less pain.
    watch: {
      usePolling: true,
      interval: 300,
    },
  },
  define: {
    global: "globalThis",
  },
  resolve: {
    alias: {
      buffer: "buffer/",
    },
  },
  optimizeDeps: {
    include: ["buffer"],
  },
});
