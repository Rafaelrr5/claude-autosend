const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Small DOM boundary for exercising the real, dependency-free browser script.
class Element {
  constructor() { this.children = []; this.listeners = {}; this.style = {}; this.value = ''; this.dataset = {}; this.disabled = false; this._html = ''; }
  set innerHTML(value) {
    this._html = value;
    this.children = [];
    if (this.className !== 'session-item') return;
    for (const match of value.matchAll(/<(input|textarea|select|ul)\b([^>]*)>/g)) {
      const child = new Element();
      child.tag = match[1];
      const attrs = Object.fromEntries([...match[2].matchAll(/([\w-]+)="([^"]*)"/g)].map(m => [m[1], m[2]]));
      child.className = attrs.class || ''; child.type = attrs.type; child.value = attrs.value || '';
      child.dataset = { type: attrs['data-type'], field: attrs['data-field'] };
      child.options = []; child.selectedIndex = 0;
      this.children.push(child);
    }
  }
  get innerHTML() { return this._html; }
  set textContent(value) { this._text = String(value); this._html = String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  get textContent() { return this._text; }
  appendChild(child) { child.parent = this; this.children.push(child); return child; }
  remove() { this.parent.children = this.parent.children.filter(c => c !== this); }
  setAttribute(name, value) { this[name] = value; }
  addEventListener(name, fn) { this.listeners[name] = fn; }
  querySelectorAll(selector) {
    const matches = el => selector.split(',').some(s => {
      s = s.trim();
      if (s.startsWith('.')) return (el.className || '').split(' ').includes(s.slice(1));
      const tag = s.match(/^\w+/)?.[0];
      if (tag && el.tag !== tag) return false;
      return [...s.matchAll(/\[([\w-]+)="([^"]+)"\]/g)].every(([, key, val]) => key.startsWith('data-') ? el.dataset[key.slice(5)] === val : el[key] === val);
    });
    return this.children.flatMap(c => [...(matches(c) ? [c] : []), ...c.querySelectorAll(selector)]);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}
function setup() {
  const elements = Object.fromEntries(['clockTime', 'tzLabel', 'targetTime', 'timePreview', 'sessionsContainer', 'scheduleForm', 'submitBtn', 'toastContainer', 'schedulesList', 'addNewSession', 'addExistingSession', 'refreshBtn'].map(id => [id, new Element()]));
  const form = elements.scheduleForm;
  for (const id of ['targetTime', 'sessionsContainer', 'submitBtn', 'addNewSession', 'addExistingSession']) form.appendChild(elements[id]);
  elements.targetTime.tag = 'input'; elements.submitBtn.tag = 'button';
  form.reset = () => { form.listeners.reset?.({ preventDefault() {} }); };
  const reads = []; const posts = [];
  const context = vm.createContext({
    document: { getElementById: id => elements[id] || elements.sessionsContainer.children.find(c => c.id === id), createElement: tag => Object.assign(new Element(), { tag }) },
    window: {}, setInterval() {}, setTimeout() {}, console,
    fetch: async (url, options) => {
      if (options?.method === 'POST') { posts.push(JSON.parse(options.body)); return { ok: false, json: async () => ({ error: '<img src=x onerror=alert(1)>' }) }; }
      return { json: async () => url.endsWith('/time') ? {} : [] };
    },
    FileReader: class { readAsDataURL(file) { reads.push(file); this.result = `data:application/octet-stream;base64,${Buffer.from(file.content || '').toString('base64')}`; queueMicrotask(() => this.onload()); } },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8'), context);
  return { context, elements, reads, posts, run: code => vm.runInContext(code, context) };
}

const plain = value => JSON.parse(JSON.stringify(value));

test('interrupted schedules show the delivery uncertainty warning without retry or cancel', async () => {
  const app = setup();
  app.context.fetch = async () => ({ json: async () => [{
    id: 12, time: '0400', status: 'interrupted', sessions: 2, prompt: 'Read',
    deliveryWarning: 'Some prompts may have been sent. Check <target> before scheduling again.'
  }] });
  await app.context.loadSchedules();
  const html = app.elements.schedulesList.innerHTML;
  assert.match(html, /Interrupted/);
  assert.match(html, /may have been sent/);
  assert.match(html, /&lt;target&gt;/);
  assert.match(html, /role="alert"/);
  assert.doesNotMatch(html, /cancelSchedule|<target>/);
});

test('attachment delivery and cancellation errors are visible and HTML escaped', async () => {
  const app = setup();
  const schedule = { id: 1, time: '1230', status: 'executed', sessions: 1, prompt: 'Read', results: [{ status: 'error', error: 'Attachment unavailable: <img src=x>.txt' }] };
  app.context.fetch = async (url, opts) => opts
    ? { ok: false, json: async () => ({ error: 'Cleanup failed <img>' }) }
    : { json: async () => [schedule] };
  await app.context.loadSchedules();
  assert.match(app.elements.schedulesList.innerHTML, /Attachment unavailable: &lt;img/);
  assert.doesNotMatch(app.elements.schedulesList.innerHTML, /<img/);
  await app.context.cancelSchedule(1);
  assert.match(app.elements.toastContainer.children.at(-1).innerHTML, /Cleanup failed &lt;img&gt;/);
});

test('pending reads block duplicate submissions, removals, picker changes and resets', async () => {
  const app = setup();
  const item = app.elements.sessionsContainer.children[0];
  const picker = item.querySelector('input[type="file"]');
  picker.files = [{ name: 'keep.txt', size: 1, content: 'x' }];
  picker.listeners.change();
  item.querySelector('.session-prompt').value = 'Read';
  app.elements.targetTime.value = '1230';
  let finish;
  app.context.FileReader = class { readAsDataURL() { finish = () => { this.result = 'data:;base64,eA=='; this.onload(); }; } };
  const submit = app.elements.scheduleForm.listeners.submit;
  const pending = submit({ preventDefault() {} });
  const remove = item.querySelector('.attachment-remove');
  assert.equal(remove.disabled, true);
  remove.listeners.click();
  picker.files = [{ name: 'ignored.txt', size: 1 }];
  picker.listeners.change();
  let resetBlocked = false;
  app.elements.scheduleForm.listeners.reset({ preventDefault() { resetBlocked = true; } });
  await submit({ preventDefault() {} });
  assert.equal(resetBlocked, true);
  assert.equal(item.attachmentFiles.length, 1);
  assert.equal(app.posts.length, 0);
  finish();
  await pending;
  assert.equal(app.posts.length, 1);
  assert.equal(remove.disabled, false);
  app.elements.scheduleForm.reset();
  assert.equal(item.attachmentFiles.length, 0);
  assert.equal(item.querySelector('.attachment-list').children.length, 0);
});

test('network failures retain attachments and restore controls', async () => {
  const app = setup();
  const item = app.elements.sessionsContainer.children[0];
  item.querySelector('.session-prompt').value = 'Read';
  item.attachmentFiles = [{ name: 'keep.txt', size: 1, content: 'x' }];
  app.elements.targetTime.value = '1230';
  app.context.fetch = async () => { throw new Error('Network unavailable'); };
  await app.elements.scheduleForm.listeners.submit({ preventDefault() {} });
  assert.equal(item.attachmentFiles.length, 1);
  assert.equal(item.querySelector('input[type="file"]').disabled, false);
  assert.match(app.elements.toastContainer.children.at(-1).innerHTML, /Network unavailable/);
});

test('schedule cards show attachment metadata without interpreting filenames as HTML', async () => {
  const app = setup();
  app.context.fetch = async () => ({ json: async () => [{ id: 1, time: '1230', status: 'waiting', sessions: 2, diffMinutes: 10, prompt: 'Read', attachmentCount: 1, attachments: [{ name: '<img src=x>.txt', size: 2048 }] }] });
  await app.context.loadSchedules();
  const html = app.elements.schedulesList.innerHTML;
  assert.match(html, /1 attachment\(s\)/);
  assert.match(html, /&lt;img src=x&gt;\.txt/);
  assert.match(html, /2\.0 KiB/);
  assert.doesNotMatch(html, /<img/);
});

test('a missing prompt or window does not submit or clear attachments', async () => {
  const app = setup();
  const item = app.elements.sessionsContainer.children[0];
  item.attachmentFiles = [{ name: 'keep.txt', size: 1 }];
  app.elements.targetTime.value = '1230';
  await app.elements.scheduleForm.listeners.submit({ preventDefault() {} });
  assert.equal(app.posts.length, 0);
  assert.equal(item.attachmentFiles.length, 1);
  item.querySelector('.session-prompt').value = 'Read';
  app.context.addSession('existing');
  await app.elements.scheduleForm.listeners.submit({ preventDefault() {} });
  assert.equal(app.posts.length, 0, 'an unselected existing window cannot be silently dropped');
});

test('submission locks edits, sends existing-session files, preserves errors and resets on success', async () => {
  const app = setup();
  app.context.addSession('existing');
  await Promise.resolve(); await Promise.resolve();
  const items = app.elements.sessionsContainer.children;
  for (const item of items) item.querySelector('.session-prompt').value = 'Required text';
  const select = items[1].querySelector('select');
  select.value = '42'; select.options = [{ textContent: 'Existing window' }];
  items[1].attachmentFiles = [{ name: 'existing.txt', size: 1, content: 'x' }];
  app.elements.targetTime.value = '1230';
  const submit = app.elements.scheduleForm.listeners.submit;
  const pending = submit({ preventDefault() {} });
  assert.equal(items[1].querySelector('input[type="file"]').disabled, true);
  app.context.addSession('new'); app.context.removeSession(items[1].id);
  assert.equal(items.length, 2);
  await pending;
  assert.equal(app.posts[0].sessions[1].attachments[0].data, 'eA==');
  assert.equal(app.posts[0].sessions[1].pid, 42);
  assert.equal('attachments' in app.posts[0].sessions[0], false);
  assert.equal('files' in app.posts[0].sessions[0], false);
  assert.equal(items[1].attachmentFiles.length, 1);
  assert.equal(items[1].querySelector('input[type="file"]').disabled, false);
  assert.match(app.elements.toastContainer.children.at(-1).innerHTML, /&lt;img/);
  assert.doesNotMatch(app.elements.toastContainer.children.at(-1).innerHTML, /<img/);
  app.context.fetch = async (url, opts) => ({ ok: true, json: async () => opts ? { targetTime: '12:30', diffMinutes: 5 } : [] });
  await submit({ preventDefault() {} });
  assert.equal(items[1].attachmentFiles.length, 0);
});

test('file-read errors preserve selections and unlock the form without posting', async () => {
  const app = setup();
  const item = app.elements.sessionsContainer.children[0];
  item.querySelector('.session-prompt').value = 'Read';
  item.attachmentFiles = [{ name: 'unreadable.txt', size: 1 }];
  app.elements.targetTime.value = '1230';
  app.context.FileReader = class { readAsDataURL() { queueMicrotask(() => this.onerror()); } };
  await app.elements.scheduleForm.listeners.submit({ preventDefault() {} });
  assert.equal(app.posts.length, 0);
  assert.equal(item.attachmentFiles.length, 1);
  assert.equal(app.elements.submitBtn.disabled, false);
  assert.match(app.elements.toastContainer.children.at(-1).innerHTML, /Could not read/);
});

test('limits are validated across the entire schedule before any file is read', async () => {
  const app = setup();
  const MiB = 1024 * 1024;
  const file = size => ({ name: 'large.txt', size });
  await assert.rejects(() => app.context.encodeSessions([{ files: Array.from({ length: 11 }, () => file(1)) }]), /10 files per session/);
  await assert.rejects(() => app.context.encodeSessions([{ files: [file(5 * MiB + 1)] }]), /5 MiB/);
  await assert.rejects(() => app.context.encodeSessions([{ files: [file(5 * MiB)] }, { files: Array.from({ length: 4 }, () => file(5 * MiB)) }]), /20 MiB/);
  assert.equal(app.reads.length, 0);
  await app.context.encodeSessions([{ files: Array.from({ length: 4 }, () => file(5 * MiB)) }]);
  assert.equal(app.reads.length, 4, 'exact limit is accepted');
});

test('pickers accumulate files per session, render safe names and sizes, and remove individually', () => {
  const app = setup();
  app.context.addSession('existing');
  const [first, second] = app.elements.sessionsContainer.children;
  const picker = first.querySelector('input[type="file"]');
  assert.ok(picker, 'new sessions have a file picker');
  assert.ok(second.querySelector('input[type="file"]'), 'existing sessions have a file picker');
  picker.files = [{ name: '<img src=x>.txt', size: 123 }];
  picker.listeners.change();
  picker.files = [{ name: 'next.txt', size: 1024 }];
  picker.listeners.change();
  assert.equal(first.attachmentFiles.length, 2);
  assert.equal(second.attachmentFiles.length, 0);
  const list = first.querySelector('.attachment-list');
  assert.match(list.children[0].children[0].innerHTML, /&lt;img/);
  assert.match(list.children[0].children[0].textContent, /123 B/);
  list.children[0].children[1].listeners.click();
  assert.equal(first.attachmentFiles.length, 1);
  assert.equal(first.attachmentFiles[0].name, 'next.txt');
  assert.equal(picker.value, '');
});

test('each session snapshots its optional attachments and encodes exact file bytes', async () => {
  const app = setup();
  const item = app.elements.sessionsContainer.children[0];
  item.querySelector('.session-prompt').value = 'Read this';
  item.attachmentFiles = [{ name: 'report.txt', size: 5, content: 'hello' }];
  const sessions = app.context.collectSessions();
  assert.equal(sessions[0].files?.length, 1);
  item.attachmentFiles.push({ name: 'later.txt', size: 0 });
  assert.equal(sessions[0].files.length, 1, 'submission owns a snapshot');
  const payload = await app.context.encodeSessions(sessions);
  assert.deepEqual(plain(payload), [{ type: 'new', label: 'Session-1', prompt: 'Read this', attachments: [{ name: 'report.txt', data: 'aGVsbG8=' }] }]);
});
