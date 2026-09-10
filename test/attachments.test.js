'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autosend-attachments-'));
process.env.DATA_FILE = path.join(root, 'schedules.json');
const api = require('../server.js');
let server;
let base;
function clearSchedules() {
  for (const s of api.schedules.values()) clearTimeout(s.timeoutId);
  api.schedules.clear();
}
test.before(async () => {
  if (!api.app) return;
  server = api.app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  clearSchedules();
  if (server) await new Promise(resolve => server.close(resolve));
  fs.rmSync(root, { recursive: true, force: true });
});
test.beforeEach(() => {
  clearSchedules();
  fs.rmSync(process.env.DATA_FILE, { recursive: true, force: true });
  fs.rmSync(`${process.env.DATA_FILE}.attachments`, { recursive: true, force: true });
});
function attachment(name = 'relatório final.pdf', data = Buffer.from([0, 255, 1, 128])) {
  return { name, data: data.toString('base64') };
}
function payload(sessions = [{ type: 'new', prompt: 'Read this', attachments: [attachment()] }]) {
  return { time: '0400', sessions };
}
async function request(route, method = 'GET', body) {
  const response = await fetch(base + route, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return { status: response.status, body: await response.json() };
}
function rows() { return JSON.parse(fs.readFileSync(process.env.DATA_FILE, 'utf8')); }

test('strict validation rejects malformed input without writes across every session', async () => {
  const invalidFiles = [null, {}, { name: 1, data: '' }, { name: 'x', data: 3 },
    { name: 'x', data: 'AA=' }, { name: 'x', data: 'AB==' }, { name: 'x', data: 'AA==\n' },
    { name: 'x', data: 'data:text/plain;base64,AA==' },
    ...['../escape.txt', 'C:\\escape.txt', '/tmp/x', 'a/b', 'a\\b', '.', '..', 'CON.txt',
      'foo:bar', 'x\u0000.txt', 'x\n.txt', ' ', 'a'.repeat(256)].map(name => attachment(name))];
  const invalidSessions = [null, { type: 'new', prompt: 123 }, { type: 'unknown', prompt: 'x' },
    { type: 'existing', prompt: 'x', pid: '123;exit' },
    ...[null, {}, 'file', Array(11).fill(attachment()), ...invalidFiles.map(f => [f])]
      .map(attachments => ({ type: 'new', prompt: 'x', attachments }))];
  for (const invalid of invalidSessions) {
    const response = await request('/api/schedule', 'POST', payload([
      { type: 'new', prompt: 'valid first', attachments: [attachment()] }, invalid
    ]));
    assert.equal(response.status, 400, JSON.stringify(invalid));
    assert.equal(typeof response.body.error, 'string');
    assert.equal(api.schedules.size, 0);
    assert.ok(!fs.existsSync(api.ATTACHMENTS_DIR));
    assert.ok(!fs.existsSync(process.env.DATA_FILE));
  }
});

test('allows exact size/count boundaries and rejects excessive file/schedule bytes', async () => {
  const max = attachment('max.bin', Buffer.alloc(5 * 1024 * 1024, 255));
  const full = await request('/api/schedule', 'POST', payload([
    { type: 'new', prompt: 'x', attachments: [max, max] },
    { type: 'existing', pid: 123, prompt: 'x', attachments: [max, max] }
  ]));
  assert.equal(full.status, 200, JSON.stringify(full.body));
  assert.equal((await request('/api/schedules')).body[0].attachmentCount, 4);
  assert.equal((await request('/api/schedule', 'POST', payload([
    { type: 'new', prompt: 'x', attachments: [max, max, max, max, attachment('extra', Buffer.from('x'))] }
  ]))).status, 400);
  assert.equal((await request('/api/schedule', 'POST', payload([
    { type: 'new', prompt: 'x', attachments: [attachment('large', Buffer.alloc(5 * 1024 * 1024 + 1))] }
  ]))).status, 400);
  assert.equal((await request('/api/schedule', 'POST', payload([
    { type: 'new', prompt: 'x', attachments: Array.from({ length: 10 }, () => attachment('empty', Buffer.alloc(0))) }
  ]))).status, 200);
});

test('malformed and oversized HTTP JSON return JSON errors', async () => {
  for (const [body, status] of [['{broken', 400], [JSON.stringify({ padding: 'x'.repeat(32 * 1024 * 1024) }), 413]]) {
    const response = await fetch(base + '/api/schedule', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
    assert.equal(response.status, status);
    assert.equal(typeof (await response.json()).error, 'string');
  }
  assert.equal(api.schedules.size, 0);
});

test('duplicate filenames have independent bytes and references survive restart', async () => {
  await request('/api/schedule', 'POST', payload([{ type: 'new', prompt: 'x', attachments: [
    attachment('same.txt', Buffer.from('one')), attachment('same.txt', Buffer.from('two'))
  ] }]));
  const [before] = rows();
  clearSchedules();
  api.restore();
  const restored = api.schedules.get(before.id);
  assert.equal(restored.status, 'waiting');
  assert.ok(restored.timeoutId);
  const [a, b] = restored.sessions[0].attachments;
  assert.notEqual(a.path, b.path);
  assert.equal(fs.readFileSync(a.path, 'utf8'), 'one');
  assert.equal(fs.readFileSync(b.path, 'utf8'), 'two');
});

test('real persistence rename failure rolls back map, timer, temporary file and uploaded directory', async () => {
  fs.mkdirSync(process.env.DATA_FILE);
  fs.writeFileSync(path.join(process.env.DATA_FILE, 'blocker'), 'keep');
  const response = await request('/api/schedule', 'POST', payload());
  assert.equal(response.status, 500);
  assert.equal(api.schedules.size, 0);
  assert.ok(!fs.existsSync(`${process.env.DATA_FILE}.${process.pid}.tmp`));
  assert.deepEqual(fs.readdirSync(api.ATTACHMENTS_DIR), []);
  assert.equal(fs.readFileSync(path.join(process.env.DATA_FILE, 'blocker'), 'utf8'), 'keep');
});

test('failed cancellation persistence retains waiting timer and file bytes', async () => {
  const created = await request('/api/schedule', 'POST', payload());
  const schedule = api.schedules.get(created.body.id);
  const timer = schedule.timeoutId;
  fs.rmSync(process.env.DATA_FILE);
  fs.mkdirSync(process.env.DATA_FILE);
  fs.writeFileSync(path.join(process.env.DATA_FILE, 'blocker'), 'keep');
  assert.equal((await request(`/api/schedule/${created.body.id}`, 'DELETE')).status, 500);
  assert.equal(schedule.status, 'waiting');
  assert.equal(schedule.timeoutId, timer);
  assert.equal(timer._destroyed, false);
  assert.ok(fs.existsSync(schedule.sessions[0].attachments[0].path));
});

test('attachment storage symlinks cannot redirect uploaded bytes', async () => {
  const destination = fs.mkdtempSync(path.join(root, 'redirect-'));
  try {
    fs.symlinkSync(destination, api.ATTACHMENTS_DIR, 'junction');
    const response = await request('/api/schedule', 'POST', payload());
    assert.equal(response.status, 500);
    assert.deepEqual(fs.readdirSync(destination), []);
    assert.equal(api.schedules.size, 0);
  } finally {
    fs.rmSync(api.ATTACHMENTS_DIR, { force: true, recursive: true });
    fs.rmSync(destination, { recursive: true, force: true });
  }
});

test('untrusted supplied paths are ignored and persisted outside references never dispatch', async () => {
  const a = attachment();
  a.path = path.join(root, 'outside.txt');
  const created = await request('/api/schedule', 'POST', payload([{ type: 'new', prompt: 'x', attachments: [a] }]));
  assert.equal(created.status, 200);
  const schedule = api.schedules.get(created.body.id);
  assert.notEqual(schedule.sessions[0].attachments[0].path, a.path);
  fs.writeFileSync(a.path, Buffer.from([0, 255, 1, 128]));
  schedule.sessions[0].attachments[0].path = a.path;
  let calls = 0;
  await api.fire(created.body.id, { openNewClaudeSession: async () => { calls++; } });
  assert.equal(calls, 0);
  assert.equal(rows()[0].results[0].status, 'error');
  fs.rmSync(a.path);
});

test('cancel cannot race a delivering schedule and a second fire cannot send twice', async () => {
  const created = await request('/api/schedule', 'POST', payload());
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  let calls = 0;
  const delivery = { openNewClaudeSession: async () => { calls++; await pending; return { status: 'started' }; } };
  const firing = api.fire(created.body.id, delivery);
  try {
    await api.fire(created.body.id, delivery);
    assert.equal((await request(`/api/schedule/${created.body.id}`, 'DELETE')).status, 409);
    assert.equal(calls, 1);
  } finally {
    release();
    await firing;
  }
});

test('HTTP upload persists exact binary privately and lists only attachment metadata', async () => {
  assert.ok(api.app, 'server must expose the HTTP app for offline integration tests');
  const created = await request('/api/schedule', 'POST', payload());
  assert.equal(created.status, 200);
  const [saved] = rows();
  const [file] = saved.sessions[0].attachments;
  assert.equal(file.name, 'relatório final.pdf');
  assert.equal(file.size, 4);
  assert.equal(file.data, undefined);
  assert.ok(path.isAbsolute(file.path));
  assert.ok(file.path.startsWith(path.resolve(`${process.env.DATA_FILE}.attachments`) + path.sep));
  assert.notEqual(path.basename(file.path), file.name);
  assert.equal(path.extname(file.path), '.pdf');
  assert.deepEqual(fs.readFileSync(file.path), Buffer.from([0, 255, 1, 128]));
  const listed = await request('/api/schedules');
  assert.equal(listed.body[0].attachmentCount, 1);
  assert.deepEqual(listed.body[0].attachments, [{ name: file.name, size: 4 }]);
  assert.ok(!JSON.stringify(listed.body).includes(file.path));
  assert.equal((await fetch(base + '/schedules.json.attachments/private.pdf')).status, 404);
});

test('both delivery modes receive explicit absolute file references, originals stay unchanged', async () => {
  const original = "  Analyze this\n'quoted' $value  ";
  const created = await request('/api/schedule', 'POST', payload([
    { type: 'new', prompt: original, attachments: [attachment()] },
    { type: 'existing', pid: 1234, prompt: original, attachments: [attachment()] },
    { type: 'new', prompt: original }
  ]));
  const calls = [];
  assert.equal(typeof api.fire, 'function');
  await api.fire(created.body.id, {
    openNewClaudeSession: async (...args) => { calls.push(['new', ...args]); return { status: 'started' }; },
    sendToExistingWindow: async (...args) => { calls.push(['existing', ...args]); return { status: 'sent' }; }
  });
  assert.equal(calls.length, 3);
  const saved = rows()[0];
  assert.equal(calls[0][3], saved.attachmentDir, 'new sessions receive the authorized attachment directory');
  assert.equal(calls[2][3], undefined, 'text-only sessions get no additional directory');
  for (const [i, prompt] of [[0, calls[0][1]], [1, calls[1][2]]]) {
    assert.ok(prompt.startsWith(original));
    assert.match(prompt, /read.*files/i);
    assert.ok(prompt.includes(JSON.stringify(saved.sessions[i].attachments[0].path)));
    assert.ok(prompt.includes(JSON.stringify(saved.sessions[i].attachments[0].name)), 'original name identifies each attachment');
    assert.ok(fs.existsSync(saved.sessions[i].attachments[0].path));
    assert.equal(saved.sessions[i].prompt, original);
  }
  assert.equal(calls[2][1], original);
});

test('missing attachment fails before either Windows delivery function is called', async () => {
  const created = await request('/api/schedule', 'POST', payload());
  const file = rows()[0].sessions[0].attachments[0];
  fs.rmSync(file.path);
  let called = false;
  assert.equal(typeof api.fire, 'function');
  await api.fire(created.body.id, {
    openNewClaudeSession: async () => { called = true; },
    sendToExistingWindow: async () => { called = true; }
  });
  assert.equal(called, false);
  const listed = await request('/api/schedules');
  assert.equal(listed.body[0].results[0].status, 'error');
  assert.match(listed.body[0].results[0].error, /attachment/i);
  assert.ok(!JSON.stringify(listed.body).includes(file.path));
});

test('cancel pending cleans copies but delivered files cannot be cancelled or deleted', async () => {
  const created = await request('/api/schedule', 'POST', payload());
  const saved = rows()[0];
  assert.equal((await request(`/api/schedule/${created.body.id}`, 'DELETE')).status, 200);
  assert.ok(!fs.existsSync(saved.attachmentDir));
  assert.equal(api.schedules.get(created.body.id).status, 'cancelled');
  const second = await request('/api/schedule', 'POST', payload());
  api.schedules.get(second.body.id).status = 'executed';
  const file = api.schedules.get(second.body.id).sessions[0].attachments[0].path;
  assert.equal((await request(`/api/schedule/${second.body.id}`, 'DELETE')).status, 409);
  assert.ok(fs.existsSync(file));
});

