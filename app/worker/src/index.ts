import { PROTOCOL_VERSION } from "@moneygame/shared";
import { SpikeRoom } from "./room";
import { AuthStore } from "./auth-do";
import type {
  ConsumeResult,
  OAuthTransaction,
  TransactionStore,
} from "./auth-store";
import { createGoogleProvider } from "./oidc";
import { handleCallback, startAuth, type FlowDeps } from "./auth-flow";
import { parseCookies, verifySession, SESSION_COOKIE } from "./session";

/** Internal header carrying the Worker-verified userId to the DO. Set only by
 *  the Worker from the session; any client-supplied value is overwritten. */
const USER_HEADER = "x-mg-user";

// DO classes must be exported from the Worker entry module.
export { SpikeRoom, AuthStore };

const SESSION_TTL_SEC = 7 * 24 * 60 * 60; // app session outlives the 90s room lease
const TXN_TTL_SEC = 10 * 60; // OAuth transaction validity

// Adapts the AuthStore Durable Object's RPC methods to the flow's store seam.
function doStore(env: Env): TransactionStore {
  const stub = env.AUTH_STORE.getByName("global");
  return {
    create: (txn: OAuthTransaction): Promise<void> => stub.createTxn(txn),
    consume: (
      state: string,
      bindingHash: string,
      now: number,
    ): Promise<ConsumeResult> => stub.consumeTxn(state, bindingHash, now),
  };
}

function flowDeps(env: Env): FlowDeps {
  return {
    store: doStore(env),
    google: createGoogleProvider(env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET),
    clientId: env.GOOGLE_CLIENT_ID,
    sessionSecret: env.SESSION_SECRET,
    now: () => Date.now(),
    sessionTtlSec: SESSION_TTL_SEC,
    txnTtlSec: TXN_TTL_SEC,
  };
}

// Worker routing:
//   ws upgrade        -> SPIKE-001 room Durable Object
//   /r/:roomCode      -> SPIKE-003 invite-first auth (start / session skip)
//   /auth/callback    -> SPIKE-003 OAuth callback
//   /                 -> health
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.headers.get("Upgrade") === "websocket") {
      // SPIKE-004: the game socket is authenticated. Derive the trusted userId
      // from the verified first-party session server-side — never from a
      // query-string/body userId or IP. Google tokens never reach the DO.
      const token = parseCookies(request.headers.get("Cookie"))[SESSION_COOKIE];
      if (token === undefined) {
        return new Response("authentication required", { status: 401 });
      }
      let userId: string;
      try {
        userId = (await verifySession(token, env.SESSION_SECRET, Date.now())).sub;
      } catch {
        return new Response("authentication required", { status: 401 });
      }
      const room = new URL(request.url).searchParams.get("room") ?? "spike";
      // Overwrite any client-supplied header so identity cannot be spoofed; the
      // DO is only reachable through this authenticated Worker path.
      const headers = new Headers(request.headers);
      headers.set(USER_HEADER, userId);
      return env.SPIKE_ROOM.getByName(room).fetch(
        new Request(request, { headers }),
      );
    }

    const url = new URL(request.url);
    const cookies = request.headers.get("Cookie");

    if (url.pathname === "/auth/callback") {
      return handleCallback(url, cookies, url.origin, flowDeps(env));
    }

    const room = url.pathname.match(/^\/r\/([^/]+)\/?$/);
    if (room !== null) {
      return startAuth(
        decodeURIComponent(room[1] as string),
        cookies,
        url.origin,
        flowDeps(env),
      );
    }

    return Response.json({ ok: true, protocolVersion: PROTOCOL_VERSION });
  },
} satisfies ExportedHandler<Env>;
