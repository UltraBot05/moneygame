// SPIKE-001 evidence harness. Uses Node's built-in WebSocket (Node >= 22), so
// no dependency is added. Run against `wrangler dev` or a deployed URL.
//
//   node scripts/spike-client.mjs [wsBase] [mode] [expVersion] [expValue]
//     wsBase     : ws://127.0.0.1:8787 (default) or wss://<deployment>
//     mode       : "full" (default) 10-client convergence + alarm
//                  "read"           1 client, ASSERTS committed state
//     expVersion : (read mode) expected gameVersion; asserted
//     expValue   : (read mode) expected value; asserted
//
// Exit code 0 = checks passed, 1 = failed.

const wsBase = process.argv[2] ?? "ws://127.0.0.1:8787";
const mode = process.argv[3] ?? "full";
const room = process.env.ROOM ?? "spike";
const url = `${wsBase}/?room=${room}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function connect(id) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const state = { id, ws, last: null };
    ws.addEventListener("message", (e) => {
      const msg = JSON.parse(e.data);
      if (msg.type === "STATE") state.last = msg;
    });
    ws.addEventListener("open", () => resolve(state));
    ws.addEventListener("error", () => reject(new Error(`client ${id} ws error`)));
  });
}

// One-shot request for the DO's billed SQL counters (rowsRead/rowsWritten/setAlarm).
function getMetrics(client) {
  return new Promise((resolve) => {
    const handler = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.type === "METRICS") {
        client.ws.removeEventListener("message", handler);
        resolve(msg);
      }
    };
    client.ws.addEventListener("message", handler);
    client.ws.send(JSON.stringify({ type: "GET_METRICS" }));
  });
}

if (mode === "stress") {
  // Measures real cursor.rowsRead for deadline queries with a mix of resolved
  // (history) and pending rows. Usage: ... stress [resolved] [pending]
  const resolved = Number(process.argv[4] ?? 295);
  const pending = Number(process.argv[5] ?? 5);
  const c = await connect(0);
  const result = await new Promise((resolve) => {
    const handler = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.type === "STRESS") {
        c.ws.removeEventListener("message", handler);
        resolve(msg);
      }
    };
    c.ws.addEventListener("message", handler);
    c.ws.send(JSON.stringify({ type: "DEADLINE_STRESS", resolved, pending }));
  });
  c.ws.close();
  console.log(JSON.stringify(result));
  process.exit(0);
}

if (mode === "read") {
  const expVersion = Number(process.argv[4]);
  const expValue = Number(process.argv[5]);
  if (!Number.isFinite(expVersion) || !Number.isFinite(expValue)) {
    console.error("read mode requires expected gameVersion and value arguments");
    process.exit(2);
  }
  const c = await connect(0);
  c.ws.send(JSON.stringify({ type: "GET_STATE" }));
  await sleep(800);
  c.ws.close();

  const observedVersion = c.last?.gameVersion;
  const observedValue = c.last?.value;
  console.log(`expected gameVersion = ${expVersion}`);
  console.log(`expected value = ${expValue}`);
  console.log(`observed gameVersion = ${observedVersion}`);
  console.log(`observed value = ${observedValue}`);

  const pass =
    observedVersion === expVersion && observedValue === expValue;
  console.log(pass ? "RECONSTRUCTION_PASS" : "RECONSTRUCTION_FAIL");
  process.exit(pass ? 0 : 1);
}

const N = 10;
const clients = [];
for (let i = 0; i < N; i++) clients.push(await connect(i));
await sleep(500); // receive initial STATE on connect

const versionsAt = () => clients.map((c) => c.last?.gameVersion);
const valuesAt = () => clients.map((c) => c.last?.value);

console.log(`connected=${clients.length} initialVersions=${JSON.stringify(versionsAt())}`);
const m0 = await getMetrics(clients[0]);
console.log(`metricsBASELINE ${JSON.stringify(m0)}`);

// (2)(3) one client sends an authoritative command; version/state commits.
clients[0].ws.send(JSON.stringify({ type: "INCREMENT" }));
await sleep(600);
const vInc = versionsAt();
const valInc = valuesAt();
const convergedInc = new Set(vInc).size === 1 && new Set(valInc).size === 1;
console.log(`afterINCREMENT versions=${JSON.stringify(vInc)} converged=${convergedInc}`);
const m1 = await getMetrics(clients[0]);
console.log(
  `deltaINCREMENT rowsRead=${m1.rowsRead - m0.rowsRead} rowsWritten=${m1.rowsWritten - m0.rowsWritten}`,
);

// (7) persisted deadline resolved via the Alarm API; all converge again.
const expected = vInc[0] + 1;
clients[0].ws.send(JSON.stringify({ type: "SET_DEADLINE", ms: 1500 }));
await sleep(3000);
const vAlarm = versionsAt();
const convergedAlarm = new Set(vAlarm).size === 1 && vAlarm[0] === expected;
console.log(
  `afterALARM versions=${JSON.stringify(vAlarm)} converged=${convergedAlarm} expected=${expected}`,
);
const m2 = await getMetrics(clients[0]);
console.log(
  `deltaDEADLINE+ALARM rowsRead=${m2.rowsRead - m1.rowsRead} rowsWritten=${m2.rowsWritten - m1.rowsWritten} setAlarmCount=${m2.setAlarmCount - m0.setAlarmCount}`,
);
console.log(`metricsFINAL ${JSON.stringify(m2)}`);

for (const c of clients) c.ws.close();
const pass = convergedInc && convergedAlarm;
console.log(pass ? "FUNCTIONAL_PASS" : "FUNCTIONAL_FAIL");
process.exit(pass ? 0 : 1);
