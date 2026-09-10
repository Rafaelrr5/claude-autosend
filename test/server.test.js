'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { execFile } = require('node:child_process');

// Point persistence at a throwaway file before server.js reads DATA_FILE.
const DATA_FILE = path.join(os.tmpdir(), `autosend_test_${process.pid}.json`);
process.env.DATA_FILE = DATA_FILE;

const { app, fire, msUntilTarget, isValidTime, psq, persist, restore, schedules } = require('../server.js');

test.afterEach(() => {
  for (const s of schedules.values()) clearTimeout(s.timeoutId);
  schedules.clear();
});

test.after(() => fs.rmSync(DATA_FILE, { force: true }));

test('msUntilTarget: later today', () => {
  const { diffMs } = msUntilTarget('1200', { hour: 10, minute: 0, second: 0 });
  assert.strictEqual(diffMs, 2 * 3600 * 1000);
});

test('msUntilTarget: already passed rolls to tomorrow', () => {
  const { diffMs } = msUntilTarget('0900', { hour: 10, minute: 0, second: 0 });
  assert.strictEqual(diffMs, 23 * 3600 * 1000);
});

test('msUntilTarget: crosses midnight', () => {
  const { diffMs, targetTime } = msUntilTarget('0000', { hour: 23, minute: 59, second: 30 });
  assert.strictEqual(diffMs, 30 * 1000);
  assert.strictEqual(targetTime, '00:00');
});

test('isValidTime rejects out-of-range and non-numeric', () => {
  assert.strictEqual(isValidTime('9999'), false);
  assert.strictEqual(isValidTime('abc'), false);
  assert.strictEqual(isValidTime('2400'), false);
  assert.strictEqual(isValidTime('0400'), true);
  assert.strictEqual(isValidTime('2359'), true);
});

// psq is the only thing standing between prompt text and a PowerShell script.
// A single quote that survives unescaped closes the literal and everything
// after it is executed as code.
test('psq escapes single quotes', () => {
  assert.strictEqual(psq("don't"), "'don''t'");
  assert.strictEqual(psq("'; Remove-Item C: -Recurse; '"), "'''; Remove-Item C: -Recurse; '''");
  assert.strictEqual(psq(String.raw`C:\Users`), String.raw`'C:\Users'`);
});

