'use strict';

// Portable Windows launcher. Abrir-Claude-Autosend.vbs runs this with the
// bundled node.exe and no console window. It keeps user data out of the
// extracted folder, refuses to start on a port owned by another program,
// opens the browser only once the dashboard answers, and adds a local
// "stop" control. Exit codes: 0 ok, 2 friendly error in ERROR_FILE, 1 crash.

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const util = require('util');
const { spawn } = require('child_process');
const { randomBytes, timingSafeEqual } = require('crypto');

const APP_ID = 'claude-autosend';
const DEFAULT_PORT = 3847;
const DATA_SUBDIR = path.join('3R Studios', 'Claude Autosend');
const WORKDIR_FILE = 'pasta-do-projeto.txt';
const ERROR_FILE = 'ultimo-erro.txt';
const INSTALL_DOCS = 'https://code.claude.com/docs/en/setup';

class FriendlyError extends Error {}

// Where everything lives. DATA_FILE is an explicit override for tests; real
// runs use %LOCALAPPDATA%\3R Studios\Claude Autosend.
function resolveSettings(env = process.env) {
  const dataFile = env.DATA_FILE
    ? path.resolve(env.DATA_FILE)
    : path.join(env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), DATA_SUBDIR, 'schedules.json');
  const dataDir = path.dirname(dataFile);
  const port = env.PORT ? Number(env.PORT) : DEFAULT_PORT;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new FriendlyError(`Porta inválida: ${env.PORT}`);
  return {
    dataFile, dataDir, port,
    logDir: path.join(dataDir, 'logs'),
    workdirFile: path.join(dataDir, WORKDIR_FILE),
    openBrowser: env.AUTOSEND_NO_BROWSER !== '1'
  };
}

const WORKDIR_TEMPLATE = [
  '# Claude Autosend - pasta do projeto',
  '#',
  '# As sessões novas do Claude abrem na pasta escrita numa linha abaixo (sem # na frente).',
  '# Dica: no Explorador de Arquivos, clique com o botão direito na pasta,',
  '# escolha "Copiar como caminho" e cole aqui. As aspas podem ficar.',
  '# Sem nenhuma linha, é usada a sua pasta de usuário.',
  '# Depois de salvar, clique em "Encerrar" no painel e abra o Claude Autosend de novo.',
  ''
].join('\r\n');

function ensureWorkdirTemplate(file) {
  if (!fs.existsSync(file)) fs.writeFileSync(file, WORKDIR_TEMPLATE, { encoding: 'utf8', flag: 'wx' });
}

// First non-comment line of pasta-do-projeto.txt, with "Copy as path" quotes removed.
function readWorkdirFile(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
  const line = text.replace(/^\ufeff/, '').split(/\r?\n/).map(l => l.trim()).find(l => l && !l.startsWith('#'));
  return line ? line.replace(/^"(.*)"$/, '$1').trim() : undefined;
}

