import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Dev: the Worker (wrangler dev, port 8787) owns /api and /auth, including the room WebSocket.
const worker = "http://localhost:8787";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": { target: worker, ws: true },
      "/auth": { target: worker },
    },
  },
});
