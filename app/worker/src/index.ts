import { PROTOCOL_VERSION } from "@moneygame/shared";

// Minimal Worker entry. Durable Objects, auth, and realtime are later tasks
// (SPIKE-001+); this only proves the worker builds and shares the protocol
// definition with the client.
export default {
  fetch(): Response {
    return Response.json({ protocolVersion: PROTOCOL_VERSION });
  },
} satisfies ExportedHandler;
