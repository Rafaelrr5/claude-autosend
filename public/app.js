// ============================================
// Claude Scheduler - Frontend Logic
// ============================================

const API = '';
let sessionCounter = 0;
let cachedWindows = [];

// ---- Load Windows ----
async function loadWindows() {
  try {
    const res = await fetch(`${API}/api/windows`);
    cachedWindows = await res.json();
  } catch {
    cachedWindows = [];
  }
  return cachedWindows;
}

// ---- Clock ----
async function updateClock() {
  try {
    const res = await fetch(`${API}/api/time`);
    const data = await res.json();
    document.getElementById('clockTime').textContent = data.spFormatted;
    const tzLabel = document.getElementById('tzLabel');
    if (tzLabel && data.timezone) tzLabel.textContent = data.timezone;
  } catch {
    const now = new Date();
    // Fallback: calcula SP localmente
    const sp = new Date(now.toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
    document.getElementById('clockTime').textContent = sp.toLocaleTimeString('pt-BR', {
      hour: '2-digit', minute: '2-digit', second: '2-digit'
    });
  }
}

updateClock();
setInterval(updateClock, 1000);

// ---- Time Preview ----
const targetTimeInput = document.getElementById('targetTime');
const timePreview = document.getElementById('timePreview');

targetTimeInput.addEventListener('input', (e) => {
  const val = e.target.value.replace(/\D/g, '').slice(0, 4);
  e.target.value = val;

  if (val.length === 4) {
    const h = parseInt(val.slice(0, 2), 10);
    const m = parseInt(val.slice(2, 4), 10);
    if (h >= 0 && h <= 23 && m >= 0 && m <= 59) {
      timePreview.textContent = `${val.slice(0, 2)}:${val.slice(2, 4)}`;
      timePreview.style.color = 'var(--text-accent)';
    } else {
      timePreview.textContent = 'inválido';
      timePreview.style.color = 'var(--error)';
    }
  } else {
    timePreview.textContent = '--:--';
    timePreview.style.color = 'var(--text-accent)';
  }
});

// ---- Sessions Management ----
const sessionsContainer = document.getElementById('sessionsContainer');

function addSession(type) {
  sessionCounter++;
  const id = `session-${sessionCounter}`;
  const div = document.createElement('div');
  div.className = 'session-item';
  div.id = id;

  // ponytail: prompt textarea por sessão, ambos os tipos
  const promptField = `<textarea class="session-prompt" data-field="prompt" rows="3" placeholder="Prompt desta sessão..." style="width:100%;margin-top:8px;background:var(--bg-secondary);color:var(--text-primary);border:1px solid var(--border);border-radius:8px;padding:8px 10px;font-family:'Inter',sans-serif;font-size:0.85rem;resize:vertical;"></textarea>`;

  if (type === 'new') {
    div.innerHTML = `
      <div style="display:flex;align-items:center;gap:8px;width:100%">
        <span class="session-badge new">NOVA</span>
        <div class="session-input" style="flex:1">
          <input type="text" placeholder="Label (ex: refactor-api)" value="Session-${sessionCounter}" data-type="new" data-field="label">
        </div>
        <button type="button" class="session-remove" onclick="removeSession('${id}')">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
            <line x1="18" y1="6" x2="6" y2="18"/>
            <line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      </div>
      ${promptField}
    `;
  } else {
    div.innerHTML = `
      <div style="display:flex;align-items:center;gap:8px;width:100%">
        <span class="session-badge existing">EXISTENTE</span>
        <div class="session-input" style="display:flex;gap:6px;align-items:center;flex:1">
          <select data-type="existing" data-field="pid" style="flex:1;background:var(--bg-secondary);color:var(--text-primary);border:1px solid var(--border);border-radius:8px;padding:8px 10px;font-family:'Inter',sans-serif;font-size:0.85rem;">
            <option value="">Carregando janelas...</option>
          </select>
          <button type="button" class="btn btn-ghost btn-sm" onclick="refreshWindowList('${id}')" title="Atualizar lista" style="padding:6px;min-width:auto;">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
              <polyline points="23 4 23 10 17 10"/>
              <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
            </svg>
          </button>
        </div>
        <button type="button" class="session-remove" onclick="removeSession('${id}')">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
            <line x1="18" y1="6" x2="6" y2="18"/>
            <line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      </div>
      ${promptField}
    `;
    // Carrega janelas no select
    populateWindowSelect(div.querySelector('select'));
  }

  sessionsContainer.appendChild(div);
}

function removeSession(id) {
  const el = document.getElementById(id);
  if (el) {
    el.style.animation = 'toastOut 0.2s ease-out forwards';
    setTimeout(() => el.remove(), 200);
  }
}

async function populateWindowSelect(select) {
  const windows = await loadWindows();
  select.innerHTML = '';
  if (windows.length === 0) {
    select.innerHTML = '<option value="">Nenhuma janela encontrada</option>';
    return;
  }
  select.innerHTML = '<option value="">Selecione uma janela...</option>';
  windows.forEach(w => {
    const label = `[${w.name}] ${w.title}`.substring(0, 80);
    const opt = document.createElement('option');
    opt.value = w.pid;
    opt.textContent = `PID ${w.pid} — ${label}`;
    select.appendChild(opt);
  });
}

async function refreshWindowList(sessionId) {
  const container = document.getElementById(sessionId);
  if (!container) return;
  const select = container.querySelector('select');
  if (!select) return;
  select.innerHTML = '<option value="">Atualizando...</option>';
  cachedWindows = []; // força refresh
  await populateWindowSelect(select);
  showToast(`${cachedWindows.length} janelas detectadas`, 'info');
}

window.refreshWindowList = refreshWindowList;

// Expose to global
window.removeSession = removeSession;

document.getElementById('addNewSession').addEventListener('click', () => addSession('new'));
document.getElementById('addExistingSession').addEventListener('click', () => addSession('existing'));

// Adiciona uma sessão nova por padrão
addSession('new');

// ---- Collect Sessions ----
function collectSessions() {
  const items = sessionsContainer.querySelectorAll('.session-item');
  const sessions = [];

  items.forEach(item => {
    const input = item.querySelector('input');
    const select = item.querySelector('select');
    const prompt = item.querySelector('.session-prompt')?.value.trim() || '';

    if (input && input.dataset.type === 'new') {
      sessions.push({ type: 'new', label: input.value.trim() || `Session-${Date.now()}`, prompt });
    } else if (select && select.dataset.type === 'existing') {
      const pid = parseInt(select.value, 10);
      if (pid) {
        const selectedText = select.options[select.selectedIndex]?.textContent || '';
        sessions.push({ type: 'existing', pid, label: selectedText, prompt });
      }
    }
  });

  return sessions;
}

// ---- Form Submit ----
const form = document.getElementById('scheduleForm');

form.addEventListener('submit', async (e) => {
  e.preventDefault();

  const time = targetTimeInput.value.trim();
  const sessions = collectSessions();

  // Validação
  if (time.length !== 4) {
    showToast('Formato de horário inválido', 'error');
    return;
  }

  const h = parseInt(time.slice(0, 2), 10);
  const m = parseInt(time.slice(2, 4), 10);
  if (h < 0 || h > 23 || m < 0 || m > 59) {
    showToast('Horário inválido', 'error');
    return;
  }

  if (sessions.length === 0) {
    showToast('Adicione pelo menos 1 sessão', 'error');
    return;
  }

  if (sessions.some(s => !s.prompt)) {
    showToast('Cada sessão precisa de um prompt', 'error');
    return;
  }

  const submitBtn = document.getElementById('submitBtn');
  submitBtn.disabled = true;
  submitBtn.innerHTML = `
    <svg class="pulse" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18">
      <circle cx="12" cy="12" r="10"/>
      <polyline points="12 6 12 12 16 14"/>
    </svg>
    Agendando...
  `;

  try {
    const res = await fetch(`${API}/api/schedule`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ time, sessions })
    });

    const data = await res.json();

    if (res.ok) {
      showToast(`Agendado para ${data.targetTime} (${data.diffMinutes} min)`, 'success');
      form.reset();
      timePreview.textContent = '--:--';
      loadSchedules();
    } else {
      showToast(data.error || 'Erro ao agendar', 'error');
    }
  } catch (err) {
    showToast('Erro de conexão com servidor', 'error');
  }

  submitBtn.disabled = false;
  submitBtn.innerHTML = `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18">
      <circle cx="12" cy="12" r="10"/>
      <polyline points="12 6 12 12 16 14"/>
    </svg>
    Agendar
  `;
});

