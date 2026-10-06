'use strict';

// Builds dist/Claude-Autosend-Windows-x64.zip: a portable folder with the
// bundled node.exe, production dependencies and a double-click launcher.
//
//   node build-windows.cjs
//
// AUTOSEND_NODE_EXE  node.exe to bundle (default: the one running this script)
// AUTOSEND_NPM_CLI   npm-cli.js used for `npm ci` (default: next to node.exe)
// PYTHON             Python 3 used to write the ZIP (default: python, then py)

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ROOT = __dirname;
const DIST = path.join(ROOT, 'dist');
const NAME = 'Claude-Autosend';
const ZIP = path.join(DIST, `${NAME}-Windows-x64.zip`);
const STAGE = path.join(DIST, 'stage', NAME);
const APP = path.join(STAGE, 'app');
// Fixed timestamp so the same inputs give the same ZIP.
const ZIP_DATE = [2026, 1, 1, 0, 0, 0];

// Everything copied from the repository. Nothing else from the source tree
// (schedules, attachments, .env, logs, tests, git data) can end up in the ZIP.
const SOURCE_FILES = ['server.js', 'launcher.cjs', 'package.json', 'package-lock.json', 'LICENSE',
  'public/index.html', 'public/app.js', 'public/style.css'];
const FORBIDDEN = [/(^|\/)\.env/i, /(^|\/)schedules[^/]*\.json/i, /\.attachments(\/|$)/i, /\.log$/i, /(^|\/)\.npmrc$/i,
  /(^|\/)\.git(\/|$)/, /^app\/(test|docs|\.github)\//];

const crlf = text => text.replace(/\r?\n/g, '\r\n');

function run(file, args, options = {}) {
  const result = spawnSync(file, args, { stdio: 'inherit', windowsHide: true, ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${path.basename(file)} exited with ${result.status}`);
  return result;
}

// Machine field of the PE header: 0x8664 is x64.
function assertWindowsX64(exe) {
  const buffer = fs.readFileSync(exe);
  const pe = buffer.readUInt32LE(0x3c);
  if (buffer.toString('latin1', pe, pe + 4) !== 'PE\0\0' || buffer.readUInt16LE(pe + 4) !== 0x8664) {
    throw new Error(`${exe} is not a Windows x64 executable`);
  }
}

function walk(dir, base = dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Refusing symlink in bundle: ${full}`);
    return entry.isDirectory() ? walk(full, base) : [path.relative(base, full).split(path.sep).join('/')];
  }).sort();
}

// LICENSE file, else the "License" section of the README (cookie-signature
// ships its MIT text only there).
function licenseText(dir) {
  const names = fs.readdirSync(dir);
  const file = names.find(name => /^licen[cs]e(\.|$)/i.test(name));
  if (file) return fs.readFileSync(path.join(dir, file), 'utf8').trim();
  const readme = names.find(name => /^readme\.md$/i.test(name));
  const section = readme && /^#+ *licen[cs]e *\r?\n([\s\S]+)/im.exec(fs.readFileSync(path.join(dir, readme), 'utf8'));
  return section && /Permission is hereby granted/.test(section[1]) ? section[1].trim() : null;
}

function packages(nodeModules) {
  return fs.readdirSync(nodeModules).filter(name => !name.startsWith('.')).sort().flatMap(name =>
    name.startsWith('@')
      ? fs.readdirSync(path.join(nodeModules, name)).sort().map(sub => path.join(nodeModules, name, sub))
      : [path.join(nodeModules, name)]);
}

function thirdPartyNotices(nodeExe, nodeVersion) {
  const nodeLicense = path.join(path.dirname(nodeExe), 'LICENSE');
  if (!fs.existsSync(nodeLicense)) throw new Error(`Node.js LICENSE not found next to ${nodeExe}`);
  const sections = [
    'Claude Autosend - avisos de terceiros / third-party notices',
    'Este pacote inclui os componentes abaixo, cada um sob a sua propria licenca.',
    'This bundle includes the components below, each under its own license.',
    `\n${'='.repeat(78)}\nNode.js ${nodeVersion} (app/runtime/node.exe) - https://nodejs.org/\n${'='.repeat(78)}\n`,
    fs.readFileSync(nodeLicense, 'utf8').trim()
  ];
  for (const dir of packages(path.join(APP, 'node_modules'))) {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    const text = licenseText(dir);
    if (!text) throw new Error(`No license file for ${pkg.name}@${pkg.version}`);
    sections.push(`\n${'='.repeat(78)}\n${pkg.name}@${pkg.version} (${pkg.license}) - app/node_modules/${pkg.name}\n${'='.repeat(78)}\n`, text);
  }
  return sections.join('\n') + '\n';
}

