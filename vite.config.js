import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The website runs at http://localhost:5173
// Any request it makes to /api/... is forwarded to the waiter (default :3013;
// override with the API_PORT env var to match server PORT).
const API_PORT = process.env.API_PORT || process.env.PORT || 7001;
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { "/api": `http://localhost:${API_PORT}` },
  },
  // Strip console.log/info/debug from production bundles (keep warn/error).
  esbuild: { pure: ["console.log", "console.info", "console.debug"] },
  build: {
    // Split the heavy vendor libraries into their own cached chunks so they
    // download in parallel and stay cached across deploys, and so a page that
    // doesn't use a library never pays for it. Pages themselves are lazy-loaded
    // (see App.jsx), so each becomes its own chunk automatically.
    rollupOptions: {
      output: {
        manualChunks: {
          react: ["react", "react-dom"],
          echarts: ["echarts", "echarts-for-react"],
          aggrid: ["ag-grid-community", "ag-grid-react"],
          motion: ["framer-motion"],
          icons: ["lucide-react"],
        },
      },
    },
    chunkSizeWarningLimit: 900,
  },
});
