'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const express = require('express');

const launcher = require('../launcher.cjs');
const { resolveSettings, readWorkdirFile, resolveWorkdir, ensureWorkdirTemplate, locateClaude, probe,
  createLauncherApp, browserCommand, reportFailure, FriendlyError, ERROR_FILE } = launcher;

function tempDir(t, prefix = 'autosend-launcher-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function listen(t, handler) {
  return new Promise(resolve => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      t.after(() => new Promise(done => server.close(done)));
      resolve(server.address().port);
    });
  });
}

async function freePort() {
  const server = http.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}

function request(port, { method = 'GET', urlPath = '/', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('portable dashboard inline scripts parse without JavaScript syntax errors', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map(match => match[1]).filter(code => code.trim());
  assert.ok(scripts.length, 'the portable status and stop controls must be present');
  for (const code of scripts) assert.doesNotThrow(() => new (require('node:vm').Script)(code));
});

test('data lives in %LOCALAPPDATA%\\3R Studios\\Claude Autosend on the default port', () => {
  const s = resolveSettings({ LOCALAPPDATA: path.join('X:', 'Local') });
  assert.equal(s.dataFile, path.join('X:', 'Local', '3R Studios', 'Claude Autosend', 'schedules.json'));
  assert.equal(s.logDir, path.join('X:', 'Local', '3R Studios', 'Claude Autosend', 'logs'));
  assert.equal(s.workdirFile, path.join('X:', 'Local', '3R Studios', 'Claude Autosend', 'pasta-do-projeto.txt'));
  assert.equal(s.port, 3847);
  assert.equal(s.openBrowser, true);
});

test('DATA_FILE, PORT and AUTOSEND_NO_BROWSER overrides; invalid port is a friendly error', t => {
  const dir = tempDir(t);
  const s = resolveSettings({ DATA_FILE: path.join(dir, 'x.json'), PORT: '4100', AUTOSEND_NO_BROWSER: '1' });
  assert.equal(s.dataDir, dir);
  assert.equal(s.port, 4100);
  assert.equal(s.openBrowser, false);
  for (const PORT of ['0', '70000', 'abc', '12.5']) {
    assert.throws(() => resolveSettings({ PORT }), FriendlyError);
  }
});

test('project folder file: template is created once, comments ignored, quotes stripped', t => {
  const dir = tempDir(t);
  const file = path.join(dir, 'pasta-do-projeto.txt');
  ensureWorkdirTemplate(file);
  assert.equal(readWorkdirFile(file), undefined, 'template alone selects nothing');
  fs.writeFileSync(file, `\ufeff# comment\r\n\r\n  "${dir}"  \r\nignored\r\n`);
  ensureWorkdirTemplate(file);
  assert.equal(readWorkdirFile(file), dir, 'existing file is never overwritten');
  assert.equal(readWorkdirFile(path.join(dir, 'missing.txt')), undefined);
});

test('workdir: CLAUDE_WORKDIR, then project file, then home; never a missing folder', t => {
  const dir = tempDir(t);
  const home = tempDir(t);
  const file = path.join(dir, 'pasta-do-projeto.txt');
  assert.equal(resolveWorkdir({}, file, home), home);
  fs.writeFileSync(file, `${dir}\n`);
  assert.equal(resolveWorkdir({}, file, home), dir);
  assert.equal(resolveWorkdir({ CLAUDE_WORKDIR: home }, file, home), home);
  fs.writeFileSync(file, path.join(dir, 'does-not-exist'));
  assert.throws(() => resolveWorkdir({}, file, home), err => err instanceof FriendlyError && /não existe/.test(err.message));
  fs.writeFileSync(file, 'relative\\folder');
  assert.throws(() => resolveWorkdir({}, file, home), FriendlyError);
  assert.throws(() => resolveWorkdir({ CLAUDE_WORKDIR: path.join(dir, 'nope') }, file, home), FriendlyError);
});

test('locateClaude finds the official installer location, never overrides CLAUDE_BIN, reports missing', t => {
  const home = tempDir(t);
  const notFound = () => { throw new Error('claude.exe not found'); };
  assert.equal(locateClaude({ USERPROFILE: home }, notFound), null);

  const exe = path.join(home, '.local', 'bin', 'claude.exe');
  fs.mkdirSync(path.dirname(exe), { recursive: true });
  fs.writeFileSync(exe, ''); // never executed
  const env = { USERPROFILE: home };
  assert.equal(locateClaude(env, notFound), exe);
  assert.equal(env.CLAUDE_BIN, exe, 'server.js receives the fallback through CLAUDE_BIN');

  const explicit = { USERPROFILE: home, CLAUDE_BIN: path.join(home, 'gone.exe') };
  assert.equal(locateClaude(explicit, () => explicit.CLAUDE_BIN), null);
  assert.equal(explicit.CLAUDE_BIN, path.join(home, 'gone.exe'));
  assert.equal(locateClaude({ USERPROFILE: home }, () => exe), exe);
});

test('browser command is hidden cmd.exe by absolute path and only opens the local dashboard', () => {
  const [file, args, options] = browserCommand('http://127.0.0.1:3847/', { SystemRoot: 'C:\\Windows' });
  assert.equal(file, path.join('C:\\Windows', 'System32', 'cmd.exe'));
  assert.deepEqual(args, ['/d', '/s', '/c', '"start "" "http://127.0.0.1:3847/""']);
  assert.equal(options.windowsHide, true);
  assert.equal(options.windowsVerbatimArguments, true);
  for (const url of ['http://evil.example/', 'http://127.0.0.1:3847/" & calc & "', 'file:///C:/']) {
    assert.throws(() => browserCommand(url));
  }
});

test('launcher routes: identity, Host/Origin guard, token-protected stop, scheduler passthrough', async t => {
  let handler = null;
  const port = await listen(t, (req, res) => handler(req, res));
  const inner = express();
  inner.get('/api/schedules', (req, res) => res.json([]));
  let stops = 0;
  handler = createLauncherApp({ express, app: inner, port, token: 'secret-token', info: () => ({ claudeFound: false }),
    onStop: () => { stops++; } });

  const info = await request(port, { urlPath: '/api/app-info' });
  assert.equal(info.status, 200);
  const body = JSON.parse(info.body);
  assert.equal(body.app, 'claude-autosend');
  assert.equal(body.claudeFound, false);
  assert.equal(body.stopToken, 'secret-token');
  assert.deepEqual(JSON.parse((await request(port, { urlPath: '/api/schedules' })).body), []);

  // DNS rebinding and other websites are refused before reaching any route.
  assert.equal((await request(port, { urlPath: '/api/app-info', headers: { Host: `evil.example:${port}` } })).status, 403);
  assert.equal((await request(port, { urlPath: '/api/schedules', headers: { Origin: 'https://evil.example' } })).status, 403);

  const origin = `http://127.0.0.1:${port}`;
  const stop = headers => request(port, { method: 'POST', urlPath: '/api/app/stop', headers });
  assert.equal((await stop({ Origin: origin })).status, 403, 'token required');
  assert.equal((await stop({ Origin: origin, 'X-Autosend-Token': 'secret-tokem' })).status, 403, 'wrong token');
  assert.equal((await stop({ 'X-Autosend-Token': 'secret-token' })).status, 403, 'Origin required');
  assert.equal((await stop({ Origin: 'https://evil.example', 'X-Autosend-Token': 'secret-token' })).status, 403);
  assert.equal(stops, 0);
  assert.equal((await stop({ Origin: `http://localhost:${port}`, Host: `localhost:${port}`, 'X-Autosend-Token': 'secret-token' })).status, 200);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(stops, 1);
});

test('probe tells a free port, another program and a running Claude Autosend apart', async t => {
  assert.equal(await probe(await freePort()), 'free');
  const other = await listen(t, (req, res) => res.end('<html>another app</html>'));
  assert.equal(await probe(other), 'other');
  const ours = await listen(t, (req, res) => res.end(JSON.stringify({ app: 'claude-autosend' })));
  assert.equal(await probe(ours), 'ours');
});

test('reportFailure writes the message the .vbs shows; unexpected errors point to the log', t => {
  const dir = tempDir(t);
  const env = { DATA_FILE: path.join(dir, 'schedules.json') };
  const errorFile = path.join(dir, 'logs', ERROR_FILE);
  const quiet = console.error;
  console.error = () => {};
  try {
    assert.equal(reportFailure(new FriendlyError('A porta 3847 já está em uso'), env), 2);
    assert.equal(fs.readFileSync(errorFile, 'utf8'), 'A porta 3847 já está em uso');
    assert.equal(reportFailure(new Error('boom'), env), 1);
  } finally {
    console.error = quiet;
  }
  assert.match(fs.readFileSync(errorFile, 'utf8'), /erro inesperado:\nboom[\s\S]*claude-autosend\.log/);
});

// End to end with the real launcher process on isolated storage. The browser
// is disabled, PATH holds no Claude, no schedule is created and no window is
// touched; the child is stopped through its own stop route.
function runLauncher(t, env) {
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'launcher.cjs')], {
    env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  child.stdout.on('data', d => { output += d; });
  child.stderr.on('data', d => { output += d; });
  const exited = new Promise(resolve => child.on('exit', code => resolve(code)));
  t.after(() => { if (child.exitCode === null) child.kill(); });
  return { child, exited, output: () => output };
}

