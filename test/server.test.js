'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Point persistence at a throwaway file before server.js reads DATA_FILE.
const DATA_FILE = path.join(os.tmpdir(), `autosend_test_${process.pid}.json`);
process.env.DATA_FILE = DATA_FILE;

const { msUntilTarget, isValidTime, psq, persist, restore, schedules } = require('../server.js');

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

test('persist/restore round-trip: future re-armed, past missed, history dropped', () => {
  schedules.clear();
  const future = new Date(Date.now() + 3600 * 1000).toISOString();
  const past = new Date(Date.now() - 3600 * 1000).toISOString();

  schedules.set(1, { id: 1, time: '0400', sessions: [{ type: 'new', prompt: 'hi' }], status: 'waiting', scheduledAt: future, timeoutId: setTimeout(() => {}, 1) });
  schedules.set(2, { id: 2, time: '0500', sessions: [{ type: 'new', prompt: 'stale' }], status: 'waiting', scheduledAt: past });
  schedules.set(3, { id: 3, time: '0600', sessions: [{ type: 'new', prompt: 'done' }], status: 'executed', scheduledAt: past });

  persist();
  // timeoutId must not reach disk — it is not serialisable state.
  assert.ok(!fs.readFileSync(DATA_FILE, 'utf8').includes('timeoutId'));

  for (const s of schedules.values()) clearTimeout(s.timeoutId);
  schedules.clear();
  restore();

  assert.deepStrictEqual([...schedules.keys()].sort(), [1, 2]);
  assert.strictEqual(schedules.get(1).status, 'waiting');
  assert.strictEqual(schedules.get(1).sessions[0].prompt, 'hi');
  assert.ok(schedules.get(1).timeoutId, 'pending schedule should be re-armed');
  assert.strictEqual(schedules.get(2).status, 'missed');
  assert.ok(!schedules.get(2).timeoutId, 'missed schedule must not be armed');

  clearTimeout(schedules.get(1).timeoutId);
  schedules.clear();
});
