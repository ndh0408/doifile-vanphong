// Cloudflare Worker — Đổi File Văn Phòng: License (key) + Update + Report + Dashboard
// KV bindings: LIC (doifile-licenses), REPORTS (doifile-reports)  |  Secret: ADMIN_KEY

const SERVER = "https://doifile.gianguyen.cloud";
const DEFAULT_GLOBAL = {
  enabled: true,
  message: "",
  latest_version: "1.1.0",
  download_url: "https://github.com/ndh0408/doifile-vanphong/releases/latest/download/Setup-DoiFileVanPhong.exe",
  notes: ""
};
const KEY_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type,x-admin-key"
};

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { ...CORS, "Content-Type": "application/json; charset=utf-8" }
  });
}
function now() { return Date.now(); }

async function getGlobal(env) {
  const raw = await env.LIC.get("global");
  if (!raw) return { ...DEFAULT_GLOBAL };
  try { return { ...DEFAULT_GLOBAL, ...JSON.parse(raw) }; } catch (e) { return { ...DEFAULT_GLOBAL }; }
}
async function setGlobal(env, g) { await env.LIC.put("global", JSON.stringify(g)); }

function genKey() {
  let out = "GN";
  for (let g = 0; g < 3; g++) {
    out += "-";
    const buf = new Uint8Array(4);
    crypto.getRandomValues(buf);
    for (let i = 0; i < 4; i++) out += KEY_CHARS[buf[i] % KEY_CHARS.length];
  }
  return out;
}

function isAdmin(env, url, req) {
  const k = url.searchParams.get("key") || req.headers.get("x-admin-key");
  return k && k === env.ADMIN_KEY;
}

async function listKeys(env) {
  const out = [];
  let cursor;
  do {
    const res = await env.LIC.list({ prefix: "key:", cursor });
    for (const it of res.keys) {
      const rec = JSON.parse((await env.LIC.get(it.name)) || "{}");
      rec.key = it.name.slice(4);
      out.push(rec);
    }
    cursor = res.list_complete ? null : res.cursor;
  } while (cursor);
  out.sort((a, b) => (b.issued || 0) - (a.issued || 0));
  return out;
}
async function listBlocked(env) {
  const out = [];
  const res = await env.LIC.list({ prefix: "mblock:" });
  for (const it of res.keys) {
    const rec = JSON.parse((await env.LIC.get(it.name)) || "{}");
    rec.machine = it.name.slice(7);
    out.push(rec);
  }
  return out;
}
async function listReports(env, limit) {
  const out = [];
  const res = await env.REPORTS.list({ prefix: "r:", limit: limit || 200 });
  for (const it of res.keys.reverse()) out.push(JSON.parse((await env.REPORTS.get(it.name)) || "{}"));
  return out;
}

