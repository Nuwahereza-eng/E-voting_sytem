import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

// Vite config for the Sauti web frontend. We polyfill `global` and
// `Buffer` because @stellar/stellar-sdk expects them in the browser.
export default defineConfig({
  plugins: [react()],
  server: {
    // Dedicated port for Sauti so it never collides with other projects
    // that use Vite's default 5173. `strictPort` makes startup fail loudly
    // instead of silently hopping to another port.
    port: 5273,
    strictPort: true,
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
      // Matches tsconfig `paths` — lets components import primitives as
      // `@/components/ui/button` regardless of how deep they live.
      "@": path.resolve(__dirname, "src"),
    },
  },
  optimizeDeps: {
    include: ["buffer"],
  },
});