test('fire persists running before either delivery mode and then records completion', async () => {
  schedules.set(10, { id: 10, status: 'waiting', sessions: [
    { type: 'new', prompt: 'first' }, { type: 'existing', pid: 123, prompt: 'second' }
  ] });
  persist();
  const observed = [];
  const deliver = async () => {
    observed.push(JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'))[0]);
    return { status: 'sent' };
  };
  await fire(10, { openNewClaudeSession: deliver, sendToExistingWindow: deliver });
  assert.strictEqual(observed.length, 2);
  for (const saved of observed) {
    assert.strictEqual(saved.status, 'running');
    assert.ok(Number.isFinite(Date.parse(saved.startedAt)));
    assert.strictEqual(saved.executedAt, undefined);
  }
  const [completed] = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  assert.strictEqual(completed.status, 'executed');
  assert.strictEqual(completed.results.length, 2);
  assert.ok(Number.isFinite(Date.parse(completed.executedAt)));
});

test('fire aborts both delivery modes when the running write fails', async t => {
  schedules.set(11, { id: 11, status: 'waiting', sessions: [
    { type: 'new', prompt: 'first' }, { type: 'existing', pid: 123, prompt: 'second' }
  ] });
  persist();
  t.mock.method(fs, 'renameSync', () => { throw new Error('Persistence unavailable'); });
  let calls = 0;
  const deliver = async () => { calls++; return { status: 'sent' }; };
  await fire(11, { openNewClaudeSession: deliver, sendToExistingWindow: deliver });
  assert.strictEqual(calls, 0);
  assert.strictEqual(schedules.get(11).status, 'failed');
  assert.match(schedules.get(11).deliveryWarning, /No prompts were sent/);
  assert.strictEqual(JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'))[0].status, 'waiting');
  assert.ok(!fs.existsSync(`${DATA_FILE}.${process.pid}.tmp`));
});

test('restart during delivery preserves an interrupted attempt without replay', async t => {
  // Exit a real child inside the delivery boundary: no desktop or CLI is used.
  const source = path.join(__dirname, '../server.js');
  const script = `
    const api = require(${JSON.stringify(source)});
    api.schedules.set(12, { id: 12, time: '0400', status: 'waiting',
      scheduledAt: new Date(Date.now() - 1000).toISOString(),
      sessions: [{ type: 'new', prompt: 'first' }, { type: 'existing', pid: 123, prompt: 'second' }] });
    api.persist();
    api.fire(12, {
      openNewClaudeSession: async () => ({ status: 'started' }),
      sendToExistingWindow: async () => process.exit(23)
    });
  `;
  const exitCode = await new Promise(resolve => {
    execFile(process.execPath, ['-e', script], { windowsHide: true, timeout: 15000 }, error => resolve(error?.code || 0));
  });
  assert.strictEqual(exitCode, 23);
  const [before] = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  assert.strictEqual(before.status, 'running');
  restore();
  const recovered = schedules.get(12);
  assert.strictEqual(recovered.status, 'interrupted');
  assert.strictEqual(recovered.startedAt, before.startedAt);
  assert.ok(Number.isFinite(Date.parse(recovered.interruptedAt)));
  assert.strictEqual(recovered.executedAt, undefined);
  assert.strictEqual(recovered.timeoutId, undefined);
  assert.match(recovered.deliveryWarning, /may have been sent/i);
  let calls = 0;
  await fire(12, { openNewClaudeSession: async () => { calls++; }, sendToExistingWindow: async () => { calls++; } });
  assert.strictEqual(calls, 0);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')), [recovered]);
  schedules.clear();
  restore();
  assert.deepStrictEqual(schedules.get(12), recovered, 'subsequent restarts preserve the interruption');

  const server = app.listen(0, '127.0.0.1');
  t.after(() => new Promise(resolve => server.close(resolve)));
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const [listed] = await (await fetch(`${base}/api/schedules`)).json();
  assert.strictEqual(listed.status, 'interrupted');
  assert.strictEqual(listed.startedAt, recovered.startedAt);
  assert.strictEqual(listed.interruptedAt, recovered.interruptedAt);
  assert.strictEqual(listed.deliveryWarning, recovered.deliveryWarning);
  assert.strictEqual((await fetch(`${base}/api/schedule/12`, { method: 'DELETE' })).status, 409);
});

test('legacy delivering snapshots recover as interrupted even before their scheduled time', () => {
  fs.writeFileSync(DATA_FILE, JSON.stringify([{ id: 13, status: 'delivering',
    scheduledAt: new Date(Date.now() + 3600000).toISOString(), sessions: [],
    results: [{ status: 'started' }] }]));
  restore();
  assert.strictEqual(schedules.get(13).status, 'interrupted');
  assert.strictEqual(schedules.get(13).timeoutId, undefined);
  assert.deepStrictEqual(schedules.get(13).results, [{ status: 'started' }]);
});

test('completion write failure leaves a recoverable running record on disk', async t => {
  schedules.set(14, { id: 14, status: 'waiting', sessions: [{ type: 'new', prompt: 'first' }] });
  persist();
  const rename = fs.renameSync;
  let writes = 0;
  const mock = t.mock.method(fs, 'renameSync', (...args) => {
    if (++writes === 2) throw new Error('Completion write failed');
    return rename(...args);
  });
  let calls = 0;
  await assert.rejects(fire(14, { openNewClaudeSession: async () => { calls++; return { status: 'started' }; } }), /Completion write failed/);
  assert.strictEqual(calls, 1);
  assert.strictEqual(JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'))[0].status, 'running');
  mock.mock.restore();
  schedules.clear();
  restore();
  assert.strictEqual(schedules.get(14).status, 'interrupted');
  assert.strictEqual(schedules.get(14).timeoutId, undefined);
});

test('persist/restore round-trip: only future waiting jobs re-arm, history survives', () => {
  schedules.clear();
  const future = new Date(Date.now() + 3600 * 1000).toISOString();
  const past = new Date(Date.now() - 3600 * 1000).toISOString();

  schedules.set(1, { id: 1, time: '0400', sessions: [{ type: 'new', prompt: 'hi' }], status: 'waiting', scheduledAt: future, timeoutId: setTimeout(() => {}, 1) });
  schedules.set(2, { id: 2, time: '0500', sessions: [{ type: 'new', prompt: 'stale' }], status: 'waiting', scheduledAt: past });
  schedules.set(3, { id: 3, time: '0600', sessions: [{ type: 'new', prompt: 'done' }], status: 'executed', scheduledAt: past });
  schedules.set(4, { id: 4, time: '0700', sessions: [], status: 'cancelled', scheduledAt: future });
  schedules.set(5, { id: 5, time: '0800', sessions: [], status: 'missed', scheduledAt: past });
  const history = [3, 4, 5].map(id => schedules.get(id));

  persist();
  // timeoutId must not reach disk — it is not serialisable state.
  assert.ok(!fs.readFileSync(DATA_FILE, 'utf8').includes('timeoutId'));

  for (const s of schedules.values()) clearTimeout(s.timeoutId);
  schedules.clear();
  restore();

  assert.deepStrictEqual([...schedules.keys()].sort(), [1, 2, 3, 4, 5]);
  assert.strictEqual(schedules.get(1).status, 'waiting');
  assert.strictEqual(schedules.get(1).sessions[0].prompt, 'hi');
  assert.ok(schedules.get(1).timeoutId, 'pending schedule should be re-armed');
  assert.strictEqual(schedules.get(2).status, 'missed');
  assert.ok(!schedules.get(2).timeoutId, 'missed schedule must not be armed');
  const saved = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  assert.strictEqual(saved.length, 5);
  for (const row of history) {
    assert.deepStrictEqual(schedules.get(row.id), row);
    assert.strictEqual(schedules.get(row.id).timeoutId, undefined);
    assert.deepStrictEqual(saved.find(s => s.id === row.id), row);
  }

  clearTimeout(schedules.get(1).timeoutId);
  schedules.clear();
});

test('restore preserves completed ID 9 and allocates the next API schedule above it', async t => {
  const completed = { id: 9, time: '0600', sessions: [{ type: 'new', prompt: 'done' }],
    status: 'executed', scheduledAt: '2020-01-01T06:00:00.000Z',
    executedAt: '2020-01-01T06:00:01.000Z', results: [{ status: 'started' }] };
  fs.writeFileSync(DATA_FILE, JSON.stringify([completed]), 'utf8');
  restore();
  assert.deepStrictEqual(schedules.get(9), completed);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')), [completed]);
  assert.strictEqual(schedules.get(9).timeoutId, undefined);

  const server = app.listen(0, '127.0.0.1');
  t.after(() => new Promise(resolve => server.close(resolve)));
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const listed = await (await fetch(`${base}/api/schedules`)).json();
  assert.strictEqual(listed[0].id, 9);
  assert.strictEqual(listed[0].status, 'executed');
  const response = await fetch(`${base}/api/schedule`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ time: '0400', sessions: [{ type: 'new', prompt: 'next' }] })
  });
  assert.strictEqual(response.status, 200);
  const created = await response.json();
  assert.ok(created.id > 9, `next ID ${created.id} must exceed restored ID 9`);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')).find(s => s.id === 9), completed);
});