export default {
  async fetch(req, env) {
    if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
    const url = new URL(req.url);
    const path = url.pathname;

    // ---------------- APP: verify key ----------------
    if (req.method === "POST" && path === "/verify") {
      let d = {};
      try { d = await req.json(); } catch (e) {}
      const g = await getGlobal(env);
      const base = {
        enabled: g.enabled, message: g.message,
        latest_version: g.latest_version, download_url: g.download_url, notes: g.notes,
        report_url: SERVER + "/report"
      };
      if (!g.enabled) return json({ ...base, ok: false, reason: g.message || "Phần mềm đã tạm ngưng. Liên hệ Gia Nguyễn A.P.T." });

      const key = String(d.key || "").trim().toUpperCase();
      const machine = String(d.machine || "").trim();
      const recRaw = await env.LIC.get("key:" + key);
      if (!recRaw) return json({ ...base, ok: false, reason: "Key không tồn tại. Kiểm tra lại hoặc liên hệ Gia Nguyễn." });
      const rec = JSON.parse(recRaw);
      if (rec.revoked) return json({ ...base, ok: false, reason: "Key đã bị khóa. Vui lòng liên hệ Gia Nguyễn." });

      const blk = await env.LIC.get("mblock:" + machine);
      if (blk) return json({ ...base, ok: false, reason: "Thiết bị này đã bị chặn." });

      if (rec.machine && rec.machine !== machine)
        return json({ ...base, ok: false, reason: "Key đã được kích hoạt trên máy khác." });

      if (!rec.machine) { rec.machine = machine; rec.activatedAt = now(); }
      rec.machine_name = d.machine_name || rec.machine_name || "";
      rec.user = d.user || rec.user || "";
      rec.version = d.version || rec.version || "";
      rec.lastSeen = now();
      await env.LIC.put("key:" + key, JSON.stringify(rec));
      return json({ ...base, ok: true });
    }

    // ---------------- APP: report ----------------
    if (req.method === "POST" && path === "/report") {
      let d = {};
      try { d = await req.json(); } catch (e) {}
      const ts = new Date(now()).toISOString();
      const id = "r:" + ts + ":" + Math.random().toString(36).slice(2, 8);
      const rec = {
        ts, kind: d.kind || "?", version: d.version || "?",
        machine: d.machine || "?", machine_id: d.machine_id || "?",
        user: d.user || "?", os: d.os || "?", detail: (d.detail || "").slice(0, 6000)
      };
      await env.REPORTS.put(id, JSON.stringify(rec), { expirationTtl: 60 * 60 * 24 * 180 });
      if (env.DISCORD_WEBHOOK && rec.kind === "error") {
        try {
          await fetch(env.DISCORD_WEBHOOK, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ content: "**[LOI] " + rec.machine + "/" + rec.user + "** v" + rec.version + "\n```" + rec.detail.slice(0, 1600) + "```" })
          });
        } catch (e) {}
      }
      return json({ ok: true });
    }

    // ---------------- ADMIN JSON API ----------------
    if (path.startsWith("/admin/")) {
      if (!isAdmin(env, url, req)) return json({ ok: false, error: "forbidden" }, 403);

      if (path === "/admin/state") {
        return json({
          ok: true,
          global: await getGlobal(env),
          keys: await listKeys(env),
          blocked: await listBlocked(env),
          reports: await listReports(env, 100)
        });
      }
      if (req.method === "POST" && path === "/admin/set-global") {
        let d = {}; try { d = await req.json(); } catch (e) {}
        const g = await getGlobal(env);
        if ("enabled" in d) g.enabled = !!d.enabled;
        if ("message" in d) g.message = String(d.message || "");
        if ("latest_version" in d) g.latest_version = String(d.latest_version || "");
        if ("download_url" in d) g.download_url = String(d.download_url || "");
        if ("notes" in d) g.notes = String(d.notes || "");
        await setGlobal(env, g);
        return json({ ok: true, global: g });
      }
      if (req.method === "POST" && path === "/admin/issue") {
        let d = {}; try { d = await req.json(); } catch (e) {}
        const n = Math.min(Math.max(parseInt(d.n || 1, 10), 1), 50);
        const note = String(d.note || "");
        const made = [];
        for (let i = 0; i < n; i++) {
          let key; let tries = 0;
          do { key = genKey(); tries++; } while ((await env.LIC.get("key:" + key)) && tries < 5);
          const rec = { issued: now(), note, revoked: false, machine: null, machine_name: "", user: "", version: "", lastSeen: 0 };
          await env.LIC.put("key:" + key, JSON.stringify(rec));
          made.push(key);
        }
        return json({ ok: true, keys: made });
      }
      if (req.method === "POST" && path === "/admin/key-action") {
        let d = {}; try { d = await req.json(); } catch (e) {}
        const key = String(d.k || "").toUpperCase();
        const action = d.action;
        const raw = await env.LIC.get("key:" + key);
        if (!raw) return json({ ok: false, error: "no-key" }, 404);
        if (action === "delete") { await env.LIC.delete("key:" + key); return json({ ok: true }); }
        const rec = JSON.parse(raw);
        if (action === "revoke") rec.revoked = true;
        else if (action === "unrevoke") rec.revoked = false;
        else if (action === "reset") { rec.machine = null; rec.machine_name = ""; rec.activatedAt = 0; }
        else if (action === "note") rec.note = String(d.note || "");
        await env.LIC.put("key:" + key, JSON.stringify(rec));
        return json({ ok: true, rec });
      }
      if (req.method === "POST" && path === "/admin/machine") {
        let d = {}; try { d = await req.json(); } catch (e) {}
        const m = String(d.m || "").trim();
        if (!m) return json({ ok: false, error: "no-machine" }, 400);
        if (d.action === "block") await env.LIC.put("mblock:" + m, JSON.stringify({ name: d.name || "", at: now() }));
        else if (d.action === "unblock") await env.LIC.delete("mblock:" + m);
        return json({ ok: true });
      }
      return json({ ok: false, error: "unknown" }, 404);
    }

    // ---------------- Dashboard ----------------
    if (req.method === "GET" && (path === "/bang" || path === "/")) {
      if (path === "/") return new Response("Doi File Van Phong — OK", { headers: CORS });
      if (url.searchParams.get("key") !== env.ADMIN_KEY)
        return new Response("Sai key quản trị", { status: 403, headers: { "Content-Type": "text/plain; charset=utf-8" } });
      return new Response(DASHBOARD(env.ADMIN_KEY), { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }

    return new Response("Not found", { status: 404, headers: CORS });
  }
};

