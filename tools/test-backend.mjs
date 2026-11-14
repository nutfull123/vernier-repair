// Runs the real Code.gs against in-memory fakes and checks the main flows. Run: node tools/test-backend.mjs
import assert from 'node:assert/strict';
import { loadBackend } from './fake-gas.mjs';

const b = loadBackend(new URL('../apps-script', import.meta.url).pathname);
b.setup();
const auth = { user: 'admin', pass: '1234' };
const call = (action, body = {}) => b.post({ action, ...auth, ...body });

// login
assert.equal(b.post({ action: 'login', user: 'admin', pass: 'x' }).ok, false, 'wrong password rejected');
assert.equal(b.post({ action: 'login', user: 'admin', pass: 'x' }).auth, false);
assert.equal(call('login').ok, true);
assert.equal(b.post('not json').ok, false);

// bootstrap
const boot = call('bootstrap');
assert.ok(boot.products.length > 150, 'products seeded');
assert.ok(boot.products.some(p => p.code === 'LABQ3'));
assert.equal(boot.tickets.length, 0);

// upload + create
const up = call('upload', { name: 'a.jpg', mime: 'image/jpeg', data: Buffer.from('fake').toString('base64') });
assert.ok(up.ok && up.fileId);
assert.equal(call('upload', { name: 'a.txt', mime: 'text/plain', data: 'eA==' }).ok, false, 'non-image rejected');
const base = { reporter: 'นัท', product: 'LabQuest 3', code: 'LABQ3', sn: '0F1009283', snManual: false, customer: '', symptom: 'เปิดไม่ติด', urgent: true, photos: up.fileId };
assert.match(call('create', { ticket: { ...base, photos: '' } }).error, /รูป/, 'photo required');
assert.match(call('create', { ticket: { ...base, sn: '' } }).error, /S\/N/, 'S/N required unless snManual');
assert.equal(call('create', { ticket: { ...base, sn: '', snManual: true, photos: up.fileId } }).ok, true, 'no S/N allowed when snManual');
const c = call('create', { ticket: { ...base, status: 'done', finishedAt: 'x' } });
assert.equal(c.ok, true);
assert.equal(c.ticket.status, 'wait', 'client cannot set status on create');
assert.equal(c.ticket.finishedAt, undefined);
assert.equal(b.mails.length, 2, 'email sent per new ticket');
assert.match(b.mails[1].subject, /ด่วน/);

// leading-zero S/N survives a round trip as text
const t0 = call('list').tickets.find(t => t.id === c.ticket.id);
assert.equal(t0.sn, '0F1009283');
assert.equal(t0.urgent, true);

// update cannot touch status
const u = call('update', { id: c.ticket.id, ticket: { symptom: 'เปิดไม่ติด ชาร์จแล้ว', status: 'done' } });
assert.equal(u.ticket.symptom, 'เปิดไม่ติด ชาร์จแล้ว');
assert.equal(u.ticket.status, 'wait');

// take → finish
assert.equal(call('finish', { id: c.ticket.id, status: 'done', tech: 'นัท', found: 'x', method: '' , check: 'y' }).ok, false, 'method required');
assert.equal(call('take', { id: c.ticket.id, tech: 'นัท' }).ticket.status, 'doing');
assert.equal(call('take', { id: c.ticket.id, tech: 'บอส' }).ok, false, 'cannot take twice');
const f = call('finish', { id: c.ticket.id, status: 'done', tech: 'นัท', found: 'แบตเสื่อม', method: 'เปลี่ยนแบต', check: 'เปิดได้', repairPhotos: [up.fileId] });
assert.equal(f.ticket.status, 'done');
assert.ok(f.ticket.finishedAt);
assert.equal(call('finish', { id: c.ticket.id, status: 'done', tech: 'นัท', found: 'a', method: 'b', check: 'c' }).ok, false, 'cannot finish twice');

// fail path needs a reason
const c2 = call('create', { ticket: { ...base, urgent: false } }).ticket;
assert.equal(call('finish', { id: c2.id, status: 'fail', tech: 'นัท', found: 'จอแตก' }).ok, false);
assert.equal(call('finish', { id: c2.id, status: 'fail', tech: 'นัท', found: 'จอแตก', reason: 'ไม่มีอะไหล่' }).ticket.status, 'fail');

// delete trashes photos and removes the row
const before = call('list').tickets.length;
assert.equal(call('delete', { id: c.ticket.id }).ok, true);
assert.equal(call('list').tickets.length, before - 1);
assert.equal(b.files.get(up.fileId).trashed, true);
assert.equal(call('delete', { id: c.ticket.id }).ok, false, 'deleting twice reports not found');

// password is read from the Config sheet, so changing the cell changes the login
const cfg = b.sheets.get('Config').rows.find(r => r[0] === 'password'); cfg[1] = '9999';
assert.equal(call('list').auth, false);

console.log('backend: all checks passed');
