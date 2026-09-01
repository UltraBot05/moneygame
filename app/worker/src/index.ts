import { PROTOCOL_VERSION } from "@moneygame/shared";
import { SpikeRoom } from "./room";

// The DO class must be exported from the Worker entry module.
export { SpikeRoom };

// SPIKE-001 Worker: routes a WebSocket upgrade to one room Durable Object.
// Durable Objects, auth and realtime for the real game arrive in RT-* tasks.
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.headers.get("Upgrade") === "websocket") {
      const room = new URL(request.url).searchParams.get("room") ?? "spike";
      return env.SPIKE_ROOM.getByName(room).fetch(request);
    }
    // Health endpoint (no DO involved) — confirms the Worker is up.
    return Response.json({ ok: true, protocolVersion: PROTOCOL_VERSION });
  },
} satisfies ExportedHandler<Env>;
