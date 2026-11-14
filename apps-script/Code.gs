// Backend for the Vernier repair app. Bound to one Google Sheet (Extensions > Apps Script).
// Data: sheet "Tickets". Photos: a Drive folder. Settings: sheet "Config". Lists: "Products", "Staff".

const TICKET_COLS = ['id', 'createdAt', 'reporter', 'product', 'code', 'sn', 'snManual', 'customer', 'symptom',
  'urgent', 'status', 'tech', 'photos', 'found', 'method', 'check', 'reason', 'repairPhotos', 'finishedAt', 'updatedAt'];
const EDITABLE = ['reporter', 'product', 'code', 'sn', 'snManual', 'customer', 'symptom', 'urgent', 'photos'];
const STATUSES = ['wait', 'doing', 'done', 'fail'];

// ---------- one-time setup: run this from the editor once ----------
function setup() {
  const ss = SpreadsheetApp.getActive();
  const sheet = (name, header) => {
    let sh = ss.getSheetByName(name);
    if (!sh) { sh = ss.insertSheet(name); sh.appendRow(header); sh.setFrozenRows(1); }
    return sh;
  };
  const t = sheet('Tickets', TICKET_COLS);
  t.getRange('A:Z').setNumberFormat('@'); // keep S/N like "0F1009" and ISO dates as plain text

  const p = sheet('Products', ['code', 'name_en', 'name_th', 'category']);
  if (p.getLastRow() < 2) {
    p.getRange('A:D').setNumberFormat('@');
    p.getRange(2, 1, PRODUCTS_SEED.length, 4).setValues(PRODUCTS_SEED);
  }
  const s = sheet('Staff', ['name']);
  if (s.getLastRow() < 2) s.getRange(2, 1, 3, 1).setValues([['ช่างซ่อม'], ['พนักงาน 1'], ['พนักงาน 2']]); // replace with real names

  const c = sheet('Config', ['key', 'value', 'note']);
  if (c.getLastRow() < 2) {
    const folder = DriveApp.createFolder('Vernier แจ้งซ่อม - รูปภาพ');
    c.getRange('B:B').setNumberFormat('@');
    c.getRange(2, 1, 5, 3).setValues([
      ['username', 'admin', 'ชื่อผู้ใช้สำหรับล็อกอิน'],
      ['password', '1234', 'รหัสผ่าน เปลี่ยนได้ทุกเมื่อ'],
      ['notifyEmail', Session.getEffectiveUser().getEmail(), 'อีเมลที่รับแจ้งเตือนงานใหม่ ใส่หลายอีเมลคั่นด้วย ,'],
      ['appUrl', '', 'ลิงก์หน้าเว็บแอป (ใส่ในอีเมลแจ้งเตือน)'],
      ['folderId', folder.getId(), 'โฟลเดอร์เก็บรูปใน Google Drive อย่าแก้'],
    ]);
  }
  ['Sheet1', 'ชีต1'].forEach(n => { const x = ss.getSheetByName(n); if (x && ss.getSheets().length > 1 && x.getLastRow() === 0) ss.deleteSheet(x); });
}

// ---------- HTTP ----------
function doGet() { return json({ ok: true, service: 'vernier-repair' }); }

