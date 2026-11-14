// In-memory stand-ins for the Google Apps Script services Code.gs uses, so the real backend code
// can run under Node for tests and local preview. Only the methods Code.gs calls are implemented.
import fs from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';

export function loadBackend(dir) {
  const sheets = new Map(), files = new Map(), mails = [];

  const makeSheet = name => {
    const rows = [];
    const range = (r, c, nr = 1, nc = 1) => ({
      setNumberFormat() { return this; },
      setValues(vals) { vals.forEach((row, i) => { while (rows.length < r - 1 + i + 1) rows.push([]); row.forEach((v, j) => { rows[r - 1 + i][c - 1 + j] = v; }); }); return this; },
    });
    return {
      name, rows,
      appendRow(r) { rows.push([...r]); },
      setFrozenRows() {},
      getLastRow() { return rows.length; },
      deleteRow(n) { rows.splice(n - 1, 1); },
      getRange(a, b, c, d) { return typeof a === 'string' ? range(1, 1) : range(a, b, c, d); },
      getDataRange() { const w = Math.max(0, ...rows.map(r => r.length)); return { getValues: () => rows.map(r => Array.from({ length: w }, (_, i) => r[i] ?? '')) }; },
    };
  };
  const ss = {
    getSheetByName: n => sheets.get(n) || null,
    insertSheet: n => { const s = makeSheet(n); sheets.set(n, s); return s; },
    getSheets: () => [...sheets.values()],
    deleteSheet: s => sheets.delete(s.name),
  };
  const ctx = {
    console,
    SpreadsheetApp: { getActive: () => ss },
    DriveApp: {
      Access: { ANYONE_WITH_LINK: 'ANYONE_WITH_LINK' }, Permission: { VIEW: 'VIEW' },
      createFolder: () => ({ getId: () => 'folder-0000000001' }),
      getFolderById: () => ({
        createFile: blob => { const id = 'file-' + crypto.randomUUID().slice(0, 12); files.set(id, { ...blob, trashed: false });
          return { getId: () => id, setSharing() {} }; },
      }),
      getFileById: id => { const f = files.get(id); if (!f) throw new Error('no file'); return { setTrashed: v => { f.trashed = v; } }; },
    },
    Utilities: {
      getUuid: () => crypto.randomUUID(),
      base64Decode: s => Buffer.from(s, 'base64'),
      newBlob: (bytes, mime, name) => ({ bytes, mime, name }),
    },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    MailApp: { sendEmail: m => mails.push(m) },
    ScriptApp: { getOAuthToken: () => 'token' },
    // Stands in for Drive's OCR: "uploading" makes a temp file, "exporting" returns the canned text.
    UrlFetchApp: { fetch: url => { const up = url.includes('/upload/'); if (up) files.set('ocr-doc', { trashed: false });
      return { getResponseCode: () => 200, getContentText: () => up ? '{"id":"ocr-doc"}' : 'Vernier\nS/N: 17026692\n' }; } },
    Session: { getEffectiveUser: () => ({ getEmail: () => 'owner@example.com' }) },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: s => ({ body: s, setMimeType() { return this; } }) },
  };
  vm.createContext(ctx);
  // Apps Script shares one global scope across files; concatenating reproduces that.
  const src = ['Products.gs', 'Code.gs'].map(f => fs.readFileSync(`${dir}/${f}`, 'utf8')).join('\n') +
    '\n;globalThis.__api = { setup, doPost, doGet };';
  vm.runInContext(src, ctx, { filename: 'apps-script' });
  const api = ctx.__api;
  const post = body => JSON.parse(api.doPost({ postData: { contents: typeof body === 'string' ? body : JSON.stringify(body) } }).body);
  return { setup: api.setup, post, sheets, files, mails };
}
