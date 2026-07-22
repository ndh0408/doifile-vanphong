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
      if (!g.enabled) return json({ ...base, ok: false, reason: g.message || "Phần mềm đã tạm ngưng. Liên hệ Gia Nguyên A.P.T." });

      const key = String(d.key || "").trim().toUpperCase();
      const machine = String(d.machine || "").trim();
      const recRaw = await env.LIC.get("key:" + key);
      if (!recRaw) return json({ ...base, ok: false, reason: "Key không tồn tại. Kiểm tra lại hoặc liên hệ Gia Nguyên." });
      const rec = JSON.parse(recRaw);
      if (rec.revoked) return json({ ...base, ok: false, reason: "Key đã bị khóa. Vui lòng liên hệ Gia Nguyên." });

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
<title>Quản trị — Đổi File Văn Phòng | Gia Nguyên</title>
<style>
:root{--gold:#AE842D;--goldD:#8B6A24;--char:#4E4E50;--bg:#F3F4F6;--line:#E4E6EA;--muted:#8A8F98;--ok:#2E9E5B;--err:#C0392B}
*{box-sizing:border-box}body{margin:0;font-family:system-ui,Segoe UI,sans-serif;background:var(--bg);color:#2b2b2e}
header{background:#fff;border-bottom:3px solid var(--gold);padding:14px 20px;display:flex;align-items:center;gap:14px}
header .t{font-weight:800;color:var(--char);font-size:18px}header .s{color:var(--muted);font-size:12px}
.badge{width:40px;height:40px;border-radius:10px;background:var(--gold);color:#fff;font-weight:800;display:grid;place-items:center;font-family:Georgia,serif}
.wrap{max-width:1080px;margin:0 auto;padding:16px}
.tabs{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px}
.tab{padding:8px 16px;border-radius:999px;background:#fff;border:1px solid var(--line);cursor:pointer;font-weight:600}
.tab.on{background:var(--gold);color:#fff;border-color:var(--gold)}
.card{background:#fff;border:1px solid var(--line);border-radius:14px;padding:16px;margin-bottom:14px}
h3{margin:0 0 10px}label{font-size:13px;color:var(--muted);display:block;margin:8px 0 3px}
input,textarea{width:100%;padding:9px 11px;border:1px solid var(--line);border-radius:9px;font-size:14px;font-family:inherit}
button{background:var(--gold);color:#fff;border:0;padding:9px 15px;border-radius:9px;cursor:pointer;font-weight:700;font-size:14px}
button:hover{background:var(--goldD)}button.gray{background:var(--char)}button.red{background:var(--err)}button.sm{padding:5px 10px;font-size:12px;border-radius:7px}
table{width:100%;border-collapse:collapse;font-size:13px}th,td{text-align:left;padding:8px 6px;border-bottom:1px solid var(--line);vertical-align:top}
th{color:var(--muted);font-weight:600}code{background:#f6f2e8;padding:2px 6px;border-radius:5px;font-weight:700;color:var(--goldD)}
.pill{font-size:11px;font-weight:700;padding:2px 8px;border-radius:999px}.p-free{background:#eef2ff;color:#33459e}.p-use{background:#e7f7ee;color:#1c7a45}
.p-rev{background:#fdecea;color:#a3271c}.row-actions{display:flex;gap:5px;flex-wrap:wrap}
.switch{display:flex;align-items:center;gap:10px;font-weight:700}
.toggle{width:52px;height:28px;border-radius:999px;background:#ccc;position:relative;cursor:pointer;transition:.2s}
.toggle.on{background:var(--ok)}.toggle b{position:absolute;top:3px;left:3px;width:22px;height:22px;border-radius:50%;background:#fff;transition:.2s}
.toggle.on b{left:27px}.hint{color:var(--muted);font-size:12px;margin-top:4px}
.empty{color:var(--muted);text-align:center;padding:26px}pre{white-space:pre-wrap;background:#0c1018;color:#e6e9ef;padding:8px;border-radius:7px;font-size:12px;overflow:auto;margin:6px 0 0}
.k-err{background:#5c1f1f;color:#ffb4b4}.k-st{background:#1f4a2e;color:#a7f0c0}.kpill{font-size:11px;font-weight:700;padding:2px 8px;border-radius:6px;margin-right:6px}
.flash{position:fixed;bottom:20px;right:20px;background:var(--char);color:#fff;padding:12px 18px;border-radius:10px;opacity:0;transition:.3s;font-weight:600}
.flash.show{opacity:1}
</style></head><body>
<header><div class="badge">GN</div><div><div class="t">Quản trị — Đổi File Văn Phòng</div><div class="s">Gia Nguyên A.P.T • event & production</div></div></header>
<div class="wrap">
<div class="tabs">
<div class="tab on" data-t="keys">🔑 Cấp phép (Key)</div>
<div class="tab" data-t="blocked">⛔ Máy bị chặn</div>
<div class="tab" data-t="global">⚙️ Cài đặt chung</div>
<div class="tab" data-t="reports">🐞 Báo lỗi</div>
</div>

<div class="pane" id="pane-keys">
  <div class="card">
    <h3>Cấp key mới</h3>
    <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:end">
      <div><label>Số lượng</label><input id="issueN" type="number" value="1" min="1" max="50" style="width:90px"></div>
      <div style="flex:1;min-width:180px"><label>Ghi chú (vd: Kế toán - chị Lan)</label><input id="issueNote" placeholder="Tên/bộ phận người dùng"></div>
      <button onclick="issue()">+ Cấp key</button>
    </div>
    <div id="newKeys" class="hint"></div>
  </div>
  <div class="card"><h3>Danh sách key</h3><div id="keysBox"><div class="empty">Đang tải…</div></div></div>
</div>

<div class="pane" id="pane-blocked" style="display:none">
  <div class="card"><h3>Chặn máy theo Mã máy</h3>
    <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:end">
      <div style="flex:1;min-width:180px"><label>Mã máy (xem trong báo lỗi / màn hình kích hoạt, vd 1A2B-3C4D-5E6F)</label><input id="blkM" placeholder="XXXX-XXXX-XXXX"></div>
      <div style="flex:1;min-width:150px"><label>Ghi chú</label><input id="blkN" placeholder="Lý do"></div>
      <button class="red" onclick="blockM()">Chặn máy</button>
    </div>
    <div class="hint">Máy bị chặn sẽ không dùng được dù có key hợp lệ.</div>
  </div>
  <div class="card"><h3>Máy đang bị chặn</h3><div id="blkBox"><div class="empty">Đang tải…</div></div></div>
</div>

<div class="pane" id="pane-global" style="display:none">
  <div class="card">
    <h3>Bật / Tắt toàn bộ phần mềm</h3>
    <div class="switch"><div class="toggle" id="tgl" onclick="toggleGlobal()"><b></b></div><span id="tglTxt">…</span></div>
    <div class="hint">Tắt = <b>mọi máy</b> ngừng dùng được ngay lần mở kế tiếp (máy offline tối đa 14 ngày). Dùng khi cần khóa khẩn cấp.</div>
    <label>Lời nhắn khi bị khóa</label><textarea id="gMsg" rows="2" placeholder="VD: Phần mềm tạm ngưng, liên hệ 09xx"></textarea>
    <button style="margin-top:10px" onclick="saveGlobal()">Lưu lời nhắn</button>
  </div>
  <div class="card">
    <h3>Phiên bản cập nhật</h3>
    <label>Phiên bản mới nhất (vd 1.1.0)</label><input id="gVer">
    <label>Link tải bộ cài (.exe)</label><input id="gUrl">
    <label>Ghi chú bản mới</label><input id="gNotes" placeholder="VD: Thêm nén PDF">
    <button style="margin-top:10px" onclick="saveGlobal()">Lưu</button>
    <div class="hint">Máy đang chạy phiên bản thấp hơn sẽ thấy nút “Cập nhật ngay”.</div>
  </div>
</div>

<div class="pane" id="pane-reports" style="display:none">
  <div class="card"><h3>Báo lỗi từ các máy</h3><div id="repBox"><div class="empty">Đang tải…</div></div></div>
</div>
</div>
<div class="flash" id="flash"></div>
<script>
const KEY = ${JSON.stringify(adminKey)};
const qs = "key=" + encodeURIComponent(KEY);
let STATE = null;
function flash(m){const f=document.getElementById('flash');f.textContent=m;f.classList.add('show');setTimeout(()=>f.classList.remove('show'),1800)}
function esc(s){return String(s==null?'':s).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]))}
function tdate(ms){if(!ms)return '—';const d=new Date(ms);return d.toLocaleString('vi-VN')}
async function api(p,body){const o={headers:{'Content-Type':'application/json'}};if(body){o.method='POST';o.body=JSON.stringify(body)}const r=await fetch(p+(p.includes('?')?'&':'?')+qs,o);return r.json()}
async function load(){STATE=await api('/admin/state');render()}
document.querySelectorAll('.tab').forEach(t=>t.onclick=()=>{
  document.querySelectorAll('.tab').forEach(x=>x.classList.remove('on'));t.classList.add('on');
  document.querySelectorAll('.pane').forEach(p=>p.style.display='none');
  document.getElementById('pane-'+t.dataset.t).style.display='block';
});
function render(){
  const g=STATE.global;
  document.getElementById('tgl').classList.toggle('on',g.enabled);
  document.getElementById('tglTxt').textContent=g.enabled?'ĐANG BẬT — mọi máy dùng được':'ĐANG TẮT — mọi máy bị khóa';
  document.getElementById('gMsg').value=g.message||'';
  document.getElementById('gVer').value=g.latest_version||'';
  document.getElementById('gUrl').value=g.download_url||'';
  document.getElementById('gNotes').value=g.notes||'';
  // keys
  const kb=document.getElementById('keysBox');
  if(!STATE.keys.length){kb.innerHTML='<div class="empty">Chưa có key nào. Bấm “+ Cấp key”.</div>'}
  else{
   kb.innerHTML='<table><tr><th>Key</th><th>Trạng thái</th><th>Máy / Người dùng</th><th>Kích hoạt</th><th>Ghi chú</th><th></th></tr>'+
   STATE.keys.map(k=>{
     let st=k.revoked?'<span class="pill p-rev">Đã khóa</span>':(k.machine?'<span class="pill p-use">Đang dùng</span>':'<span class="pill p-free">Chưa dùng</span>');
     const mach=k.machine?(esc(k.machine_name||'')+'<br><code>'+esc(k.machine)+'</code>'+(k.user?'<br>'+esc(k.user):'')):'—';
     const act='<div class="row-actions">'+
       (k.revoked?'<button class="sm" onclick="keyAct(\\''+k.key+'\\',\\'unrevoke\\')">Mở khóa</button>':'<button class="sm red" onclick="keyAct(\\''+k.key+'\\',\\'revoke\\')">Khóa</button>')+
       (k.machine?'<button class="sm gray" onclick="keyAct(\\''+k.key+'\\',\\'reset\\')">Gỡ máy</button>':'')+
       '<button class="sm gray" onclick="copyKey(\\''+k.key+'\\')">Chép</button>'+
       '<button class="sm gray" onclick="keyAct(\\''+k.key+'\\',\\'delete\\')">Xóa</button></div>';
     return '<tr><td><code>'+esc(k.key)+'</code></td><td>'+st+'</td><td>'+mach+'</td><td>'+tdate(k.activatedAt)+'</td><td>'+esc(k.note||'')+'</td><td>'+act+'</td></tr>';
   }).join('')+'</table>';
  }
  // blocked
  const bb=document.getElementById('blkBox');
  if(!STATE.blocked.length){bb.innerHTML='<div class="empty">Chưa chặn máy nào.</div>'}
  else{bb.innerHTML='<table><tr><th>Mã máy</th><th>Ghi chú</th><th>Lúc</th><th></th></tr>'+
    STATE.blocked.map(b=>'<tr><td><code>'+esc(b.machine)+'</code></td><td>'+esc(b.name||'')+'</td><td>'+tdate(b.at)+'</td><td><button class="sm gray" onclick="unblockM(\\''+b.machine+'\\')">Bỏ chặn</button></td></tr>').join('')+'</table>'}
  // reports
  const rb=document.getElementById('repBox');
  if(!STATE.reports.length){rb.innerHTML='<div class="empty">✅ Chưa có báo lỗi nào.</div>'}
  else{rb.innerHTML=STATE.reports.map(x=>{
    const c=x.kind==='error'?'k-err':'k-st';
    return '<div style="border-bottom:1px solid var(--line);padding:8px 0"><span class="kpill '+c+'">'+esc(x.kind).toUpperCase()+'</span><b>'+esc(x.machine)+' / '+esc(x.user)+'</b> <span class="hint">'+esc(x.ts)+' • v'+esc(x.version)+' • <code>'+esc(x.machine_id||'')+'</code></span>'+(x.detail?'<pre>'+esc(x.detail)+'</pre>':'')+'</div>';
  }).join('')}
}
async function issue(){
  const n=+document.getElementById('issueN').value||1;const note=document.getElementById('issueNote').value;
  const r=await api('/admin/issue',{n,note});
  if(r.ok){document.getElementById('newKeys').innerHTML='Đã cấp: '+r.keys.map(k=>'<code>'+k+'</code>').join(' ');flash('Đã cấp '+r.keys.length+' key');load()}
}
async function keyAct(k,action){
  if(action==='delete'&&!confirm('Xóa hẳn key '+k+' ?'))return;
  await api('/admin/key-action',{k,action});flash('Đã cập nhật key');load();
}
function copyKey(k){navigator.clipboard.writeText(k);flash('Đã chép '+k)}
async function toggleGlobal(){await api('/admin/set-global',{enabled:!STATE.global.enabled});flash('Đã đổi trạng thái');load()}
async function saveGlobal(){
  await api('/admin/set-global',{message:document.getElementById('gMsg').value,latest_version:document.getElementById('gVer').value,download_url:document.getElementById('gUrl').value,notes:document.getElementById('gNotes').value});
  flash('Đã lưu');load();
}
async function blockM(){const m=document.getElementById('blkM').value.trim();if(!m)return;await api('/admin/machine',{m,name:document.getElementById('blkN').value,action:'block'});flash('Đã chặn máy');document.getElementById('blkM').value='';load()}
async function unblockM(m){await api('/admin/machine',{m,action:'unblock'});flash('Đã bỏ chặn');load()}
load();
</script></body></html>`;
}