function doPost(e) {
  let req;
  try { req = JSON.parse(e.postData.contents); } catch (err) { return json({ ok: false, error: 'คำขอไม่ถูกต้อง' }); }
  try {
    const cfg = config();
    if (String(req.user || '') !== cfg.username || String(req.pass || '') !== cfg.password) {
      return json({ ok: false, error: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง', auth: false });
    }
    const fn = ACTIONS[req.action];
    if (!fn) return json({ ok: false, error: 'ไม่รู้จักคำสั่ง ' + req.action });
    return json(Object.assign({ ok: true }, fn(req, cfg)));
  } catch (err) {
    return json({ ok: false, error: String(err && err.message || err) });
  }
}

const ACTIONS = {
  login: () => ({}),
  bootstrap: () => ({ products: products(), staff: staff(), tickets: readTickets() }),
  list: () => ({ tickets: readTickets() }),

  upload: (req, cfg) => {
    const data = String(req.data || '');
    if (!data) throw new Error('ไม่มีไฟล์รูป');
    if (!/^image\//.test(req.mime || '')) throw new Error('รับเฉพาะไฟล์รูป');
    const blob = Utilities.newBlob(Utilities.base64Decode(data), req.mime, clean(req.name, 120) || 'photo.jpg');
    const file = DriveApp.getFolderById(cfg.folderId).createFile(blob);
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW); // so <img> can show the thumbnail
    return { fileId: file.getId() };
  },

  // Reads the text on a label photo with Google's OCR: Drive converts the image to a Doc,
  // we read the Doc's text back and trash it. Free, no API key.
  ocr: req => {
    const data = String(req.data || '');
    if (!data) throw new Error('ไม่มีไฟล์รูป');
    if (data.length > 3e6) throw new Error('รูปใหญ่เกินไป'); // Drive OCR accepts images up to 2 MB
    const opt = { headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() }, muteHttpExceptions: true };
    const fetch = (url, extra) => {
      const r = UrlFetchApp.fetch(url, Object.assign({}, opt, extra));
      if (r.getResponseCode() >= 300) throw new Error('อ่านข้อความไม่สำเร็จ: ' + r.getContentText().slice(0, 200));
      return r.getContentText();
    };
    const b = 'ocr' + Utilities.getUuid();
    const meta = JSON.stringify({ name: 'ocr-temp', mimeType: 'application/vnd.google-apps.document' });
    const id = JSON.parse(fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&ocrLanguage=en', {
      method: 'post', contentType: 'multipart/related; boundary=' + b,
      payload: `--${b}\r\nContent-Type: application/json\r\n\r\n${meta}\r\n--${b}\r\nContent-Type: image/jpeg\r\nContent-Transfer-Encoding: base64\r\n\r\n${data}\r\n--${b}--`,
    })).id;
    try { return { text: fetch(`https://www.googleapis.com/drive/v3/files/${id}/export?mimeType=text/plain`) }; }
    finally { DriveApp.getFileById(id).setTrashed(true); }
  },

  create: (req, cfg) => withLock(() => {
    const t = ticketFields(req.ticket || {});
    if (!t.photos) throw new Error('ต้องมีรูปอุปกรณ์อย่างน้อย 1 รูป');
    const now = new Date().toISOString();
    Object.assign(t, { id: Utilities.getUuid().slice(0, 8), createdAt: now, updatedAt: now, status: 'wait' });
    sheetT().appendRow(TICKET_COLS.map(k => toCell(t[k])));
    notify(t, cfg);
    return { ticket: t };
  }),

  update: (req) => withLock(() => {
    const { row, t } = findTicket(req.id);
    const patch = {}; EDITABLE.forEach(k => { if (req.ticket && k in req.ticket) patch[k] = req.ticket[k]; });
    Object.assign(t, ticketFields(Object.assign({}, t, patch)), { updatedAt: new Date().toISOString() });
    if (!t.photos) throw new Error('ต้องมีรูปอุปกรณ์อย่างน้อย 1 รูป');
    writeRow(row, t);
    return { ticket: t };
  }),

  take: (req) => withLock(() => {
    const { row, t } = findTicket(req.id);
    if (t.status !== 'wait') throw new Error('งานนี้ไม่ได้อยู่ในสถานะรอซ่อมแล้ว รีเฟรชหน้าเพื่อดูสถานะล่าสุด');
    t.tech = required(req.tech, 'ชื่อผู้ซ่อม', 60);
    t.status = 'doing'; t.updatedAt = new Date().toISOString();
    writeRow(row, t);
    return { ticket: t };
  }),

  finish: (req) => withLock(() => {
    const { row, t } = findTicket(req.id);
    if (t.status !== 'wait' && t.status !== 'doing') throw new Error('งานนี้ปิดไปแล้ว');
    const fail = req.status === 'fail';
    t.tech = required(req.tech, 'ชื่อผู้ซ่อม', 60);
    t.found = required(req.found, 'อาการที่พบจริง', 2000);
    if (fail) { t.reason = required(req.reason, 'เหตุผลที่ซ่อมไม่ได้', 2000); t.method = ''; t.check = ''; }
    else { t.method = required(req.method, 'วิธีซ่อม', 2000); t.check = required(req.check, 'วิธีตรวจเช็ค', 2000); t.reason = ''; }
    t.repairPhotos = ids(req.repairPhotos);
    t.status = fail ? 'fail' : 'done';
    t.finishedAt = t.updatedAt = new Date().toISOString();
    writeRow(row, t);
    return { ticket: t };
  }),

  delete: (req) => withLock(() => {
    const { row, t } = findTicket(req.id);
    // Drive trash keeps files 30 days, so a mistaken delete can still be recovered by hand.
    (t.photos + ',' + t.repairPhotos).split(',').filter(Boolean).forEach(id => {
      try { DriveApp.getFileById(id).setTrashed(true); } catch (err) { /* already gone */ }
    });
    sheetT().deleteRow(row);
    return { id: t.id };
  }),
};

