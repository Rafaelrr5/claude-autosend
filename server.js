const express = require('express');
const { exec } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');

// ---------------------------------------------------------------------------
// Configuration (see .env.example)
// ---------------------------------------------------------------------------
const PORT = parseInt(process.env.PORT || '3847', 10);
// Bind to loopback by default: this server executes shell commands on the host,
// so it must never be reachable from the network unless the operator opts in.
const HOST = process.env.HOST || '127.0.0.1';
// Working directory Claude Code is launched in. Defaults to this project.
const CLAUDE_WORKDIR = process.env.CLAUDE_WORKDIR || process.cwd();
// Extra flags passed to the `claude` CLI. Empty by default on purpose:
// `--dangerously-skip-permissions` must be an explicit operator decision.
const CLAUDE_FLAGS = process.env.CLAUDE_FLAGS || '';
// IANA timezone used to interpret the scheduled HH:MM wall-clock time.
const TIMEZONE = process.env.TZ_NAME || 'America/Sao_Paulo';

if (process.platform !== 'win32') {
  console.error('claude-autosend drives Windows windows via PowerShell and only runs on Windows.');
  console.error(`Detected platform: ${process.platform}`);
  process.exit(1);
}

if (!fs.existsSync(CLAUDE_WORKDIR)) {
  console.error(`CLAUDE_WORKDIR does not exist: ${CLAUDE_WORKDIR}`);
  process.exit(1);
}

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Scheduled jobs live in memory only: restarting the server clears them.
const schedules = new Map();
let scheduleIdCounter = 0;

// ---------------------------------------------------------------------------
// Time helpers
// ---------------------------------------------------------------------------

// Current wall-clock parts in the configured timezone. Uses Intl so DST and
// offset changes are handled by the runtime instead of hardcoded arithmetic.
function nowInTimezone(tz = TIMEZONE) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  }).formatToParts(new Date());

  const p = {};
  for (const part of parts) {
    if (part.type !== 'literal') p[part.type] = parseInt(part.value, 10);
  }
  if (p.hour === 24) p.hour = 0; // some ICU versions report midnight as 24
  return p;
}

function formatNow(tz = TIMEZONE) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  }).format(new Date());
}

// Milliseconds until the next occurrence of HHMM in the configured timezone.
function msUntilTarget(timeStr) {
  const hours = parseInt(timeStr.slice(0, 2), 10);
  const minutes = parseInt(timeStr.slice(2, 4), 10);

  const now = nowInTimezone();
  const nowSec = now.hour * 3600 + now.minute * 60 + now.second;
  const targetSec = hours * 3600 + minutes * 60;

  let diffSec = targetSec - nowSec;
  if (diffSec <= 0) diffSec += 86400; // already passed today -> tomorrow

  return {
    diffMs: diffSec * 1000,
    targetTime: `${timeStr.slice(0, 2)}:${timeStr.slice(2, 4)}`,
    scheduledAt: new Date(Date.now() + diffSec * 1000).toISOString()
  };
}

function isValidTime(timeStr) {
  if (typeof timeStr !== 'string' || !/^\d{4}$/.test(timeStr)) return false;
  const h = parseInt(timeStr.slice(0, 2), 10);
  const m = parseInt(timeStr.slice(2, 4), 10);
  return h >= 0 && h <= 23 && m >= 0 && m <= 59;
}

// ---------------------------------------------------------------------------
// PowerShell helpers
// ---------------------------------------------------------------------------

// Quote a value as a PowerShell single-quoted literal: backslashes stay
// intact, only the quote character needs doubling. Every interpolated value
// below goes through this — never build PowerShell with raw concatenation.
const psq = (s) => `'${String(s).replace(/'/g, "''")}'`;

function runPowerShell(script) {
  return new Promise((resolve, reject) => {
    exec(script, { shell: 'powershell.exe', windowsHide: true }, (error, stdout, stderr) => {
      if (error) return reject(new Error(stderr || error.message));
      resolve(stdout);
    });
  });
}

// Open a new Claude Code session in a fresh PowerShell window.
// The prompt travels via a temp file and is read into a variable, so the CLI
// receives exactly one argument regardless of quoting or whitespace.
async function openNewClaudeSession(prompt, sessionLabel) {
  const stamp = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const promptFile = path.join(os.tmpdir(), `claude_prompt_${stamp}.txt`);
  const scriptFile = path.join(os.tmpdir(), `claude_run_${stamp}.ps1`);

  fs.writeFileSync(promptFile, prompt, 'utf8');
  fs.writeFileSync(scriptFile, `
$prompt = [System.IO.File]::ReadAllText(${psq(promptFile)})
Write-Host ${psq(`=== claude-autosend - ${sessionLabel} ===`)} -ForegroundColor Cyan
Set-Location -Path ${psq(CLAUDE_WORKDIR)}
claude ${CLAUDE_FLAGS} $prompt
Remove-Item ${psq(promptFile)} -ErrorAction SilentlyContinue
Remove-Item ${psq(scriptFile)} -ErrorAction SilentlyContinue
`, 'utf8');

  // -File takes a single path: no space-joining, no quote splitting.
  await runPowerShell(
    `Start-Process powershell -ArgumentList '-NoExit','-ExecutionPolicy','Bypass','-File',${psq(scriptFile)}`
  );

  console.log(`Session "${sessionLabel}" started`);
  return { label: sessionLabel, status: 'started' };
}