// ---- Load Schedules ----
async function loadSchedules() {
  const container = document.getElementById('schedulesList');

  try {
    const res = await fetch(`${API}/api/schedules`);
    const schedules = await res.json();

    if (schedules.length === 0) {
      container.innerHTML = `
        <div class="empty-state">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="48" height="48">
            <circle cx="12" cy="12" r="10"/>
            <polyline points="12 6 12 12 16 14"/>
          </svg>
          <p>Nenhum agendamento ativo</p>
          <small>Crie um agendamento acima</small>
        </div>
      `;
      return;
    }

    container.innerHTML = schedules.map(s => {
      const timeFormatted = `${s.time.slice(0, 2)}:${s.time.slice(2, 4)}`;
      const statusClass = s.status;
      const statusLabel = {
        waiting: '⏳ Aguardando',
        executed: '✅ Executado',
        cancelled: '❌ Cancelado'
      }[s.status] || s.status;

      return `
        <div class="schedule-item">
          <div class="schedule-top">
            <div class="schedule-time">
              <span class="schedule-time-value">${timeFormatted}</span>
              <span class="status-badge ${statusClass} ${s.status === 'waiting' ? 'pulse' : ''}">${statusLabel}</span>
            </div>
            ${s.status === 'waiting' ? `
              <button class="btn btn-danger" onclick="cancelSchedule(${s.id})">Cancelar</button>
            ` : ''}
          </div>
          <div class="schedule-meta">
            <span>🖥️ ${s.sessions} sessão(ões)</span>
            <span>⏱️ ${s.diffMinutes} min</span>
            <span>#${s.id}</span>
          </div>
          <div class="schedule-prompt">${escapeHtml(s.prompt)}</div>
        </div>
      `;
    }).join('');
  } catch (err) {
    container.innerHTML = `
      <div class="empty-state">
        <p style="color: var(--error)">Erro ao carregar agendamentos</p>
        <small>Verifique se o servidor está rodando</small>
      </div>
    `;
  }
}

// ---- Cancel Schedule ----
async function cancelSchedule(id) {
  try {
    const res = await fetch(`${API}/api/schedule/${id}`, { method: 'DELETE' });
    if (res.ok) {
      showToast(`Agendamento #${id} cancelado`, 'info');
      loadSchedules();
    }
  } catch {
    showToast('Erro ao cancelar', 'error');
  }
}

window.cancelSchedule = cancelSchedule;

// ---- Toast ----
function showToast(message, type = 'info') {
  const container = document.getElementById('toastContainer');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;

  const icons = {
    success: '✅',
    error: '❌',
    info: 'ℹ️'
  };

  toast.innerHTML = `
    <span>${icons[type] || 'ℹ️'}</span>
    <span class="toast-text">${message}</span>
  `;

  container.appendChild(toast);

  setTimeout(() => {
    toast.style.animation = 'toastOut 0.3s ease-out forwards';
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}

// ---- Escape HTML ----
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// ---- Refresh ----
document.getElementById('refreshBtn').addEventListener('click', loadSchedules);

// ---- Init ----
loadSchedules();

// Auto-refresh a cada 30s
setInterval(loadSchedules, 30000);