// ---------- data helpers ----------
function sheetT() { return SpreadsheetApp.getActive().getSheetByName('Tickets'); }

function config() {
  const rows = SpreadsheetApp.getActive().getSheetByName('Config').getDataRange().getValues();
  const c = {}; rows.slice(1).forEach(r => { c[String(r[0]).trim()] = String(r[1]).trim(); });
  return c;
}
function products() {
  return SpreadsheetApp.getActive().getSheetByName('Products').getDataRange().getValues().slice(1)
    .filter(r => r[1]).map(r => ({ code: String(r[0]).trim(), name: String(r[1]).trim(), th: String(r[2]).trim(), cat: String(r[3]).trim() }));
}
function staff() {
  return SpreadsheetApp.getActive().getSheetByName('Staff').getDataRange().getValues().slice(1)
    .map(r => String(r[0]).trim()).filter(Boolean);
}
function readTickets() {
  return sheetT().getDataRange().getValues().slice(1).filter(r => r[0]).map(fromRow);
}
function fromRow(r) {
  const t = {};
  TICKET_COLS.forEach((k, i) => { const v = r[i]; t[k] = v instanceof Date ? v.toISOString() : String(v); });
  t.urgent = t.urgent === 'TRUE' || t.urgent === 'true';
  t.snManual = t.snManual === 'TRUE' || t.snManual === 'true';
  return t;
}
function toCell(v) { return typeof v === 'boolean' ? (v ? 'TRUE' : 'FALSE') : (v == null ? '' : String(v)); }
function writeRow(row, t) { sheetT().getRange(row, 1, 1, TICKET_COLS.length).setValues([TICKET_COLS.map(k => toCell(t[k]))]); }
function findTicket(id) {
  const vals = sheetT().getDataRange().getValues();
  for (let i = 1; i < vals.length; i++) if (String(vals[i][0]) === String(id)) return { row: i + 1, t: fromRow(vals[i]) };
  throw new Error('ไม่พบรายการนี้ อาจถูกลบไปแล้ว รีเฟรชหน้าเพื่อดูข้อมูลล่าสุด');
}

// Validates the fields a reporter fills in and returns only those. Used by create and update.
function ticketFields(x) {
  const snManual = x.snManual === true || x.snManual === 'true';
  const t = {
    reporter: required(x.reporter, 'ชื่อผู้แจ้ง', 60),
    product: required(x.product, 'ชื่ออุปกรณ์', 200),
    code: clean(x.code, 40),
    sn: clean(x.sn, 80),
    snManual: snManual,
    customer: clean(x.customer, 200),
    symptom: required(x.symptom, 'อาการเสีย', 2000),
    urgent: x.urgent === true || x.urgent === 'true',
    photos: ids(x.photos),
  };
  if (!snManual && !t.sn) throw new Error('กรุณากรอก S/N หรือเลือก "ไม่มี S/N"');
  return t;
}
function clean(v, max) { return String(v == null ? '' : v).trim().slice(0, max); }
function required(v, label, max) { const s = clean(v, max); if (!s) throw new Error('กรุณากรอก' + label); return s; }
function ids(v) {
  const list = Array.isArray(v) ? v : String(v || '').split(',');
  return list.map(s => String(s).trim()).filter(s => /^[\w-]{10,}$/.test(s)).slice(0, 8).join(',');
}
function withLock(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try { return fn(); } finally { lock.releaseLock(); }
}

function notify(t, cfg) {
  if (!cfg.notifyEmail) return;
  const esc = s => String(s || '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const subject = (t.urgent ? '🔴 ด่วน · ' : '') + 'แจ้งซ่อม: ' + t.product + (t.sn ? ' (' + t.sn + ')' : '');
  const html = '<p><b>' + esc(t.product) + '</b> ' + esc(t.code) + '</p>' +
    '<p>' + (t.snManual ? 'เลขระบุเอง' : 'S/N') + ': ' + esc(t.sn || '-') + '<br>ลูกค้า: ' + esc(t.customer || 'ของบริษัท') +
    '<br>ผู้แจ้ง: ' + esc(t.reporter) + '</p><p>อาการ: ' + esc(t.symptom) + '</p>' +
    (cfg.appUrl ? '<p><a href="' + esc(cfg.appUrl) + '#queue">เปิดหน้ารอซ่อม</a></p>' : '');
  try { MailApp.sendEmail({ to: cfg.notifyEmail, subject: subject, htmlBody: html }); }
  catch (err) { console.warn('ส่งอีเมลไม่สำเร็จ: ' + err); } // the ticket is already saved; email is best-effort
}

function json(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