function DASHBOARD(adminKey) {
  return `<!doctype html><html lang="vi"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Quản trị — Đổi File Văn Phòng | Gia Nguyễn A.P.T</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@500;600;700&display=swap" rel="stylesheet">
<style>
:root {
  --bg: #0B0F19;
  --surface: #111827;
  --surface-hover: #1F2937;
  --surface-card: #161F30;
  --border: #1F2937;
  --border-focus: #374151;
  --gold: #EAB308;
  --gold-dark: #CA8A04;
  --gold-glow: rgba(234, 179, 8, 0.15);
  --text: #F9FAFB;
  --muted: #9CA3AF;
  --ok: #10B981;
  --ok-bg: rgba(16, 185, 129, 0.12);
  --err: #EF4444;
  --err-bg: rgba(239, 68, 68, 0.12);
  --purple: #8B5CF6;
  --purple-bg: rgba(139, 92, 246, 0.12);
  --radius: 12px;
}
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
  font-family: 'Inter', system-ui, -apple-system, sans-serif;
  background-color: var(--bg);
  color: var(--text);
  line-height: 1.5;
  -webkit-font-smoothing: antialiased;
}
code, pre, .mono { font-family: 'JetBrains Mono', monospace; }

header {
  background: var(--surface);
  border-bottom: 1px solid var(--border);
  padding: 16px 28px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  position: sticky;
  top: 0;
  z-index: 50;
  backdrop-filter: blur(12px);
}
.brand-group { display: flex; align-items: center; gap: 14px; }
.brand-logo {
  width: 42px; height: 42px; border-radius: 12px;
  background: linear-gradient(135deg, #FACC15, #CA8A04);
  color: #0F172A; font-weight: 800; font-size: 16px;
  display: grid; place-items: center;
  box-shadow: 0 0 20px rgba(234, 179, 8, 0.25);
}
.brand-title { font-weight: 800; font-size: 18px; letter-spacing: -0.02em; color: var(--text); }
.brand-sub { font-size: 12px; color: var(--muted); font-weight: 500; }
.header-badge {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 5px 12px; border-radius: 999px; font-size: 12px; font-weight: 600;
  background: var(--ok-bg); color: var(--ok); border: 1px solid rgba(16, 185, 129, 0.2);
}
.header-badge .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--ok); box-shadow: 0 0 8px var(--ok); }

.wrap { max-width: 1240px; margin: 0 auto; padding: 24px 20px; }

.stats-grid {
  display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
  gap: 16px; margin-bottom: 24px;
}
.stat-card {
  background: var(--surface); border: 1px solid var(--border);
  border-radius: var(--radius); padding: 18px 20px;
  display: flex; align-items: center; justify-content: space-between;
  transition: transform 0.2s, border-color 0.2s;
}
.stat-card:hover { border-color: var(--border-focus); transform: translateY(-2px); }
.stat-label { font-size: 13px; font-weight: 600; color: var(--muted); margin-bottom: 4px; }
.stat-value { font-size: 26px; font-weight: 800; color: var(--text); letter-spacing: -0.02em; }
.stat-icon {
  width: 46px; height: 46px; border-radius: 12px;
  display: grid; place-items: center; font-size: 20px;
  background: var(--surface-card); border: 1px solid var(--border);
}

.tabs { display: flex; gap: 8px; margin-bottom: 20px; border-bottom: 1px solid var(--border); padding-bottom: 12px; }
.tab {
  padding: 9px 18px; border-radius: 10px; background: transparent;
  border: 1px solid transparent; cursor: pointer; font-weight: 600; font-size: 14px;
  color: var(--muted); transition: all 0.2s; display: inline-flex; align-items: center; gap: 8px;
}
.tab:hover { color: var(--text); background: var(--surface-hover); }
.tab.on { background: var(--gold-glow); color: var(--gold); border-color: rgba(234, 179, 8, 0.3); }

.card {
  background: var(--surface); border: 1px solid var(--border);
  border-radius: var(--radius); padding: 22px; margin-bottom: 20px;
}
.card-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px; flex-wrap: wrap; gap: 12px; }
.card-head h3 { font-size: 16px; font-weight: 700; color: var(--text); }

label { font-size: 12px; font-weight: 600; color: var(--muted); display: block; margin: 10px 0 4px; text-transform: uppercase; letter-spacing: 0.04em; }
input, textarea {
  width: 100%; padding: 10px 14px; background: var(--bg);
  border: 1px solid var(--border); border-radius: 10px;
  font-size: 14px; color: var(--text); font-family: inherit;
  outline: none; transition: border-color 0.2s, box-shadow 0.2s;
}
input:focus, textarea:focus { border-color: var(--gold); box-shadow: 0 0 0 3px var(--gold-glow); }
textarea { resize: vertical; min-height: 70px; }

button {
  background: var(--gold); color: #0F172A; border: 0; padding: 10px 18px;
  border-radius: 10px; cursor: pointer; font-weight: 700; font-size: 14px;
  transition: all 0.2s; display: inline-flex; align-items: center; justify-content: center; gap: 6px;
}
button:hover { background: var(--gold-dark); color: #fff; }
button.gray { background: var(--surface-hover); color: var(--text); border: 1px solid var(--border); }
button.gray:hover { background: var(--border-focus); }
button.red { background: var(--err-bg); color: var(--err); border: 1px solid rgba(239, 68, 68, 0.2); }
button.red:hover { background: var(--err); color: #fff; }
button.sm { padding: 6px 12px; font-size: 12px; border-radius: 8px; }

.table-wrap { overflow-x: auto; margin-top: 10px; border-radius: 10px; border: 1px solid var(--border); }
table { width: 100%; border-collapse: collapse; font-size: 13px; text-align: left; }
th, td { padding: 12px 14px; border-bottom: 1px solid var(--border); vertical-align: middle; }
th { background: var(--surface-card); color: var(--muted); font-weight: 600; font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em; }
tr:last-child td { border-bottom: 0; }
tr:hover td { background: rgba(255,255,255,0.02); }

code.kcode {
  background: var(--surface-card); padding: 3px 8px; border-radius: 6px;
  font-weight: 700; color: var(--gold); border: 1px solid rgba(234, 179, 8, 0.2); font-size: 13px;
}

.pill {
  font-size: 11px; font-weight: 700; padding: 3px 10px; border-radius: 999px;
  display: inline-flex; align-items: center; gap: 5px;
}
.p-free { background: var(--purple-bg); color: var(--purple); border: 1px solid rgba(139, 92, 246, 0.2); }
.p-use { background: var(--ok-bg); color: var(--ok); border: 1px solid rgba(16, 185, 129, 0.2); }
.p-rev { background: var(--err-bg); color: var(--err); border: 1px solid rgba(239, 68, 68, 0.2); }

.row-actions { display: flex; gap: 6px; flex-wrap: wrap; }

.switch-box { display: flex; align-items: center; gap: 14px; padding: 14px; background: var(--surface-card); border-radius: 12px; border: 1px solid var(--border); }
.toggle { width: 52px; height: 28px; border-radius: 999px; background: var(--border); position: relative; cursor: pointer; transition: background 0.3s; }
.toggle.on { background: var(--ok); }
.toggle b { position: absolute; top: 3px; left: 3px; width: 22px; height: 22px; border-radius: 50%; background: #fff; transition: left 0.25s cubic-bezier(0.4, 0, 0.2, 1); }
.toggle.on b { left: 27px; }

.hint { color: var(--muted); font-size: 12px; margin-top: 6px; }
.empty { color: var(--muted); text-align: center; padding: 36px; font-weight: 500; }

pre { white-space: pre-wrap; background: #060911; color: #E2E8F0; padding: 12px; border-radius: 8px; font-size: 12px; overflow: auto; margin: 8px 0 0; border: 1px solid var(--border); }
.k-err { background: var(--err-bg); color: var(--err); }
.k-st { background: var(--ok-bg); color: var(--ok); }
.kpill { font-size: 11px; font-weight: 700; padding: 3px 8px; border-radius: 6px; margin-right: 8px; }

.search-box { display: flex; gap: 10px; margin-bottom: 14px; flex-wrap: wrap; }
.search-box input { flex: 1; min-width: 220px; }

.flash {
  position: fixed; bottom: 24px; right: 24px; background: var(--surface-card);
  color: var(--text); border: 1px solid var(--gold); padding: 14px 22px;
  border-radius: 12px; opacity: 0; transform: translateY(10px); transition: all 0.3s;
  font-weight: 600; box-shadow: 0 10px 30px rgba(0,0,0,0.5); pointer-events: none; z-index: 100;
  display: flex; align-items: center; gap: 8px;
}
.flash.show { opacity: 1; transform: translateY(0); }
</style></head><body>

<header>
  <div class="brand-group">
    <div class="brand-logo">GN</div>
    <div>
      <div class="brand-title">Quản trị — Đổi File Văn Phòng</div>
      <div class="brand-sub">Gia Nguyễn A.P.T • Event & Production</div>
    </div>
  </div>
  <div class="header-badge"><span class="dot"></span> Hệ thống đang chạy</div>
</header>

<div class="wrap">
  <!-- STATS OVERVIEW -->
  <div class="stats-grid">
    <div class="stat-card">
      <div>
        <div class="stat-label">TỔNG MÃ KEY</div>
        <div class="stat-value" id="st-keys">0</div>
      </div>
      <div class="stat-icon">🔑</div>
    </div>
    <div class="stat-card">
      <div>
        <div class="stat-label">MÁY ĐANG DÙNG</div>
        <div class="stat-value" id="st-active" style="color:var(--ok)">0</div>
      </div>
      <div class="stat-icon">💻</div>
    </div>
    <div class="stat-card">
      <div>
        <div class="stat-label">MÁY BỊ CHẶN</div>
        <div class="stat-value" id="st-blocked" style="color:var(--err)">0</div>
      </div>
      <div class="stat-icon">⛔</div>
    </div>
    <div class="stat-card">
      <div>
        <div class="stat-label">BÁO LỖI / EVENT</div>
        <div class="stat-value" id="st-reports" style="color:var(--purple)">0</div>
      </div>
      <div class="stat-icon">🐞</div>
    </div>
  </div>

  <!-- TABS -->
  <div class="tabs">
    <div class="tab on" data-t="keys">🔑 Cấp phép (Key)</div>
    <div class="tab" data-t="blocked">⛔ Máy bị chặn</div>
    <div class="tab" data-t="global">⚙️ Cài đặt chung</div>
    <div class="tab" data-t="reports">🐞 Báo lỗi</div>
  </div>

  <!-- PANE: KEYS -->
  <div class="pane" id="pane-keys">
    <div class="card">
      <div class="card-head"><h3>Cấp key bản quyền mới</h3></div>
      <div style="display:flex;gap:12px;flex-wrap:wrap;align-items:end">
        <div style="width:110px"><label>Số lượng</label><input id="issueN" type="number" value="1" min="1" max="50"></div>
        <div style="flex:1;min-width:220px"><label>Ghi chú người dùng / bộ phận</label><input id="issueNote" placeholder="VD: Kế toán - Chị Lan"></div>
        <button onclick="issue()">+ Cấp key ngay</button>
      </div>
      <div id="newKeys" class="hint" style="margin-top:10px"></div>
    </div>

    <div class="card">
      <div class="card-head">
        <h3>Danh sách Key bản quyền</h3>
        <div class="search-box" style="margin:0">
          <input id="keySearch" placeholder="🔍 Tìm theo Key, người dùng, mã máy..." oninput="renderKeys()">
        </div>
      </div>
      <div id="keysBox"><div class="empty">Đang tải dữ liệu…</div></div>
    </div>
  </div>

  <!-- PANE: BLOCKED -->
  <div class="pane" id="pane-blocked" style="display:none">
    <div class="card">
      <div class="card-head"><h3>Chặn thiết bị theo Mã máy</h3></div>
      <div style="display:flex;gap:12px;flex-wrap:wrap;align-items:end">
        <div style="flex:1;min-width:220px"><label>Mã máy (Machine ID)</label><input id="blkM" placeholder="VD: 1A2B-3C4D-5E6F"></div>
        <div style="flex:1;min-width:180px"><label>Lý do chặn</label><input id="blkN" placeholder="VD: Máy nghi vấn vi phạm"></div>
        <button class="red" onclick="blockM()">Chặn thiết bị</button>
      </div>
      <div class="hint">Thiết bị bị chặn sẽ không thể khởi chạy ứng dụng kể cả khi dùng Key hợp lệ.</div>
    </div>
    <div class="card">
      <div class="card-head"><h3>Danh sách máy đang bị chặn</h3></div>
      <div id="blkBox"><div class="empty">Đang tải…</div></div>
    </div>
  </div>

  <!-- PANE: GLOBAL -->
  <div class="pane" id="pane-global" style="display:none">
    <div class="card">
      <div class="card-head"><h3>Bật / Tắt toàn bộ phần mềm (Kill-Switch)</h3></div>
      <div class="switch-box">
        <div class="toggle" id="tgl" onclick="toggleGlobal()"><b></b></div>
        <div>
          <div id="tglTxt" style="font-weight:700;font-size:15px">…</div>
          <div class="hint" style="margin:0">Tắt = mọi máy sẽ bị khóa khi mở app (máy mất mạng bị khóa tối đa sau 14 ngày).</div>
        </div>
      </div>
      <label style="margin-top:14px">Thông báo hiển thị khi bị khóa</label>
      <textarea id="gMsg" rows="2" placeholder="VD: Phần mềm tạm ngưng hoạt động. Liên hệ Gia Nguyễn A.P.T."></textarea>
      <button style="margin-top:12px" onclick="saveGlobal()">Lưu cấu hình khóa</button>
    </div>

    <div class="card">
      <div class="card-head"><h3>Quản lý phiên bản cập nhật</h3></div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:14px">
        <div><label>Phiên bản mới nhất</label><input id="gVer" placeholder="VD: 1.1.0"></div>
        <div><label>Link tải bộ cài (.exe)</label><input id="gUrl" placeholder="https://github.com/..."></div>
      </div>
      <label style="margin-top:10px">Ghi chú bản cập nhật</label>
      <input id="gNotes" placeholder="VD: Cải tiến giao diện luxury, tối ưu tốc độ">
      <button style="margin-top:14px" onclick="saveGlobal()">Lưu thông tin cập nhật</button>
      <div class="hint">Ứng dụng ở phiên bản thấp hơn sẽ xuất hiện thanh gợi ý “Cập nhật ngay”.</div>
    </div>
  </div>

  <!-- PANE: REPORTS -->
  <div class="pane" id="pane-reports" style="display:none">
    <div class="card">
      <div class="card-head"><h3>Nhật ký hoạt động & Báo lỗi từ các máy</h3></div>
      <div id="repBox"><div class="empty">Đang tải…</div></div>
    </div>
  </div>
</div>

<div class="flash" id="flash"></div>

<script>
const KEY = ${JSON.stringify(adminKey)};
const qs = "key=" + encodeURIComponent(KEY);
let STATE = null;

function flash(m) {
  const f = document.getElementById('flash');
  f.innerHTML = '✨ ' + m;
  f.classList.add('show');
  setTimeout(() => f.classList.remove('show'), 2000);
}
function esc(s) { return String(s == null ? '' : s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }
function tdate(ms) { if (!ms) return '—'; const d = new Date(ms); return d.toLocaleString('vi-VN'); }

async function api(p, body) {
  const o = { headers: { 'Content-Type': 'application/json' } };
  if (body) { o.method = 'POST'; o.body = JSON.stringify(body); }
  const r = await fetch(p + (p.includes('?') ? '&' : '?') + qs, o);
  return r.json();
}

async function load() {
  STATE = await api('/admin/state');
  render();
}

document.querySelectorAll('.tab').forEach(t => t.onclick = () => {
  document.querySelectorAll('.tab').forEach(x => x.classList.remove('on')); t.classList.add('on');
  document.querySelectorAll('.pane').forEach(p => p.style.display = 'none');
  document.getElementById('pane-' + t.dataset.t).style.display = 'block';
});

function render() {
  if (!STATE) return;
  const g = STATE.global || {};
  const keys = STATE.keys || [];
  const blocked = STATE.blocked || [];
  const reports = STATE.reports || [];

  // Update Stats
  document.getElementById('st-keys').textContent = keys.length;
  document.getElementById('st-active').textContent = keys.filter(k => k.machine && !k.revoked).length;
  document.getElementById('st-blocked').textContent = blocked.length;
  document.getElementById('st-reports').textContent = reports.length;

  // Global Settings
  document.getElementById('tgl').classList.toggle('on', g.enabled);
  document.getElementById('tglTxt').textContent = g.enabled ? 'ĐANG BẬT — Tất cả thiết bị được phép sử dụng' : 'ĐANG TẮT — Mọi thiết bị đều bị khóa';
  document.getElementById('tglTxt').style.color = g.enabled ? 'var(--ok)' : 'var(--err)';
  document.getElementById('gMsg').value = g.message || '';
  document.getElementById('gVer').value = g.latest_version || '';
  document.getElementById('gUrl').value = g.download_url || '';
  document.getElementById('gNotes').value = g.notes || '';

  renderKeys();

  // Blocked Table
  const bb = document.getElementById('blkBox');
  if (!blocked.length) {
    bb.innerHTML = '<div class="empty">Chưa có thiết bị nào bị chặn.</div>';
  } else {
    bb.innerHTML = '<div class="table-wrap"><table><tr><th>Mã máy (Machine ID)</th><th>Ghi chú lý do</th><th>Thời điểm chặn</th><th>Thao tác</th></tr>' +
      blocked.map(b => '<tr><td><code class="kcode" style="color:var(--err);border-color:rgba(239,68,68,0.3)">' + esc(b.machine) + '</code></td><td>' + esc(b.name || '—') + '</td><td>' + tdate(b.at) + '</td><td><button class="sm gray" onclick="unblockM(\'' + b.machine + '\')">Bỏ chặn</button></td></tr>').join('') +
      '</table></div>';
  }

  // Reports
  const rb = document.getElementById('repBox');
  if (!reports.length) {
    rb.innerHTML = '<div class="empty">✅ Chưa có nhật ký báo lỗi nào.</div>';
  } else {
    rb.innerHTML = reports.map(x => {
      const c = x.kind === 'error' ? 'k-err' : 'k-st';
      return '<div style="border-bottom:1px solid var(--border);padding:14px 0"><span class="kpill ' + c + '">' + esc(x.kind).toUpperCase() + '</span><b>' + esc(x.machine) + ' / ' + esc(x.user) + '</b> <span class="hint">' + esc(x.ts) + ' • v' + esc(x.version) + ' • <code class="mono">' + esc(x.machine_id || '') + '</code></span>' + (x.detail ? '<pre>' + esc(x.detail) + '</pre>' : '') + '</div>';
    }).join('');
  }
}

function renderKeys() {
  if (!STATE || !STATE.keys) return;
  const filter = (document.getElementById('keySearch').value || '').trim().toLowerCase();
  const keys = STATE.keys.filter(k => {
    if (!filter) return true;
    return (k.key || '').toLowerCase().includes(filter) ||
           (k.note || '').toLowerCase().includes(filter) ||
           (k.machine || '').toLowerCase().includes(filter) ||
           (k.user || '').toLowerCase().includes(filter);
  });

  const kb = document.getElementById('keysBox');
  if (!keys.length) {
    kb.innerHTML = '<div class="empty">Không tìm thấy key nào phù hợp.</div>';
  } else {
    kb.innerHTML = '<div class="table-wrap"><table><tr><th>Key bản quyền</th><th>Trạng thái</th><th>Máy & Người dùng</th><th>Kích hoạt</th><th>Ghi chú</th><th>Thao tác</th></tr>' +
      keys.map(k => {
        let st = k.revoked ? '<span class="pill p-rev">● Đã khóa</span>' : (k.machine ? '<span class="pill p-use">● Đang dùng</span>' : '<span class="pill p-free">● Chưa dùng</span>');
        const mach = k.machine ? ('<b>' + esc(k.machine_name || '') + '</b><br><code class="mono" style="font-size:11px;color:var(--muted)">' + esc(k.machine) + '</code>' + (k.user ? '<br><span style="font-size:11px;color:var(--muted)">👤 ' + esc(k.user) + '</span>' : '')) : '—';
        const act = '<div class="row-actions">' +
          (k.revoked ? '<button class="sm" onclick="keyAct(\'' + k.key + '\',\'unrevoke\')">Mở khóa</button>' : '<button class="sm red" onclick="keyAct(\'' + k.key + '\',\'revoke\')">Khóa</button>') +
          (k.machine ? '<button class="sm gray" onclick="keyAct(\'' + k.key + '\',\'reset\')">Gỡ máy</button>' : '') +
          '<button class="sm gray" onclick="copyKey(\'' + k.key + '\')">Sao chép</button>' +
          '<button class="sm red" onclick="keyAct(\'' + k.key + '\',\'delete\')">Xóa</button></div>';
        return '<tr><td><code class="kcode">' + esc(k.key) + '</code></td><td>' + st + '</td><td>' + mach + '</td><td>' + tdate(k.activatedAt) + '</td><td>' + esc(k.note || '—') + '</td><td>' + act + '</td></tr>';
      }).join('') + '</table></div>';
  }
}

async function issue() {
  const n = +document.getElementById('issueN').value || 1;
  const note = document.getElementById('issueNote').value;
  const r = await api('/admin/issue', { n, note });
  if (r.ok) {
    document.getElementById('newKeys').innerHTML = '🔑 <b>Đã cấp mới (' + r.keys.length + '):</b> ' + r.keys.map(k => '<code class="kcode">' + k + '</code>').join(' ');
    flash('Đã cấp thành công ' + r.keys.length + ' key!');
    load();
  }
}

async function keyAct(k, action) {
  if (action === 'delete' && !confirm('Xóa hẳn key ' + k + ' ?')) return;
  await api('/admin/key-action', { k, action });
  flash('Đã cập nhật trạng thái Key ' + k);
  load();
}

function copyKey(k) {
  navigator.clipboard.writeText(k);
  flash('Đã sao chép: ' + k);
}

async function toggleGlobal() {
  await api('/admin/set-global', { enabled: !STATE.global.enabled });
  flash('Đã thay đổi trạng thái toàn hệ thống!');
  load();
}

async function saveGlobal() {
  await api('/admin/set-global', {
    message: document.getElementById('gMsg').value,
    latest_version: document.getElementById('gVer').value,
    download_url: document.getElementById('gUrl').value,
    notes: document.getElementById('gNotes').value
  });
  flash('Đã lưu cấu hình!');
  load();
}

async function blockM() {
  const m = document.getElementById('blkM').value.trim();
  if (!m) return;
  await api('/admin/machine', { m, name: document.getElementById('blkN').value, action: 'block' });
  flash('Đã chặn máy: ' + m);
  document.getElementById('blkM').value = '';
  load();
}

async function unblockM(m) {
  await api('/admin/machine', { m, action: 'unblock' });
  flash('Đã bỏ chặn máy: ' + m);
  load();
}

load();
</script></body></html>`;
}