function isolatedEnv(root, port) {
  const home = path.join(root, 'home');
  fs.mkdirSync(home, { recursive: true });
  return {
    SystemRoot: process.env.SystemRoot, PATH: path.join(process.env.SystemRoot || 'C:\\Windows', 'System32'),
    LOCALAPPDATA: path.join(root, 'local'), APPDATA: path.join(root, 'roaming'), USERPROFILE: home,
    TEMP: os.tmpdir(), TMP: os.tmpdir(), PORT: String(port), AUTOSEND_NO_BROWSER: '1'
  };
}

test('launcher process: starts on isolated storage, reports missing Claude, reopens, stops on request',
  { skip: process.platform !== 'win32' }, async t => {
    const root = tempDir(t, 'autosend launcher e2e ');
    const port = await freePort();
    const env = isolatedEnv(root, port);
    const run = runLauncher(t, env);
    const deadline = Date.now() + 15000;
    while (await probe(port, 300) !== 'ours') {
      assert.ok(Date.now() < deadline, `launcher did not start: ${run.output()}`);
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    const dataDir = path.join(env.LOCALAPPDATA, '3R Studios', 'Claude Autosend');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dataDir, 'schedules.json'), 'utf8')), []);
    assert.ok(fs.existsSync(path.join(dataDir, 'pasta-do-projeto.txt')));
    assert.match(fs.readFileSync(path.join(dataDir, 'logs', 'claude-autosend.log'), 'utf8'), /Ready at/);

    const info = JSON.parse((await request(port, { urlPath: '/api/app-info' })).body);
    assert.equal(info.claudeFound, false);
    assert.equal(info.workdir, env.USERPROFILE, 'new sessions start in the user folder, not the app folder');
    assert.equal(info.dataDir, dataDir);
    assert.deepEqual(JSON.parse((await request(port, { urlPath: '/api/schedules' })).body), []);
    assert.match((await request(port, { urlPath: '/' })).body, /Primeiros passos/);

    // A second double-click finds the running copy and exits without touching it.
    const again = runLauncher(t, env);
    assert.equal(await again.exited, 0);
    assert.match(again.output(), /Already running/);

    const stopped = await request(port, { method: 'POST', urlPath: '/api/app/stop',
      headers: { Origin: `http://127.0.0.1:${port}`, 'X-Autosend-Token': info.stopToken } });
    assert.equal(stopped.status, 200);
    assert.equal(await run.exited, 0);
    assert.equal(await probe(port, 300), 'free');
  });

test('launcher process: a port held by another program is a friendly error, not that program\'s page',
  { skip: process.platform !== 'win32' }, async t => {
    const root = tempDir(t, 'autosend launcher busy ');
    const port = await listen(t, (req, res) => res.end('<html>another app</html>'));
    const env = isolatedEnv(root, port);
    const run = runLauncher(t, env);
    assert.equal(await run.exited, 2);
    const message = fs.readFileSync(path.join(env.LOCALAPPDATA, '3R Studios', 'Claude Autosend', 'logs', ERROR_FILE), 'utf8');
    assert.match(message, new RegExp(`porta ${port}.*outro programa`));
    assert.ok(!fs.existsSync(path.join(env.LOCALAPPDATA, '3R Studios', 'Claude Autosend', 'schedules.json')),
      'schedules are never touched when the port is busy');
  });
