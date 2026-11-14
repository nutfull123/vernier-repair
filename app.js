'use strict';
// Vernier repair app. Talks to the Google Apps Script web app at window.API_URL (set in config.js).

const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9ก-๙]/g, '');
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* private mode */ } },
};
const fmt = iso => iso ? new Date(iso).toLocaleString('th-TH', { day: 'numeric', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit' }) : '-';
const ago = iso => {
  const m = (Date.now() - new Date(iso)) / 6e4;
  return m < 60 ? `${Math.max(1, Math.round(m))} นาทีที่แล้ว` : m < 1440 ? `${Math.round(m / 60)} ชม.ที่แล้ว` : `${Math.round(m / 1440)} วันที่แล้ว`;
};
const STATUS = { wait: ['รอซ่อม', 'p-wait'], doing: ['กำลังซ่อม', 'p-doing'], done: ['ซ่อมเสร็จ', 'p-done'], fail: ['ซ่อมไม่ได้', 'p-fail'] };
const isOpen = t => t.status === 'wait' || t.status === 'doing';
const photoIds = s => String(s || '').split(',').filter(Boolean);
// window.PHOTO_BASE is only set by the local preview server; production photos come from Google Drive.
const thumbUrl = id => window.PHOTO_BASE ? window.PHOTO_BASE + encodeURIComponent(id) : `https://drive.google.com/thumbnail?id=${encodeURIComponent(id)}&sz=w800`;
const fullUrl = id => window.PHOTO_BASE ? window.PHOTO_BASE + encodeURIComponent(id) : `https://drive.google.com/file/d/${encodeURIComponent(id)}/view`;

const state = { products: [], staff: [], tickets: [], loaded: false };

// ---------- API ----------
function creds() { try { return JSON.parse(store.get('creds') || 'null'); } catch { return null; } }
async function api(action, body = {}) {
  if (!window.API_URL) throw new Error('ยังไม่ได้ตั้งค่า API_URL ในไฟล์ config.js');
  const c = creds() || {};
  let res;
  try {
    // A plain-string body is sent as text/plain, which Apps Script accepts without a CORS preflight.
    res = await fetch(window.API_URL, { method: 'POST', body: JSON.stringify({ action, user: c.user, pass: c.pass, ...body }) });
  } catch {
    throw new Error('เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ ตรวจสอบอินเทอร์เน็ตแล้วลองอีกครั้ง');
  }
  let j;
  try { j = await res.json(); } catch { throw new Error(`เซิร์ฟเวอร์ตอบกลับผิดรูปแบบ (HTTP ${res.status})`); }
  if (!j.ok) {
    if (j.auth === false && action !== 'login') logout('รหัสผ่านถูกเปลี่ยน กรุณาเข้าสู่ระบบใหม่');
    throw new Error(j.error || 'เกิดข้อผิดพลาด');
  }
  return j;
}
function fileToBase64(file) {
  return new Promise((ok, fail) => {
    const r = new FileReader();
    r.onload = () => ok(String(r.result).split(',')[1]);
    r.onerror = () => fail(new Error('อ่านไฟล์รูปไม่ได้'));
    r.readAsDataURL(file);
  });
}
async function uploadAll(fileList, onStep) {
  const ids = [];
  for (let i = 0; i < fileList.length; i++) {
    onStep?.(i + 1, fileList.length);
    const f = fileList[i];
    const { fileId } = await api('upload', { name: f.name || `photo-${Date.now()}.jpg`, mime: f.type || 'image/jpeg', data: await fileToBase64(f) });
    ids.push(fileId);
  }
  return ids;
}
function upsert(t) { const i = state.tickets.findIndex(x => x.id === t.id); i >= 0 ? state.tickets.splice(i, 1, t) : state.tickets.push(t); }

// ---------- UI helpers ----------
function toast(msg) {
  const t = document.createElement('div'); t.className = 'toast'; t.textContent = msg;
  $('toastRoot').replaceChildren(t); setTimeout(() => t.remove(), 3500);
}
let lastFocus = null;
function openSheet(html, onReady) {
  lastFocus = document.activeElement;
  $('modalRoot').innerHTML = `<div class="scrim" id="scrim"><div class="sheet" role="dialog" aria-modal="true" aria-labelledby="sheetTitle">${html}</div></div>`;
  $('scrim').addEventListener('click', e => { if (e.target.id === 'scrim') closeSheet(); });
  onReady?.();
  $('modalRoot').querySelector('textarea,input,select,button')?.focus();
}
function closeSheet() { $('modalRoot').innerHTML = ''; lastFocus?.focus?.(); }
document.addEventListener('keydown', e => { if (e.key === 'Escape' && $('modalRoot').firstChild) closeSheet(); });
function confirmSheet({ title, html, ok, danger, onOk }) {
  openSheet(`<h2 id="sheetTitle">${title}</h2><div>${html}</div>
    <div class="row"><button class="btn ghost" id="mNo" type="button">ยกเลิก</button><button class="btn ${danger ? 'danger' : ''}" id="mOk" type="button">${ok}</button></div>`, () => {
    $('mNo').onclick = closeSheet;
    $('mOk').onclick = () => { closeSheet(); onOk(); };
  });
}
async function busy(btn, label, fn) {
  const old = btn.innerHTML; btn.disabled = true; btn.textContent = label;
  try { return await fn(m => { btn.textContent = m; }); } finally { btn.disabled = false; btn.innerHTML = old; }
}
const staffOptions = sel => state.staff.map(s => `<option ${s === sel ? 'selected' : ''}>${esc(s)}</option>`).join('');

// ---------- login ----------
$('loginForm').addEventListener('submit', async e => {
  e.preventDefault();
  const user = $('lu').value.trim(), pass = $('lp').value;
  $('loginErr').hidden = true;
  if (!user || !pass) { $('loginErr').textContent = 'กรอกชื่อผู้ใช้และรหัสผ่าน'; $('loginErr').hidden = false; return; }
  store.set('creds', JSON.stringify({ user, pass }));
  try {
    await busy($('loginBtn'), 'กำลังเข้าสู่ระบบ…', () => api('login'));
    $('lp').value = '';
    enterApp();
  } catch (err) {
    store.set('creds', null);
    $('loginErr').textContent = err.message; $('loginErr').hidden = false;
  }
});
function logout(msg) {
  store.set('creds', null);
  $('shell').hidden = true; $('v-login').hidden = false;
  if (msg) { $('loginErr').textContent = msg; $('loginErr').hidden = false; }
}
$('logout').onclick = () => confirmSheet({ title: 'ออกจากระบบ?', html: 'ต้องใส่รหัสผ่านใหม่เมื่อกลับเข้ามา', ok: 'ออกจากระบบ', onOk: () => logout() });

async function enterApp() {
  $('v-login').hidden = true; $('shell').hidden = false;
  route();
  await refresh(true);
}
async function refresh(full) {
  $('refreshBtn').classList.add('spin');
  try {
    const j = await api(full || !state.loaded ? 'bootstrap' : 'list');
    if (j.products) { state.products = j.products; state.staff = j.staff; fillReporter(); }
    state.tickets = j.tickets; state.loaded = true;
    render();
  } catch (err) { toast(err.message); }
  finally { $('refreshBtn').classList.remove('spin'); }
}
$('refreshBtn').onclick = () => refresh(true);

// ---------- routing (#home #report #queue #history) ----------
const TITLES = { home: 'หน้าแรก', report: 'แจ้งของพัง', queue: 'อุปกรณ์รอซ่อม', history: 'ประวัติการซ่อม' };
let view = 'home';
function route() {
  const v = location.hash.slice(1);
  view = TITLES[v] ? v : 'home';
  for (const k of Object.keys(TITLES)) $('v-' + k).hidden = k !== view;
  if (view !== 'report' && editing) { editing = null; resetForm(); }
  $('title').textContent = view === 'report' && editing ? 'แก้ไขใบแจ้งซ่อม' : TITLES[view];
  $('backBtn').hidden = view === 'home';
  document.querySelectorAll('.in-tabs a').forEach(a => a.setAttribute('aria-current', a.getAttribute('href') === '#' + view ? 'page' : 'false'));
  render();
  window.scrollTo(0, 0);
}
window.addEventListener('hashchange', route);
$('backBtn').onclick = () => { location.hash = 'home'; };

// ---------- render ----------
function render() {
  const open = state.tickets.filter(isOpen), urgent = open.filter(t => t.urgent).length;
  $('today').textContent = new Date().toLocaleDateString('th-TH', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  $('cQueue').textContent = state.loaded ? open.length : '–';
  $('cHist').textContent = state.loaded ? state.tickets.length - open.length : '–';
  $('urgentAlert').hidden = !urgent;
  $('urgentText').textContent = `มีงานด่วน ${urgent} รายการรอซ่อมอยู่ · แตะเพื่อดู`;
  $('navBadge').textContent = open.length; $('navBadge').hidden = !open.length;
  if (view === 'queue') renderQueue();
  if (view === 'history') renderHistory();
}
const skeleton = '<div class="skeleton"></div>'.repeat(3);

function photosHtml(ids, label) {
  return ids.length ? `<div class="thumbs">${ids.map((id, i) =>
    `<a href="${fullUrl(id)}" target="_blank" rel="noopener"><img src="${thumbUrl(id)}" alt="${esc(label)} รูปที่ ${i + 1}" loading="lazy" referrerpolicy="no-referrer"></a>`).join('')}</div>` : '';
}
function detailHtml(t) {
  const done = t.status === 'done', fail = t.status === 'fail';
  return `<dl class="kv">
      <dt>${t.snManual ? 'เลขระบุเอง' : 'S/N'}</dt><dd class="mono">${esc(t.sn) || '-'}</dd>
      <dt>รหัสสินค้า</dt><dd class="mono">${esc(t.code) || '-'}</dd>
      <dt>ลูกค้า</dt><dd>${esc(t.customer) || 'ของบริษัท'}</dd>
      <dt>ผู้แจ้ง</dt><dd>${esc(t.reporter)} · ${fmt(t.createdAt)}</dd>
      ${t.tech && !done && !fail ? `<dt>ผู้ซ่อม</dt><dd>${esc(t.tech)}</dd>` : ''}
    </dl>
    <div class="log"><b>อาการที่แจ้ง</b>${esc(t.symptom)}</div>
    ${photosHtml(photoIds(t.photos), t.product)}
    ${done || fail ? `<div class="log"><b>บันทึกการซ่อม · ${esc(t.tech)} · ${fmt(t.finishedAt)}</b><span><span class="muted">อาการที่พบจริง:</span> ${esc(t.found)}</span>${fail
      ? `<span><span class="muted">เหตุผลที่ซ่อมไม่ได้:</span> ${esc(t.reason)}</span>`
      : `<span><span class="muted">วิธีซ่อม:</span> ${esc(t.method)}</span><span><span class="muted">ตรวจเช็คหลังซ่อม:</span> ${esc(t.check)}</span>`}</div>
      ${photosHtml(photoIds(t.repairPhotos), 'หลังซ่อม')}` : ''}`;
}
function cardHtml(t, actions) {
  const [label, cls] = STATUS[t.status] || STATUS.wait, urgent = t.urgent && isOpen(t);
  return `<details class="card ${urgent ? 'urgent' : ''}" data-card="${esc(t.id)}"><summary>
      <span class="name">${esc(t.product)}</span><span class="pill ${cls}">${label}</span>
      <span class="meta">${urgent ? '<span class="pill p-urgent">ด่วน</span>' : ''}<span class="mono">${esc(t.sn) || 'ไม่มี S/N'}</span><span>${esc(t.customer) || 'ของบริษัท'}</span><span>${isOpen(t) ? ago(t.createdAt) : 'เสร็จ ' + fmt(t.finishedAt)}</span></span>
    </summary><div class="body">${detailHtml(t)}<div class="row">${actions(t)}</div></div></details>`;
}
function keepOpen(container, fn) {
  const open = new Set([...container.querySelectorAll('details[open]')].map(d => d.dataset.card));
  fn();
  open.forEach(id => container.querySelector(`details[data-card="${CSS.escape(id)}"]`)?.setAttribute('open', ''));
}
function renderQueue() {
  const box = $('queueList');
  if (!state.loaded) { box.innerHTML = skeleton; return; }
  const list = state.tickets.filter(isOpen).sort((a, b) => (b.urgent - a.urgent) || a.createdAt.localeCompare(b.createdAt));
  keepOpen(box, () => {
    box.innerHTML = list.length ? list.map(t => cardHtml(t, t =>
      (t.status === 'wait'
        ? `<button class="btn sm" data-act="take" data-id="${esc(t.id)}">รับงาน</button>`
        : `<button class="btn sm" data-act="done" data-id="${esc(t.id)}">ซ่อมเสร็จ</button><button class="btn sm ghost" data-act="fail" data-id="${esc(t.id)}">ซ่อมไม่ได้</button>`) +
      `<button class="btn sm ghost" data-act="edit" data-id="${esc(t.id)}">แก้ไข</button><button class="btn sm ghost danger-text" data-act="del" data-id="${esc(t.id)}">ลบ</button>`)).join('')
      : '<p class="empty"><img src="icons/mascot.png" width="400" height="320" alt="">ไม่มีงานค้าง</p>';
  });
}
let histStatus = 'all';
function renderHistory() {
  const box = $('histList');
  if (!state.loaded) { box.innerHTML = skeleton; $('histCount').textContent = ''; return; }
  const q = norm($('hq').value), from = $('hFrom').value, to = $('hTo').value;
  const day = iso => { const d = new Date(iso); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  const list = state.tickets.filter(t => !isOpen(t) && (histStatus === 'all' || t.status === histStatus)
    && (!q || norm(t.product + t.code + t.sn + t.customer).includes(q))
    && (!from || day(t.finishedAt) >= from) && (!to || day(t.finishedAt) <= to))
    .sort((a, b) => b.finishedAt.localeCompare(a.finishedAt));
  $('histCount').textContent = `พบ ${list.length} รายการ`;
  keepOpen(box, () => {
    box.innerHTML = list.length ? list.map(t => cardHtml(t, t =>
      `<button class="btn sm ghost danger-text" data-act="del" data-id="${esc(t.id)}">ลบ</button>`)).join('')
      : '<p class="empty">ไม่พบรายการที่ตรงกับตัวกรอง</p>';
  });
}
['hq', 'hFrom', 'hTo'].forEach(id => $(id).addEventListener('input', renderHistory));
document.querySelectorAll('.seg button').forEach(b => b.onclick = () => {
  histStatus = b.dataset.st;
  document.querySelectorAll('.seg button').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
  renderHistory();
});

// ---------- queue actions ----------
document.addEventListener('click', e => {
  const b = e.target.closest('[data-act]'); if (!b) return;
  const t = state.tickets.find(x => x.id === b.dataset.id); if (!t) return;
  ({ take: takeJob, done: finishJob, fail: finishJob, del: deleteJob, edit: editJob })[b.dataset.act](t, b.dataset.act);
});
function takeJob(t) {
  openSheet(`<h2 id="sheetTitle">รับงาน</h2><p>${esc(t.product)} · <span class="mono">${esc(t.sn) || 'ไม่มี S/N'}</span></p>
    <label class="f">ผู้ซ่อม<select class="in" id="mTech">${staffOptions(store.get('tech'))}</select></label>
    <p class="err" id="mErr" role="alert" hidden></p>
    <div class="row"><button class="btn ghost" id="mNo" type="button">ยกเลิก</button><button class="btn" id="mOk" type="button">เริ่มซ่อม</button></div>`, () => {
    $('mNo').onclick = closeSheet;
    $('mOk').onclick = () => busy($('mOk'), 'กำลังบันทึก…', async () => {
      try {
        const { ticket } = await api('take', { id: t.id, tech: $('mTech').value });
        store.set('tech', ticket.tech); upsert(ticket); closeSheet(); render(); toast('เปลี่ยนสถานะเป็น "กำลังซ่อม" แล้ว');
      } catch (err) { $('mErr').textContent = err.message; $('mErr').hidden = false; }
    });
  });
}
function finishJob(t, act) {
  const fail = act === 'fail';
  let repairFiles = [];
  openSheet(`<h2 id="sheetTitle">${fail ? 'บันทึก: ซ่อมไม่ได้' : 'บันทึกการซ่อม'}</h2>
    <p class="muted">${esc(t.product)} · <span class="mono">${esc(t.sn) || 'ไม่มี S/N'}</span></p>
    <label class="f">อาการที่พบจริง <textarea class="in" id="mFound"></textarea></label>
    ${fail ? '<label class="f">เหตุผลที่ซ่อมไม่ได้ <textarea class="in" id="mReason" placeholder="เช่น ไม่มีอะไหล่, เสียหายเกินซ่อม"></textarea></label>'
      : `<label class="f">วิธีซ่อม <textarea class="in" id="mMethod"></textarea></label>
         <label class="f">วิธีตรวจเช็คหลังซ่อม <textarea class="in" id="mCheck" placeholder="เช่น เทียบค่ากับตุ้มน้ำหนักมาตรฐาน, ทดสอบเชื่อมต่อ 10 นาที"></textarea></label>`}
    <div class="shot extra"><b id="mPhotoLabel">รูปหลังซ่อม</b><span class="hint">ไม่บังคับ</span>
      <div class="pick"><label class="pb"><svg aria-hidden="true"><use href="#i-camera"/></svg>ถ่ายรูป<input type="file" accept="image/*" capture="environment" id="mCam"></label>
      <label class="pb"><svg aria-hidden="true"><use href="#i-image"/></svg>แนบรูป<input type="file" accept="image/*" multiple id="mLib"></label></div></div>
    <label class="f">ผู้ซ่อม <select class="in" id="mTech">${staffOptions(t.tech || store.get('tech'))}</select></label>
    <p class="err" id="mErr" role="alert" hidden></p>
    <div class="row"><button class="btn ghost" id="mNo" type="button">ยกเลิก</button><button class="btn" id="mOk" type="button">${fail ? 'ย้ายไปประวัติ' : 'ซ่อมเสร็จ ย้ายไปประวัติ'}</button></div>`, () => {
    const addFiles = e => { repairFiles = [...repairFiles, ...e.target.files].slice(0, 3); e.target.value = ''; $('mPhotoLabel').textContent = `รูปหลังซ่อม ${repairFiles.length}/3 รูป`; };
    $('mCam').onchange = addFiles; $('mLib').onchange = addFiles;
    $('mNo').onclick = closeSheet;
    $('mOk').onclick = () => {
      const v = id => $(id)?.value.trim() || '';
      const missing = fail ? [['mFound', 'อาการที่พบจริง'], ['mReason', 'เหตุผล']] : [['mFound', 'อาการที่พบจริง'], ['mMethod', 'วิธีซ่อม'], ['mCheck', 'วิธีตรวจเช็ค']];
      const empty = missing.filter(([id]) => !v(id));
      missing.forEach(([id]) => $(id).setAttribute('aria-invalid', String(!v(id))));
      if (empty.length) { $('mErr').textContent = 'ยังไม่ได้กรอก: ' + empty.map(x => x[1]).join(', '); $('mErr').hidden = false; $(empty[0][0]).focus(); return; }
      busy($('mOk'), 'กำลังบันทึก…', async step => {
        try {
          const repairPhotos = await uploadAll(repairFiles, (i, n) => step(`กำลังส่งรูป ${i}/${n}…`));
          step('กำลังบันทึก…');
          const { ticket } = await api('finish', { id: t.id, status: fail ? 'fail' : 'done', found: v('mFound'), method: v('mMethod'), check: v('mCheck'), reason: v('mReason'), tech: v('mTech'), repairPhotos });
          store.set('tech', ticket.tech); upsert(ticket); closeSheet(); render();
          toast(fail ? 'บันทึกว่าซ่อมไม่ได้แล้ว ย้ายไปหน้าประวัติ' : 'บันทึกการซ่อมแล้ว ย้ายไปหน้าประวัติ');
        } catch (err) { $('mErr').textContent = err.message; $('mErr').hidden = false; }
      });
    };
  });
}
function deleteJob(t) {
  confirmSheet({
    title: 'ลบรายการนี้?', danger: true, ok: 'ลบ',
    html: `<p><b>${esc(t.product)}</b> <span class="mono">${esc(t.sn)}</span></p><p class="muted">ข้อมูลและบันทึกการซ่อมจะหายจากระบบ ส่วนรูปจะอยู่ในถังขยะของ Google Drive อีก 30 วัน</p>`,
    onOk: async () => {
      try { await api('delete', { id: t.id }); state.tickets = state.tickets.filter(x => x.id !== t.id); render(); toast('ลบแล้ว'); }
      catch (err) { toast(err.message); }
    },
  });
}

// ---------- product search ----------
function bigrams(s) { const a = []; for (let i = 0; i < s.length - 1; i++) a.push(s.slice(i, i + 2)); return a; }
function dice(a, b) {
  if (a.length < 2 || b.length < 2) return 0;
  const A = bigrams(a), pool = bigrams(b), total = A.length + pool.length; let m = 0;
  for (const x of A) { const i = pool.indexOf(x); if (i >= 0) { m++; pool.splice(i, 1); } }
  return 2 * m / total;
}
function searchProducts(q) {
  const n = norm(q); if (!n) return { hits: [], guess: null };
  const hits = state.products.filter(p => norm(p.name + p.code + p.th).includes(n));
  if (hits.length) {
    const starts = p => norm(p.name).startsWith(n) || norm(p.code).startsWith(n) ? 0 : 1;
    return { hits: hits.sort((a, b) => starts(a) - starts(b)).slice(0, 12), guess: null };
  }
  // No substring match: look for a likely typo against the code and every 1–3 word run of the name.
  const scored = state.products.map(p => {
    const words = p.name.toLowerCase().split(/\s+/), cands = [norm(p.code), norm(p.name)];
    for (let i = 0; i < words.length; i++) for (let j = i + 1; j <= Math.min(words.length, i + 3); j++) cands.push(norm(words.slice(i, j).join('')));
    return { p, s: Math.max(...cands.map(c => dice(n, c))) };
  }).filter(x => x.s >= 0.45).sort((a, b) => b.s - a.s);
  return { hits: [], guesses: scored.slice(0, 3).map(x => x.p) };
}

// ---------- report form ----------
let editing = null, chosen = null, files = { f1: null, f2: null, f3: [] }, dupOk = false, snAuto = '';
const pq = $('pq'), sugg = $('sugg');
function fillReporter() {
  const cur = $('reporter').value || store.get('reporter') || '';
  $('reporter').innerHTML = '<option value="">เลือกชื่อ</option>' + staffOptions(cur);
}
function pick(p) {
  chosen = p; pq.value = ''; closeSugg(); $('dym').hidden = true; pq.hidden = true; pq.removeAttribute('aria-invalid');
  $('picked').hidden = false;
  $('picked').innerHTML = `<span><b>${esc(p.name)}</b><br><span class="code">${esc(p.code || 'ไม่อยู่ในรายการสินค้า')}</span></span><button type="button" class="btn sm ghost" id="unpick">เปลี่ยน</button>`;
  $('unpick').onclick = () => { chosen = null; $('picked').hidden = true; pq.hidden = false; pq.focus(); };
}
function closeSugg() { sugg.hidden = true; pq.setAttribute('aria-expanded', 'false'); pq.removeAttribute('aria-activedescendant'); }
pq.addEventListener('input', () => {
  const { hits, guesses = [] } = searchProducts(pq.value);
  sugg.innerHTML = hits.map((p, i) => `<div role="option" id="opt${i}" data-code="${esc(p.code)}" aria-selected="false"><span>${esc(p.name)}${p.th && p.th !== p.name ? `<span class="th">${esc(p.th)}</span>` : ''}</span><span class="code">${esc(p.code)}</span></div>`).join('');
  sugg.hidden = !hits.length; pq.setAttribute('aria-expanded', String(!!hits.length));
  const d = $('dym'); d.hidden = !(pq.value.trim().length >= 3 && !hits.length);
  if (!d.hidden) {
    d.innerHTML = guesses.length
      ? 'คุณหมายถึงตัวไหน?' + guesses.map(g => `<br><button type="button" class="linkish" data-guess="${esc(g.code)}">${esc(g.name)} (${esc(g.code)})</button>`).join('')
      : 'ไม่พบชื่อนี้ในรายการสินค้า ถ้าเป็นรุ่นเก่า ส่งด้วยชื่อที่พิมพ์ได้ ระบบจะถามยืนยันก่อนส่ง';
    d.querySelectorAll('[data-guess]').forEach(b => { b.onclick = () => pick(state.products.find(p => p.code === b.dataset.guess)); });
  }
});
pq.addEventListener('keydown', e => {
  const opts = [...sugg.querySelectorAll('[role="option"]')]; if (sugg.hidden || !opts.length) return;
  let i = opts.findIndex(o => o.getAttribute('aria-selected') === 'true');
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault(); i = (i + (e.key === 'ArrowDown' ? 1 : -1) + opts.length) % opts.length;
    opts.forEach((o, k) => o.setAttribute('aria-selected', String(k === i))); pq.setAttribute('aria-activedescendant', opts[i].id); opts[i].scrollIntoView({ block: 'nearest' });
  } else if (e.key === 'Enter' && i >= 0) { e.preventDefault(); pick(state.products.find(p => p.code === opts[i].dataset.code)); }
  else if (e.key === 'Escape') closeSugg();
});
sugg.addEventListener('click', e => { const o = e.target.closest('[data-code]'); if (o) pick(state.products.find(p => p.code === o.dataset.code)); });
document.addEventListener('click', e => { if (!e.target.closest('.combo')) closeSugg(); });

function setShot(id, file) {
  const el = $(id); el.querySelector('img')?.remove(); el.classList.toggle('has', !!file); el.classList.remove('missing');
  if (file) { const img = document.createElement('img'); img.alt = ''; img.src = URL.createObjectURL(file); el.prepend(img); }
}
$('reportForm').addEventListener('change', e => {
  const slot = e.target.dataset?.slot; if (!slot) return;
  const picked = [...e.target.files]; e.target.value = ''; // reset so the same photo can be chosen again
  if (!picked.length) return;
  if (slot === 'f3') { files.f3 = [...files.f3, ...picked].slice(0, 3); $('s3label').textContent = `รูปเพิ่มเติม ${files.f3.length}/3 รูป`; return; }
  files[slot] = picked[0]; setShot(slot === 'f1' ? 's1' : 's2', picked[0]);
  if (slot === 'f2') readBarcode(picked[0]);
});

// ---------- barcode from the S/N photo ----------
async function readBarcode(file) {
  const hint = $('snHint');
  hint.innerHTML = '<span class="chip warn">กำลังอ่านบาร์โค้ด…</span>';
  let text = null;
  try { text = await decodeBarcode(file); } catch { /* fall through to manual entry */ }
  if (!text) {
    hint.innerHTML = '<span class="chip warn">อ่านบาร์โค้ดไม่ได้</span> พิมพ์ S/N จากฉลากเอง หรือถ่ายใหม่ให้บาร์โค้ดชัดและเต็มกรอบ';
    return;
  }
  // Fill only if the field is empty or still holds a previous auto-read, so we never overwrite what someone typed.
  if (!$('sn').value.trim() || $('sn').value === snAuto) { $('sn').value = text; snAuto = text; }
  hint.innerHTML = `<span class="chip ok"><svg aria-hidden="true"><use href="#i-check"/></svg>อ่านได้ ${esc(text)}</span> ตรวจกับฉลากอีกครั้ง ถ้าผิดแก้ในช่องนี้ได้เลย`;
  dupOk = false; checkDup();
}
async function decodeBarcode(file) {
  const bmp = await createImageBitmap(file);
  try {
    if ('BarcodeDetector' in window) { // Android Chrome has a native reader; iPhone does not, so ZXing covers the rest
      try { const r = await new window.BarcodeDetector().detect(bmp); if (r[0]?.rawValue) return r[0].rawValue.trim(); } catch { /* use ZXing */ }
    }
    if (!window.ZXing) return null;
    for (const max of [1600, 1000, 2400]) for (const rot of [0, 90]) {
      const t = zxingDecode(bmp, max, rot); if (t) return t;
    }
    return null;
  } finally { bmp.close?.(); }
}
function zxingDecode(bmp, max, rot) {
  const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const w = Math.round(bmp.width * scale), h = Math.round(bmp.height * scale);
  const c = document.createElement('canvas'); c.width = rot ? h : w; c.height = rot ? w : h;
  const g = c.getContext('2d', { willReadFrequently: true });
  if (rot) { g.translate(h, 0); g.rotate(Math.PI / 2); }
  g.drawImage(bmp, 0, 0, w, h);
  try {
    const Z = window.ZXing, hints = new Map([[Z.DecodeHintType.TRY_HARDER, true]]);
    const reader = new Z.MultiFormatReader(); reader.setHints(hints);
    return reader.decode(new Z.BinaryBitmap(new Z.HybridBinarizer(new Z.HTMLCanvasElementLuminanceSource(c)))).getText().trim();
  } catch { return null; }
}

// ---------- S/N and duplicates ----------
function applyNoSN() {
  const no = $('noSN').checked;
  $('s2').hidden = no; $('snReq').hidden = no;
  $('snLabel').textContent = no ? 'เลขระบุเอง (ไม่บังคับ)' : 'S/N';
  $('sn').placeholder = no ? 'เช่น เลขที่เขียนบนถุงซิป A-17' : 'ถ่ายรูปฉลาก ② แล้วระบบจะกรอกให้';
  $('snHint').textContent = no ? 'ใช้เลขนี้ค้นหาและเช็กงานซ้ำแทน S/N' : 'ระบบอ่านบาร์โค้ดจากรูป ② ให้ ถ้าอ่านผิดแก้ในช่องนี้ได้เลย';
  checkDup();
}
$('noSN').onchange = applyNoSN;
$('sn').addEventListener('input', () => { dupOk = false; $('sn').removeAttribute('aria-invalid'); checkDup(); });
$('urgent').onchange = () => $('ugWrap').classList.toggle('on', $('urgent').checked);
function checkDup() {
  const sn = norm($('sn').value), box = $('dupWarn');
  const same = sn ? state.tickets.filter(t => t !== editing && norm(t.sn) === sn) : [];
  box.hidden = !same.length;
  if (!same.length) { dupOk = true; box.innerHTML = ''; return; }
  const live = same.filter(isOpen), past = same.filter(t => !isOpen(t));
  box.innerHTML = (live.length ? `<div class="warn hard"><b>เครื่องนี้มีงานค้างอยู่แล้ว</b>${live.map(t => `<span>${esc(t.product)} · ${STATUS[t.status][0]} · แจ้งเมื่อ ${fmt(t.createdAt)}<br><span class="muted">"${esc(t.symptom)}"</span></span>`).join('')}</div>` : '')
    + (past.length ? `<div class="warn soft"><b>เครื่องนี้เคยซ่อมมาแล้ว ${past.length} ครั้ง</b>${past.map(t => `<span>${fmt(t.finishedAt)} · ${STATUS[t.status][0]}<br><span class="muted">${esc(t.found)} → ${esc(t.status === 'fail' ? t.reason : t.method)}</span></span>`).join('')}</div>` : '')
    + `<label class="check"><input type="checkbox" id="dupConfirm" ${dupOk ? 'checked' : ''}> ยืนยันส่งซ้ำ เครื่องนี้เสียจริงอีกครั้ง</label>`;
  $('dupConfirm').onchange = e => { dupOk = e.target.checked; };
}

function resetForm() {
  $('reportForm').reset(); chosen = null; files = { f1: null, f2: null, f3: [] }; dupOk = false; snAuto = '';
  setShot('s1', null); setShot('s2', null); $('s3label').textContent = 'รูปเพิ่มเติม';
  $('picked').hidden = true; pq.hidden = false; $('dym').hidden = true; $('formErr').hidden = true; $('ugWrap').classList.remove('on');
  $('oldPhotos').hidden = true; $('oldPhotos').innerHTML = ''; $('s1').classList.add('req-shot'); $('s2').classList.add('req-shot');
  document.querySelectorAll('#reportForm [aria-invalid]').forEach(el => el.removeAttribute('aria-invalid'));
  $('reporter').value = store.get('reporter') || '';
  $('submitBtn').textContent = 'ส่งแจ้งซ่อม'; $('cancelEdit').hidden = true;
  applyNoSN();
}
function editJob(t) {
  editing = t; location.hash = 'report'; resetForm(); editing = t;
  $('title').textContent = 'แก้ไขใบแจ้งซ่อม';
  $('reporter').value = t.reporter;
  pick(state.products.find(p => p.code && p.code === t.code) || { name: t.product, code: t.code });
  $('noSN').checked = t.snManual; applyNoSN();
  $('sn').value = t.sn; $('customer').value = t.customer; $('symptom').value = t.symptom;
  $('urgent').checked = t.urgent; $('ugWrap').classList.toggle('on', t.urgent);
  $('s1').classList.remove('req-shot'); $('s2').classList.remove('req-shot');
  const old = photoIds(t.photos);
  $('oldPhotos').hidden = !old.length; $('oldPhotos').innerHTML = old.length ? photosHtml(old, t.product).replace(/^<div class="thumbs">|<\/div>$/g, '') : '';
  $('submitBtn').textContent = 'บันทึกการแก้ไข'; $('cancelEdit').hidden = false;
  dupOk = true; checkDup();
}
$('cancelEdit').onclick = () => { editing = null; resetForm(); location.hash = 'queue'; };

$('reportForm').addEventListener('submit', e => {
  e.preventDefault();
  const no = $('noSN').checked, typed = pq.value.trim(), errs = [];
  const bad = (id, msg) => { errs.push([id, msg]); $(id)?.setAttribute('aria-invalid', 'true'); };
  if (!$('reporter').value) bad('reporter', 'เลือกชื่อผู้แจ้ง');
  if (!chosen && !typed) bad('pq', 'ใส่ชื่ออุปกรณ์');
  if (!editing && !files.f1) { errs.push(['s1', 'ถ่ายรูปอุปกรณ์ทั้งตัว ①']); $('s1').classList.add('missing'); }
  if (!editing && !no && !files.f2) { errs.push(['s2', 'ถ่ายรูปฉลาก S/N ② หรือติ๊ก "เครื่องนี้ไม่มี S/N"']); $('s2').classList.add('missing'); }
  if (!no && !$('sn').value.trim()) bad('sn', 'กรอก S/N');
  if (!$('symptom').value.trim()) bad('symptom', 'กรอกอาการเสีย');
  if (!$('dupWarn').hidden && !dupOk) errs.push(['dupWarn', 'ติ๊ก "ยืนยันส่งซ้ำ" หรือแก้ S/N']);
  const box = $('formErr');
  box.hidden = !errs.length;
  if (errs.length) {
    box.innerHTML = 'ยังส่งไม่ได้ ขาดข้อมูลต่อไปนี้<ul>' + errs.map(([id, m]) => `<li><a href="#${id}" data-jump="${id}">${esc(m)}</a></li>`).join('') + '</ul>';
    box.focus(); return;
  }
  const doSave = () => save(chosen || { name: typed, code: '' }, no);
  if (!chosen) confirmSheet({ title: 'ไม่พบชื่อนี้ในรายการสินค้า', html: `ส่งด้วยชื่อ <b>"${esc(typed)}"</b> ใช่ไหม?<br><span class="muted">ใช้กับรุ่นเก่าที่ไม่มีในเว็บแล้ว</span>`, ok: 'ใช่ ส่งเลย', onOk: doSave });
  else doSave();
});
$('formErr').addEventListener('click', e => {
  const a = e.target.closest('[data-jump]'); if (!a) return;
  e.preventDefault(); const el = $(a.dataset.jump); el.scrollIntoView({ block: 'center' }); (el.matches('input,select,textarea') ? el : el.querySelector('input'))?.focus();
});
['reporter', 'symptom'].forEach(id => $(id).addEventListener('input', () => $(id).removeAttribute('aria-invalid')));

async function save(product, noSN) {
  const ticket = {
    reporter: $('reporter').value, product: product.name, code: product.code, sn: $('sn').value.trim(), snManual: noSN,
    customer: $('customer').value.trim(), symptom: $('symptom').value.trim(), urgent: $('urgent').checked,
  };
  const newFiles = [files.f1, noSN ? null : files.f2, ...files.f3].filter(Boolean);
  await busy($('submitBtn'), 'กำลังส่ง…', async step => {
    try {
      const ids = await uploadAll(newFiles, (i, n) => step(`กำลังส่งรูป ${i}/${n}…`));
      step('กำลังบันทึก…');
      store.set('reporter', ticket.reporter);
      if (editing) {
        ticket.photos = [...photoIds(editing.photos), ...ids].join(',');
        const r = await api('update', { id: editing.id, ticket }); upsert(r.ticket);
        editing = null; toast('บันทึกการแก้ไขแล้ว');
      } else {
        ticket.photos = ids.join(',');
        const r = await api('create', { ticket }); upsert(r.ticket);
        toast(ticket.urgent ? 'ส่งแล้ว แจ้งช่างทางอีเมลแบบด่วน' : 'ส่งแล้ว แจ้งช่างทางอีเมลแล้ว');
      }
      resetForm(); location.hash = 'queue';
    } catch (err) {
      $('formErr').innerHTML = esc(err.message) + '<br>ข้อมูลในฟอร์มยังอยู่ กดส่งอีกครั้งได้'; $('formErr').hidden = false; $('formErr').focus();
    }
  });
}

// ---------- start ----------
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => { /* app still works online */ });
resetForm();
if (creds()) enterApp(); else { $('v-login').hidden = false; $('lu').value = 'admin'; }