function readmeGuide() {
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8').replace(/\r\n/g, '\n');
  const match = /<!-- guia-ptbr:inicio -->\n([\s\S]*?)<!-- guia-ptbr:fim -->/.exec(readme);
  if (!match) throw new Error('pt-BR guide markers missing from README.md');
  // Plain text for Notepad: drop Markdown emphasis and code marks.
  return match[1].replace(/^### Guia rápido \(português\)/, 'CLAUDE AUTOSEND - GUIA RÁPIDO').replace(/\*\*|`/g, '');
}

const FALLBACK_CMD = `@echo off
rem Alternativa ao Abrir-Claude-Autosend.vbs para Windows sem VBScript.
chcp 65001 >nul
title Claude Autosend
echo Claude Autosend: deixe esta janela aberta (pode minimizar).
echo Para encerrar, use o botao "Encerrar Claude Autosend" no painel.
echo.
cd /d "%USERPROFILE%"
"%~dp0runtime\\node.exe" "%~dp0launcher.cjs"
if errorlevel 1 (
  echo.
  type "%LOCALAPPDATA%\\3R Studios\\Claude Autosend\\logs\\ultimo-erro.txt" 2>nul
  echo.
  pause
)
`;

const ZIP_SCRIPT = `
import os, sys, zipfile
stage, out, date = sys.argv[1], sys.argv[2], tuple(int(x) for x in sys.argv[3].split(','))
root = os.path.dirname(stage)
names = []
for base, dirs, files in os.walk(stage):
    dirs.sort()
    names += [os.path.join(base, f) for f in sorted(files)]
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as z:
    for full in names:
        info = zipfile.ZipInfo(os.path.relpath(full, root).replace(os.sep, '/'), date)
        info.compress_type = zipfile.ZIP_DEFLATED
        info.external_attr = 0o644 << 16
        with open(full, 'rb') as f:
            z.writestr(info, f.read(), compresslevel=9)
with zipfile.ZipFile(out) as z:
    bad = z.testzip()
    if bad: sys.exit('corrupt entry: ' + bad)
    print(len(z.namelist()), 'files in', out)
`;

function findPython() {
  const candidates = process.env.PYTHON ? [[process.env.PYTHON]] : [['python'], ['py', '-3']];
  for (const [file, ...args] of candidates) {
    const probe = spawnSync(file, [...args, '-c', 'import sys; assert sys.version_info >= (3, 7)'], { windowsHide: true });
    if (probe.status === 0) return [file, args];
  }
  throw new Error('Python 3 not found: set PYTHON to python.exe');
}

function build() {
  if (process.platform !== 'win32') throw new Error('Build the Windows bundle on Windows');
  const nodeExe = path.resolve(process.env.AUTOSEND_NODE_EXE || process.execPath);
  assertWindowsX64(nodeExe);
  const nodeVersion = spawnSync(nodeExe, ['--version'], { encoding: 'utf8', windowsHide: true }).stdout.trim();
  const npmCli = path.resolve(process.env.AUTOSEND_NPM_CLI ||
    path.join(path.dirname(nodeExe), 'node_modules', 'npm', 'bin', 'npm-cli.js'));
  if (!fs.existsSync(npmCli)) throw new Error(`npm-cli.js not found: ${npmCli} (set AUTOSEND_NPM_CLI)`);
  const python = findPython();

  fs.rmSync(path.join(DIST, 'stage'), { recursive: true, force: true });
  fs.rmSync(ZIP, { force: true });
  for (const file of SOURCE_FILES) {
    fs.mkdirSync(path.dirname(path.join(APP, file)), { recursive: true });
    fs.copyFileSync(path.join(ROOT, file), path.join(APP, file));
  }
  fs.mkdirSync(path.join(APP, 'runtime'));
  fs.copyFileSync(nodeExe, path.join(APP, 'runtime', 'node.exe'));

  // Production dependencies exactly as locked, from the public registry,
  // without install scripts and with a private cache.
  run(process.execPath, [npmCli, 'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund',
    '--cache', path.join(DIST, '.npm-cache')], { cwd: APP, env: { ...process.env, npm_config_update_notifier: 'false' } });
  fs.rmSync(path.join(APP, 'node_modules', '.package-lock.json'), { force: true });
  fs.rmSync(path.join(APP, 'node_modules', '.bin'), { recursive: true, force: true });

  fs.writeFileSync(path.join(STAGE, 'Abrir-Claude-Autosend.vbs'), crlf(fs.readFileSync(path.join(ROOT, 'Abrir.vbs'), 'utf8')));
  fs.writeFileSync(path.join(APP, 'abrir-com-janela.cmd'), crlf(FALLBACK_CMD));
  fs.writeFileSync(path.join(STAGE, 'LEIA-ME.txt'), '﻿' + crlf(readmeGuide()));
  fs.writeFileSync(path.join(STAGE, 'THIRD_PARTY_NOTICES.txt'), crlf(thirdPartyNotices(nodeExe, nodeVersion)));

  const files = walk(STAGE);
  const leaked = files.filter(file => FORBIDDEN.some(pattern => pattern.test(file)));
  if (leaked.length) throw new Error(`Refusing to package: ${leaked.join(', ')}`);
  const top = [...new Set(files.map(file => file.split('/')[0]))].sort();
  const expectedTop = ['Abrir-Claude-Autosend.vbs', 'LEIA-ME.txt', 'THIRD_PARTY_NOTICES.txt', 'app'];
  if (top.join() !== expectedTop.join()) throw new Error(`Unexpected top-level entries: ${top.join(', ')}`);

  const manifest = files.map(file => {
    const bytes = fs.readFileSync(path.join(STAGE, file));
    return `${crypto.createHash('sha256').update(bytes).digest('hex')}  ${String(bytes.length).padStart(9)}  ${NAME}/${file}`;
  });
  fs.writeFileSync(path.join(DIST, `${NAME}-Windows-x64.files.txt`),
    `# ${NAME} portable, Node.js ${nodeVersion} win-x64, ${files.length} files\n# sha256  bytes  path\n${manifest.join('\n')}\n`);

  run(python[0], [...python[1], '-c', ZIP_SCRIPT, STAGE, ZIP, ZIP_DATE.join(',')]);
  const zipHash = crypto.createHash('sha256').update(fs.readFileSync(ZIP)).digest('hex');
  console.log(`${ZIP}\n  ${fs.statSync(ZIP).size} bytes, sha256 ${zipHash}\n  Node.js ${nodeVersion}, ${files.length} files`);
}

if (require.main === module) {
  try {
    build();
  } catch (err) {
    console.error(`Build failed: ${err.message}`);
    process.exit(1);
  }
}
