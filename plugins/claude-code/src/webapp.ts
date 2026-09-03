/**
 * The mobile client, served by the plugin over the LAN.
 *
 * Self-contained on purpose: no CDN, no fonts, no build. The page has to load on a
 * phone talking to a laptop on the same Wi-Fi with no route to the internet.
 *
 * Transport is SSE down, POST up. HCP v0.1 specifies `ws://`; a browser-friendly
 * HTTP pair is used here because a WebSocket server would mean hand-rolling RFC 6455
 * framing to keep the zero-dependency property. Same messages, different pipe.
 */
export const PAGE = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="theme-color" content="#0b1112">
<title>HCP</title>
<style>
:root{
  --bg:#0b1112; --surface:#131c1d; --surface2:#1b2627; --rule:#243132;
  --ink:#e3eae8; --ink2:#93a5a4; --ink3:#6c7f7e;
  --accent:#3cc5a6; --accent-ink:#04231d;
  --high:#e0654f; --med:#d9963a; --low:#5a9c8b;
}
@media (prefers-color-scheme:light){
  :root{
    --bg:#eef1f0; --surface:#fff; --surface2:#e4eae9; --rule:#d2dbd9;
    --ink:#0f1a1c; --ink2:#4d605f; --ink3:#758785;
    --accent:#0d7d69; --accent-ink:#fff;
    --high:#b3402c; --med:#8f5c07; --low:#2f6f5e;
  }
}
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
body{margin:0;background:var(--bg);color:var(--ink);
  font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;
  padding-bottom:env(safe-area-inset-bottom)}
code,.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.86em}
header{position:sticky;top:0;z-index:5;background:var(--surface);
  border-bottom:1px solid var(--rule);padding:calc(env(safe-area-inset-top) + 10px) 14px 10px;
  display:flex;align-items:center;gap:10px}
header h1{font-size:15px;margin:0;font-weight:650;letter-spacing:-.01em;flex:1;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#dot{width:8px;height:8px;border-radius:50%;background:var(--ink3);flex:none}
#dot.on{background:var(--accent)}
#state{font-size:11px;color:var(--ink2);text-transform:uppercase;letter-spacing:.08em;flex:none}
main{padding:12px 14px 96px;display:flex;flex-direction:column;gap:8px}
.ev{display:flex;gap:8px;align-items:baseline;padding:7px 10px;background:var(--surface);
  border-radius:8px;border:1px solid var(--rule)}
.ev .k{font-size:10px;color:var(--ink3);text-transform:uppercase;letter-spacing:.07em;
  flex:none;min-width:64px;padding-top:2px}
.ev .t{flex:1;min-width:0;white-space:pre-wrap;overflow-wrap:anywhere}
.ev.me{background:var(--surface2)}
.ev.sys{opacity:.72}
#perm{position:fixed;left:10px;right:10px;bottom:calc(env(safe-area-inset-bottom) + 10px);
  z-index:20;background:var(--surface);border:1px solid var(--rule);border-radius:14px;
  box-shadow:0 18px 48px -12px rgba(0,0,0,.6);padding:14px;display:none}
#perm.show{display:block}
#perm .risk{font-size:10px;font-weight:700;letter-spacing:.1em;text-transform:uppercase}
.risk.high{color:var(--high)} .risk.medium{color:var(--med)} .risk.low{color:var(--low)}
#perm h2{font-size:16px;line-height:1.35;margin:6px 0 8px;font-weight:600}
#perm pre{margin:0 0 10px;padding:8px 10px;background:var(--bg);border-radius:8px;
  border:1px solid var(--rule);overflow-x:auto;font-size:12px;color:var(--ink2)}
.btns{display:flex;flex-direction:column;gap:7px}
button{font:inherit;font-weight:600;border-radius:10px;border:1px solid var(--rule);
  padding:13px 14px;background:var(--surface2);color:var(--ink);cursor:pointer;
  min-height:46px;text-align:center}
button.primary{background:var(--accent);color:var(--accent-ink);border-color:transparent}
button:active{opacity:.72}
#bar{position:fixed;left:0;right:0;bottom:0;z-index:10;display:flex;gap:8px;padding:10px 12px;
  padding-bottom:calc(env(safe-area-inset-bottom) + 10px);
  background:var(--surface);border-top:1px solid var(--rule)}
#bar input{flex:1;min-width:0;font:inherit;padding:12px;border-radius:10px;
  border:1px solid var(--rule);background:var(--bg);color:var(--ink)}
#bar button{flex:none;padding:12px 16px}
#empty{color:var(--ink2);padding:22px 4px;text-align:center;line-height:1.6}
</style></head><body>
<header><span id="dot"></span><h1 id="title">connecting…</h1><span id="state"></span></header>
<main id="feed"><div id="empty">Waiting for a session.<br>Send a prompt in Claude Code and it appears here.</div></main>

<div id="perm">
  <div class="risk" id="prisk"></div>
  <h2 id="psum"></h2>
  <pre id="pdet" hidden></pre>
  <div class="btns" id="pbtns"></div>
</div>

<div id="bar">
  <input id="say" placeholder="Queue a prompt…" autocomplete="off"
         autocapitalize="sentences" enterkeyhint="send">
  <button class="primary" id="send">Send</button>
