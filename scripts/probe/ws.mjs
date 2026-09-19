const [port, token, protocol, opsRaw] = process.argv.slice(2);
if (!port || !token || !protocol || !opsRaw) {
  console.error("usage: ws.mjs <port> <token> <protocol> <ops-json>");
  process.exit(2);
}
const ops = JSON.parse(opsRaw);

const FRAME_STDIN = 2;
const stdinFrame = (session, text) => {
  const payload = new TextEncoder().encode(text);
  const buf = new Uint8Array(5 + payload.length);
  buf[0] = FRAME_STDIN;
  new DataView(buf.buffer).setUint32(1, session, false);
  buf.set(payload, 5);
  return buf;
};

const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
ws.binaryType = "arraybuffer";

let waiter = null;
const waitFor = (match, timeoutMs = 20000) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      waiter = null;
      reject(new Error(`timed out waiting for ${match}`));
    }, timeoutMs);
    waiter = (msg) => {
      if (!match(msg)) return false;
      clearTimeout(timer);
      waiter = null;
      resolve(msg);
      return true;
    };
  });

ws.onmessage = (ev) => {
  if (typeof ev.data !== "string") return;
  let msg;
  try {
    msg = JSON.parse(ev.data);
  } catch {
    return;
  }
  if (msg.type === "error") console.error(`[ws] daemon error: ${msg.message}`);
  if (waiter) waiter(msg);
};

const send = (msg) => ws.send(JSON.stringify(msg));

ws.onopen = async () => {
  try {
    send({ type: "hello", token, protocol: Number(protocol) });
    await waitFor((m) => m.type === "hello_ok");
    for (const op of ops) {
      switch (op.op) {
        case "workspace_add":
          send({ type: "workspace_add", path: op.path });
          await waitFor((m) => m.type === "workspace_list");
          console.log(JSON.stringify({ workspace_add: op.path }));
          break;
        case "consent":
          send({
            type: "orchestration_settings_set",
            workspace: op.workspace,
            enabled: op.enabled !== false,
          });
          await waitFor((m) => m.type === "orchestration_state");
          console.log(JSON.stringify({ consent: op.workspace }));
          break;
        case "create": {
          const created = waitFor((m) => m.type === "session_created");
          send({
            type: "session_create",
            agent: op.agent,
            project_dir: op.project_dir,
            cmd: op.cmd ?? null,
            cols: op.cols ?? 120,
            rows: op.rows ?? 40,
          });
          const msg = await created;
          console.log(JSON.stringify({ created: msg.info.id }));
          break;
        }
        case "input":
          ws.send(stdinFrame(op.session, op.data));
          console.log(JSON.stringify({ input: op.session }));
          break;
        case "list":
          send({ type: "session_list" });
          console.log(
            JSON.stringify(await waitFor((m) => m.type === "session_list")),
          );
          break;
        case "scrollback": {
          const reply = waitFor((m) => m.type === "scrollback");
          send({ type: "session_attach", session: op.session });
          const msg = await reply;
          console.log(
            JSON.stringify({
              session: msg.session,
              text: Buffer.from(msg.data, "base64").toString("utf8"),
            }),
          );
          break;
        }
        default:
          throw new Error(`unknown op ${JSON.stringify(op.op)}`);
      }
    }
    ws.close();
    process.exit(0);
  } catch (e) {
    console.error(`[ws] ${e.message}`);
    process.exit(1);
  }
};

ws.onerror = (e) => {
  console.error(`[ws] socket error: ${e.message ?? e}`);
  process.exit(1);
};