function isDirectory(dir) {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

// Folder new Claude sessions start in: CLAUDE_WORKDIR, then the project file,
// then the user's home folder (never the extracted app folder).
function resolveWorkdir(env, workdirFile, home = os.homedir()) {
  if (env.CLAUDE_WORKDIR) {
    if (!isDirectory(env.CLAUDE_WORKDIR)) throw new FriendlyError(`A pasta CLAUDE_WORKDIR não existe: ${env.CLAUDE_WORKDIR}`);
    return path.resolve(env.CLAUDE_WORKDIR);
  }
  const chosen = readWorkdirFile(workdirFile);
  if (chosen) {
    if (!path.isAbsolute(chosen) || !isDirectory(chosen)) {
      throw new FriendlyError(`A pasta do projeto escrita em ${workdirFile} não existe:\n${chosen}\n\n` +
        'Corrija o caminho nesse arquivo (ou apague a linha) e abra o Claude Autosend de novo.');
    }
    return path.resolve(chosen);
  }
  return home;
}

// Path to claude.exe, or null. Also checks the default locations of the
// official installer and of npm, since a fresh install may not be on PATH
// yet; a hit there is handed to server.js through CLAUDE_BIN.
function locateClaude(env, findClaudeExe) {
  try {
    const found = findClaudeExe(env);
    if (fs.existsSync(found)) return found;
  } catch {}
  if (env.CLAUDE_BIN) return null; // never override an explicit choice
  const home = env.USERPROFILE || os.homedir();
  const candidates = [path.join(home, '.local', 'bin', 'claude.exe')];
  if (env.APPDATA) candidates.push(path.join(env.APPDATA, 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'));
  const hit = candidates.find(file => fs.existsSync(file));
  if (hit) env.CLAUDE_BIN = hit;
  return hit || null;
}

// What is listening on the port: nothing, this app, or another program.
function probe(port, timeoutMs = 1500) {
  return new Promise(resolve => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/app-info', timeout: timeoutMs }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { if (body.length < 65536) body += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(body).app === APP_ID ? 'ours' : 'other');
        } catch {
          resolve('other');
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', err => resolve(err.code === 'ECONNREFUSED' ? 'free' : 'other'));
  });
}

async function waitUntilReady(port, attempts = 50) {
  for (let i = 0; i < attempts; i++) {
    if (await probe(port) === 'ours') return true;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  return false;
}

function portBusyError(port) {
  return new FriendlyError(`A porta ${port} deste computador já está sendo usada por outro programa, ` +
    'então o Claude Autosend não pôde abrir.\n\nFeche o programa que usa essa porta (ou reinicie o computador) e tente de novo.');
}

// Wrap the scheduler app with a Host/Origin guard (blocks other websites and
// DNS rebinding), an identity endpoint and a token-protected stop route.
function createLauncherApp({ express, app, port, token, info, onStop }) {
  const origins = [`http://127.0.0.1:${port}`, `http://localhost:${port}`];
  const hosts = origins.map(origin => origin.slice('http://'.length));
  const outer = express();
  outer.disable('x-powered-by');
  outer.use((req, res, next) => {
    if (!hosts.includes(req.headers.host)) return res.status(403).json({ error: 'Forbidden host' });
    if (req.headers.origin && !origins.includes(req.headers.origin)) return res.status(403).json({ error: 'Forbidden origin' });
    next();
  });
  outer.get('/api/app-info', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ app: APP_ID, ...info(), stopToken: token });
  });
  outer.post('/api/app/stop', (req, res) => {
    const given = Buffer.from(String(req.get('x-autosend-token') || ''));
    const expected = Buffer.from(token);
    // Browsers always send Origin on POST; requiring it keeps this to our own page.
    if (!req.headers.origin || given.length !== expected.length || !timingSafeEqual(given, expected)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    res.on('finish', onStop);
    res.json({ stopping: true });
  });
  outer.use(app);
  return outer;
}

// `start "" url` hands the URL to the default browser. Full cmd.exe path so a
// cmd.exe in the working directory is never picked up.
function browserCommand(url, env = process.env) {
  if (!/^http:\/\/127\.0\.0\.1:\d{1,5}\/$/.test(url)) throw new Error(`Refusing to open ${url}`);
  const cmd = path.join(env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe');
  return [cmd, ['/d', '/s', '/c', `"start "" "${url}""`],
    { windowsVerbatimArguments: true, windowsHide: true, detached: true, stdio: 'ignore' }];
}

function openBrowser(url, enabled) {
  if (!enabled) return console.log(`Browser launch disabled; dashboard at ${url}`);
  const [file, args, options] = browserCommand(url);
  const child = spawn(file, args, options);
  child.on('error', err => console.error('Unable to open the browser:', err.message));
  child.unref();
}

// The launcher has no console: mirror console output to a log file.
function setupLog(logDir) {
  fs.mkdirSync(logDir, { recursive: true });
  const file = path.join(logDir, 'claude-autosend.log');
  try {
    if (fs.statSync(file).size > 5 * 1024 * 1024) fs.renameSync(file, `${file}.old`);
  } catch {}
  for (const level of ['log', 'info', 'warn', 'error']) {
    const original = console[level].bind(console);
    console[level] = (...args) => {
      try {
        fs.appendFileSync(file, `${new Date().toISOString()} ${util.format(...args)}\n`);
      } catch {}
      original(...args);
    };
  }
  return file;
}

async function main(env = process.env) {
  if (process.platform !== 'win32') throw new FriendlyError('O Claude Autosend funciona apenas no Windows.');
  const settings = resolveSettings(env);
  const logFile = setupLog(settings.logDir);
  fs.rmSync(path.join(settings.logDir, ERROR_FILE), { force: true });
  ensureWorkdirTemplate(settings.workdirFile);
  const workdir = resolveWorkdir(env, settings.workdirFile);
  const url = `http://127.0.0.1:${settings.port}/`;

  const state = await probe(settings.port);
  if (state === 'ours') {
    console.log(`Already running at ${url}; reopening the dashboard`);
    return openBrowser(url, settings.openBrowser);
  }
  if (state === 'other') throw portBusyError(settings.port);

  // server.js reads its configuration when first required.
  Object.assign(env, { DATA_FILE: settings.dataFile, HOST: '127.0.0.1', PORT: String(settings.port), CLAUDE_WORKDIR: workdir });
  const express = require('express');
  const server = require('./server.js');
  const { version } = require('./package.json');
  const info = () => ({
    version, port: settings.port, workdir, dataDir: settings.dataDir, logFile, workdirFile: settings.workdirFile,
    installDocs: INSTALL_DOCS, claudeFound: Boolean(locateClaude(env, server.findClaudeExe))
  });

  let httpServer;
  const stop = reason => {
    console.log(`Stopping (${reason})`);
    if (httpServer) httpServer.close();
    process.exit(0);
  };
  const handler = createLauncherApp({
    express, app: server.app, port: settings.port, token: randomBytes(32).toString('hex'), info,
    onStop: () => stop('stop button')
  });

  try {
    httpServer = await server.start(handler);
  } catch (err) {
    if (err.code !== 'EADDRINUSE') throw err;
    // Lost a race with a second double-click: reuse whichever copy won.
    if (await probe(settings.port) === 'ours') return openBrowser(url, settings.openBrowser);
    throw portBusyError(settings.port);
  }
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK']) process.on(signal, () => stop(signal));

  if (!info().claudeFound) console.warn(`claude.exe not found; the dashboard explains how to install it (${INSTALL_DOCS})`);
  if (!await waitUntilReady(settings.port)) throw new Error('Dashboard did not answer after starting');
  console.log(`Ready at ${url}`);
  openBrowser(url, settings.openBrowser);
}

// The .vbs launcher shows this file in a message box when the exit code is not 0.
function reportFailure(err, env = process.env) {
  let logDir;
  try {
    logDir = resolveSettings(env).logDir;
  } catch {
    logDir = path.join(env.LOCALAPPDATA || os.tmpdir(), DATA_SUBDIR, 'logs');
  }
  const friendly = err instanceof FriendlyError;
  const message = friendly ? err.message
    : `O Claude Autosend parou por um erro inesperado:\n${err && err.message}\n\nDetalhes no registro em:\n${path.join(logDir, 'claude-autosend.log')}`;
  console.error(friendly ? err.message : err && err.stack || err);
  try {
    fs.mkdirSync(logDir, { recursive: true });
    fs.writeFileSync(path.join(logDir, ERROR_FILE), message, 'utf8');
  } catch {}
  return friendly ? 2 : 1;
}

if (require.main === module) {
  process.on('uncaughtException', err => process.exit(reportFailure(err)));
  main().catch(err => process.exit(reportFailure(err)));
}

module.exports = {
  APP_ID, DEFAULT_PORT, ERROR_FILE, INSTALL_DOCS, FriendlyError, resolveSettings, readWorkdirFile, resolveWorkdir,
  ensureWorkdirTemplate, locateClaude, probe, createLauncherApp, browserCommand, reportFailure, main
};