</div>

<script>
const T = new URLSearchParams(location.hash.slice(1)).get("t")
       || new URLSearchParams(location.search).get("t") || "";
if (T) { try { localStorage.setItem("hcp_t", T); } catch {} }
const TOKEN = T || (() => { try { return localStorage.getItem("hcp_t") || ""; } catch { return ""; } })();
if (location.hash) history.replaceState(null, "", location.pathname);

let CID = null, SID = null, pending = null, attached = new Set();
const $ = (id) => document.getElementById(id);
const feed = $("feed");

function line(kind, text, cls) {
  $("empty")?.remove();
  const d = document.createElement("div");
  d.className = "ev " + (cls || "");
  d.innerHTML = '<span class="k"></span><span class="t"></span>';
  d.children[0].textContent = kind;
  d.children[1].textContent = text;
  feed.appendChild(d);
  while (feed.children.length > 300) feed.removeChild(feed.firstChild);
  window.scrollTo(0, document.body.scrollHeight);
}

async function rpc(method, params) {
  const r = await fetch("/rpc?t=" + encodeURIComponent(TOKEN) + "&c=" + CID, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", hcp: "0.1", id: "r" + Math.random().toString(36).slice(2, 8), method, params }),
  });
  return r.json();
}
function answer(id, option_id, text) {
  fetch("/rpc?t=" + encodeURIComponent(TOKEN) + "&c=" + CID, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", hcp: "0.1", id, result: { option_id, text } }),
  });
}

function showPerm(m) {
  pending = m.id;
  const a = m.params.action;
  $("prisk").textContent = a.risk + " risk" + (a.reversible === false ? " · not reversible" : "");
  $("prisk").className = "risk " + a.risk;
  $("psum").textContent = a.summary;
  const d = a.detail || {};
  const cmd = Array.isArray(d.command) ? d.command.join(" ") : (d.path || d.url || "");
  $("pdet").textContent = cmd; $("pdet").hidden = !cmd;
  const box = $("pbtns"); box.innerHTML = "";
  for (const o of m.params.options) {
    const b = document.createElement("button");
    b.textContent = o.label;
    if (o.kind === "allow" && o.scope === "once") b.className = "primary";
    b.onclick = () => {
      let t;
      if (o.accepts_text) { t = prompt("Tell Claude why:") || undefined; if (t === undefined) return; }
      answer(pending, o.id, t); hidePerm();
    };
    box.appendChild(b);
  }
  $("perm").classList.add("show");
  if (navigator.vibrate) navigator.vibrate(a.risk === "high" ? [40, 60, 40] : 30);
}
const hidePerm = () => { pending = null; $("perm").classList.remove("show"); };

function attach(list) {
  for (const s of list) {
    if (attached.has(s.session_id)) continue;
    attached.add(s.session_id);
    SID = SID || s.session_id;
    $("title").textContent = s.name;
    $("state").textContent = s.state;
    rpc("session/attach", { session_id: s.session_id, from_seq: 0 });
  }
}

const es = new EventSource("/events?t=" + encodeURIComponent(TOKEN));
es.onopen = () => $("dot").classList.add("on");
es.onerror = () => { $("dot").classList.remove("on"); $("state").textContent = "offline"; };
es.onmessage = async (e) => {
  const m = JSON.parse(e.data);

  if (m.method === "hello") {
    CID = m.params.client_id;
    await rpc("initialize", { protocol_versions: ["0.1"],
      client: { name: "hcp-web", version: "0.1.0", form_factor: "phone" },
      device_id: m.params.device_id });
    const l = await rpc("host/sessions/list", {});
    if (!(l.result?.sessions || []).length) $("title").textContent = "no session yet";
    attach(l.result?.sessions || []);
    return;
  }
  if (m.method === "host/status") { attach(m.params.sessions || []); return; }
  if (m.method === "session/request_permission") { showPerm(m); return; }
  if (m.method === "session/permission_resolved") {
    if (pending === m.params.request_id) hidePerm();
    line("resolved", (m.params.option_id || "expired") + " · " +
         (m.params.resolved_by?.device_id || "timeout"), "sys");
    return;
  }
  if (m.method === "session/state") {
    $("state").textContent = m.params.state;
    if (m.params.state === "awaiting_input" && navigator.vibrate) navigator.vibrate(30);
    return;
  }
  if (m.method === "session/update") {
    const u = m.params.update;
    const t = u.text || u.summary || "";
    if (u.kind === "agent_message_delta") line("claude", t);
    else if (u.kind === "user_message") line(u.queued ? "queued" : "you", t, "me");
    else if (u.kind === "tool_call") line(u.risk || "tool", t || u.tool || "", "sys");
    else if (u.kind === "permission_requested") { /* the card covers it */ }
    else if (t) line(u.kind, t, "sys");
  }
};

async function say() {
  const v = $("say").value.trim();
  if (!v || !SID) return;
  $("say").value = "";
  const r = await rpc("session/prompt", { session_id: SID, text: v });
  if (r.error) line("error", r.error.message, "sys");
}
$("send").onclick = say;
$("say").addEventListener("keydown", (e) => { if (e.key === "Enter") say(); });
</script></body></html>`;