// List visible windows (non-empty MainWindowTitle).
async function listVisibleWindows() {
  const stdout = await runPowerShell(`
Get-Process | Where-Object { $_.MainWindowTitle -ne '' -and $_.MainWindowHandle -ne 0 } | ForEach-Object {
  [PSCustomObject]@{ pid = $_.Id; title = $_.MainWindowTitle; name = $_.ProcessName }
} | ConvertTo-Json -Compress
`);

  try {
    const parsed = JSON.parse(stdout.trim());
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
}

// Send a prompt to an already-running window by PID, via clipboard + SendKeys.
async function sendToExistingWindow(pid, prompt) {
  const numericPid = parseInt(pid, 10);
  if (!Number.isInteger(numericPid) || numericPid <= 0) {
    throw new Error(`Invalid PID: ${pid}`);
  }

  const tmpFile = path.join(os.tmpdir(), `claude_prompt_${numericPid}_${Date.now()}.txt`);
  fs.writeFileSync(tmpFile, prompt, 'utf8');

  try {
    const stdout = await runPowerShell(`
$wshell = New-Object -ComObject WScript.Shell
$proc = Get-Process -Id ${numericPid} -ErrorAction SilentlyContinue
if ($proc -and $proc.MainWindowHandle -ne 0) {
  $promptText = [System.IO.File]::ReadAllText(${psq(tmpFile)})
  Set-Clipboard -Value $promptText
  [void]$wshell.AppActivate($proc.Id)
  Start-Sleep -Milliseconds 800
  $wshell.SendKeys("^v")
  Start-Sleep -Milliseconds 500
  $wshell.SendKeys("{ENTER}")
  Write-Output "Sent to PID ${numericPid}: $($proc.MainWindowTitle)"
} else {
  Write-Error "PID ${numericPid} not found or has no window"
}
`);
    console.log(`Sent to PID ${numericPid}: ${stdout.trim()}`);
    return { pid: numericPid, status: 'sent', output: stdout.trim() };
  } finally {
    fs.rmSync(tmpFile, { force: true });
  }
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

// Create a schedule
app.post('/api/schedule', (req, res) => {
  const { time, sessions } = req.body || {};

  if (!isValidTime(time)) {
    return res.status(400).json({ error: 'Invalid time: expected HHMM (0000-2359)' });
  }
  if (!Array.isArray(sessions) || sessions.length === 0) {
    return res.status(400).json({ error: 'At least one session is required' });
  }
  if (sessions.some((s) => !s || !s.prompt || !String(s.prompt).trim())) {
    return res.status(400).json({ error: 'Every session needs a prompt' });
  }
  if (sessions.some((s) => s.type !== 'new' && s.type !== 'existing')) {
    return res.status(400).json({ error: 'Session type must be "new" or "existing"' });
  }

  const { diffMs, targetTime, scheduledAt } = msUntilTarget(time);
  const id = ++scheduleIdCounter;

  const timeoutId = setTimeout(async () => {
    console.log(`Schedule #${id} fired`);
    const results = [];

    for (const session of sessions) {
      try {
        if (session.type === 'new') {
          results.push(await openNewClaudeSession(session.prompt, session.label || `Session-${id}`));
        } else {
          results.push(await sendToExistingWindow(session.pid, session.prompt));
        }
      } catch (err) {
        results.push({
          label: session.label || session.windowTitle,
          status: 'error',
          error: err.message
        });
      }
    }

    const schedule = schedules.get(id);
    if (schedule) {
      schedule.status = 'executed';
      schedule.results = results;
      schedule.executedAt = new Date().toISOString();
    }

    console.log(`Schedule #${id} results:`, results);
  }, diffMs);

  const schedule = {
    id,
    time,
    sessions,
    status: 'waiting',
    createdAt: new Date().toISOString(),
    scheduledAt,
    diffMs,
    diffMinutes: Math.round(diffMs / 60000),
    timeoutId
  };

  schedules.set(id, schedule);

  console.log(`Schedule #${id} created for ${targetTime} (${TIMEZONE}) in ${schedule.diffMinutes} min, ${sessions.length} session(s)`);

  res.json({
    id,
    status: schedule.status,
    targetTime: `${targetTime} (${TIMEZONE})`,
    diffMinutes: schedule.diffMinutes,
    sessionCount: sessions.length
  });
});

// List schedules
app.get('/api/schedules', (req, res) => {
  const list = [];
  for (const s of schedules.values()) {
    list.push({
      id: s.id,
      time: s.time,
      prompt: s.sessions
        .map((se) => `[${se.label || se.type}] ${se.prompt}`)
        .join('\n')
        .substring(0, 200),
      status: s.status,
      sessions: s.sessions.length,
      diffMinutes: s.diffMinutes,
      createdAt: s.createdAt,
      executedAt: s.executedAt || null,
      results: s.results || null
    });
  }
  res.json(list);
});

// Cancel a schedule
app.delete('/api/schedule/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const schedule = schedules.get(id);
  if (!schedule) return res.status(404).json({ error: 'Schedule not found' });
  if (schedule.timeoutId) clearTimeout(schedule.timeoutId);
  schedule.status = 'cancelled';
  res.json({ id, status: 'cancelled' });
});

// List visible windows
app.get('/api/windows', async (req, res) => {
  try {
    res.json(await listVisibleWindows());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Current time in the configured timezone
app.get('/api/time', (req, res) => {
  res.json({
    timezone: TIMEZONE,
    spFormatted: formatNow(),
    localTime: new Date().toISOString()
  });
});

app.listen(PORT, HOST, () => {
  console.log(`claude-autosend running at http://${HOST}:${PORT}`);
  console.log(`  timezone : ${TIMEZONE}`);
  console.log(`  workdir  : ${CLAUDE_WORKDIR}`);
  console.log(`  cli flags: ${CLAUDE_FLAGS || '(none)'}`);
});