// Execute the actual generated PowerShell, but replace every desktop boundary.
// No real process lookup, COM object, clipboard operation or keystroke is allowed.
async function windowDelivery(t, scenario) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autosend-window-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const eventsFile = path.join(root, 'events.txt');
  const scriptFile = path.join(root, 'delivery.ps1');
  const promptFiles = [];
  const module = { exports: {} };
  const source = path.join(__dirname, '../server.js');
  vm.runInNewContext(fs.readFileSync(source, 'utf8'), {
    module, __dirname: path.dirname(source), console, setTimeout, clearTimeout,
    process: { env: { DATA_FILE: path.join(root, 'schedules.json') }, cwd: () => root, pid: process.pid },
    require: id => {
      if (id === 'fs') return { ...fs, writeFileSync(file, ...args) {
        if (path.basename(file).startsWith('claude_prompt_')) promptFiles.push(file);
        return fs.writeFileSync(file, ...args);
      } };
      if (id !== 'child_process') return require(id);
      return { exec(script, options, callback) {
        assert.equal(options.shell, 'powershell.exe');
        assert.equal(options.windowsHide, true);
        fs.writeFileSync(scriptFile, `
$scenario = ${psq(scenario)}
function Record([string]$value) { [IO.File]::AppendAllText(${psq(eventsFile)}, $value + [Environment]::NewLine) }
function New-Object {
  param([string]$ComObject)
  if ($ComObject -ne 'WScript.Shell') { throw 'Unexpected COM object' }
  $shell = [PSCustomObject]@{}
  $shell | Add-Member ScriptMethod AppActivate {
    param($targetId)
    Record "activate:$targetId"
    if ($scenario -eq 'activation-error') { throw 'Activation exception' }
    return ($scenario -ne 'activation-false')
  }
  $shell | Add-Member ScriptMethod SendKeys { param($keys) Record "keys:$keys" }
  return $shell
}
function Get-Process {
  param($Id, $ErrorAction)
  if ($scenario -eq 'missing') { return $null }
  $handle = if ($scenario -eq 'no-window') { 0 } else { 1 }
  return [PSCustomObject]@{ Id = $Id; MainWindowHandle = $handle; MainWindowTitle = 'Test window' }
}
function Set-Clipboard {
  param($Value)
  Record "clipboard:$Value"
  if ($scenario -eq 'clipboard-error') { Write-Error 'Clipboard unavailable' }
}
function Start-Sleep { param($Milliseconds) }
${script}`, 'utf8');
        execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', scriptFile],
          { windowsHide: true, timeout: 15000 }, callback);
      } };
    }
  }, { filename: source });
  const api = module.exports;
  api.schedules.set(101, { id: 101, status: 'waiting', sessions: [
    { type: 'existing', pid: 1234, prompt: 'test prompt', label: 'Target' }
  ] });
  await api.fire(101);
  assert.equal(promptFiles.length, 1);
  assert.ok(promptFiles.every(file => !fs.existsSync(file)), 'temporary prompt must be removed');
  const events = fs.existsSync(eventsFile) ? fs.readFileSync(eventsFile, 'utf8').trim().split(/\r?\n/) : [];
  const [saved] = JSON.parse(fs.readFileSync(path.join(root, 'schedules.json'), 'utf8'));
  return { events, result: saved.results[0] };
}

test('AppActivate false aborts before clipboard/paste/Enter and persists a delivery error',
  { skip: process.platform !== 'win32' }, async t => {
    const { events, result } = await windowDelivery(t, 'activation-false');
    assert.deepStrictEqual(events, ['activate:1234']);
    assert.strictEqual(result.status, 'error');
    assert.match(result.error, /activate.*1234/i);
  });
