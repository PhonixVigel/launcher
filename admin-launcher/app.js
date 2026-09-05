// VozduCraft Web Admin Panel Controller
const API_BASE = window.location.origin;

const state = {
  token: localStorage.getItem('vozducraft_admin_token') || '',
  adminUser: localStorage.getItem('vozducraft_admin_user') || 'VozduHAN',
  servers: [],
  currentServerId: 1,
  currentModpack: [],
  selectedModIds: new Set(),
  renderedModIds: [],
  bans: [],
  releases: [],
  stats: {}
};

// Interceptor для перехвата 401/403 и немедленного сброса сессии при удалении аккаунта
const originalFetch = window.fetch;
window.fetch = async function(...args) {
  const url = typeof args[0] === 'string' ? args[0] : (args[0]?.url || '');
  const response = await originalFetch.apply(this, args);
  if ((response.status === 401 || response.status === 403) && state.token && !url.includes('/api/v1/auth/login')) {
    handleAuthFailure('Ваш аккаунт был удален или авторизация аннулирована.');
  }
  return response;
};

function handleAuthFailure(message) {
  localStorage.removeItem('vozducraft_admin_token');
  localStorage.removeItem('vozducraft_admin_user');
  state.token = '';
  showScreen('screen-auth');
  const alertEl = document.getElementById('auth-alert');
  if (alertEl) {
    alertEl.textContent = message || 'Доступ запрещен. Сессия аннулирована.';
    alertEl.classList.remove('hidden');
  }
}

function startAuthHeartbeat() {
  setInterval(async () => {
    if (!state.token) return;
    try {
      const res = await originalFetch(`${API_BASE}/api/v1/admin/me`, {
        headers: { 'Authorization': `Bearer ${state.token}` }
      });
      if (res.status === 401 || res.status === 403) {
        handleAuthFailure('Ваш аккаунт администратора был удален. Сессия сброшена.');
      }
    } catch (_) {}
  }, 8000);
}

// ----------------------------------------------------
// 1. ИНИЦИАЛИЗАЦИЯ И НАВИГАЦИЯ
// ----------------------------------------------------
function initApp() {
  console.log('[VOZDUCRAFT ADMIN] 🚀 Initializing App v9.4 at', new Date().toISOString());

  const safeRun = (name, fn) => {
    try {
      fn();
    } catch (e) {
      console.error(`[VOZDUCRAFT ADMIN] ❌ Error in ${name}:`, e);
      if (typeof showDebugBanner === 'function') {
        showDebugBanner(`Ошибка в модуле ${name}: ${e.message}`);
      }
    }
  };

  safeRun('startClock', startClock);
  safeRun('setupNavigation', setupNavigation);
  safeRun('setupAuth', setupAuth);
  safeRun('setupServerControls', setupServerControls);
  safeRun('setupModpackControls', setupModpackControls);
  safeRun('setupCopyModsModal', setupCopyModsModal);
  safeRun('setupModrinthControls', setupModrinthControls);
  safeRun('setupReleasesControls', setupReleasesControls);
  safeRun('setupBansControls', setupBansControls);
  safeRun('setupMirrorsControls', setupMirrorsControls);
  safeRun('setupDiscordBotTab', setupDiscordBotTab);
  safeRun('setupBypassesControls', setupBypassesControls);
  safeRun('setupDebugLogsControls', setupDebugLogsControls);
  safeRun('setupCrashReportsControls', setupCrashReportsControls);
  safeRun('setupAdminsControls', setupAdminsControls);
  safeRun('setupModUpdatesControls', setupModUpdatesControls);
  safeRun('setupSftpSyncControls', setupSftpSyncControls);
  safeRun('setupLogViewerModal', setupLogViewerModal);
  safeRun('setupChangePasswordModal', setupChangePasswordModal);
  safeRun('setupEditModModal', setupEditModModal);
  safeRun('setupBulkEditGroupModal', setupBulkEditGroupModal);
  safeRun('setupGroupsHubControls', setupGroupsHubControls);
  safeRun('setupResourcePacksControls', setupResourcePacksControls);
  safeRun('setupClientServersControls', setupClientServersControls);
  safeRun('startAuthHeartbeat', startAuthHeartbeat);

  if (state.token) {
    showScreen('screen-admin');
    loadDashboardData().catch(err => console.error('[DASHBOARD DATA ERROR]', err));
  } else {
    showScreen('screen-auth');
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initApp);
} else {
  initApp();
}

function showScreen(screenId) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const target = document.getElementById(screenId);
  if (target) target.classList.add('active');
}

function startClock() {
  const update = () => {
    const clockEl = document.getElementById('server-time-display');
    if (clockEl) {
      clockEl.textContent = new Date().toLocaleTimeString('ru-RU');
    }
  };
  update();
  setInterval(update, 1000);
}

function setupNavigation() {
  const navButtons = document.querySelectorAll('.nav-item');
  navButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      navButtons.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');

      const targetTabId = `tab-${btn.dataset.tab}`;
      document.querySelectorAll('.tab-content, .dashboard-tab').forEach(t => t.classList.remove('active'));
      const targetTab = document.getElementById(targetTabId);
      if (targetTab) targetTab.classList.add('active');

      // Обновление данных для активной вкладки
      if (btn.dataset.tab === 'servers') loadServers();
      if (btn.dataset.tab === 'modpack') loadModpack();
      if (btn.dataset.tab === 'resourcepacks') loadResourcePacks();
      if (btn.dataset.tab === 'client-servers') loadClientServers();
      if (btn.dataset.tab === 'releases') loadReleases();
      if (btn.dataset.tab === 'bans') loadBans();
      if (btn.dataset.tab === 'mirrors') loadMirrors();
      if (btn.dataset.tab === 'discord') loadDiscordBotStatus();
      if (btn.dataset.tab === 'bypasses') loadBypasses();
      if (btn.dataset.tab === 'debug-logs') loadDebugLogs();
      if (btn.dataset.tab === 'crash-reports') loadCrashReports();
      if (btn.dataset.tab === 'admins') loadAdmins();
      if (btn.dataset.tab === 'analytics') loadAnalytics();
    });
  });

  const logoutBtn = document.getElementById('btn-logout');
  if (logoutBtn) {
    logoutBtn.addEventListener('click', () => {
      handleAuthFailure('Вы успешно вышли из системы');
    });
  }
}

// ----------------------------------------------------
// 2. АВТОРИЗАЦИЯ
// ----------------------------------------------------
function setupAuth() {
  const authForm = document.getElementById('admin-auth-form');
  const alertEl = document.getElementById('auth-alert');

  authForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = document.getElementById('admin-username').value.trim();
    const password = document.getElementById('admin-password').value;
    const submitBtn = authForm.querySelector('button[type="submit"]');

    if (alertEl) {
      alertEl.className = 'auth-alert hidden';
      alertEl.textContent = '';
    }

    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.textContent = '⏳ Проверка данных...';
    }

    try {
      const res = await originalFetch(`${API_BASE}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username,
          password,
          hwid: 'WEB-ADMIN-CONSOLE',
          isAdminApp: true
        })
      });

      const data = await res.json();
      if (res.ok && data.token) {
        state.token = data.token;
        state.adminUser = data.username || username;
        localStorage.setItem('vozducraft_admin_token', state.token);
        localStorage.setItem('vozducraft_admin_user', state.adminUser);

        document.getElementById('topbar-admin-name').textContent = state.adminUser;
        showScreen('screen-admin');
        loadDashboardData();
      } else {
        if (alertEl) {
          alertEl.className = 'auth-alert error';
          alertEl.textContent = data.error || 'Неверный логин или пароль администратора';
          alertEl.classList.remove('hidden');
        }
      }
    } catch (err) {
      if (alertEl) {
        alertEl.className = 'auth-alert error';
        alertEl.textContent = 'Ошибка подключения к серверу авторизации: ' + err.message;
        alertEl.classList.remove('hidden');
      }
    } finally {
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Войти в Панель Управления';
      }
    }
  });
}

function getAuthHeaders() {
  return {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${state.token || 'VOZDUHAN-ADMIN-TOKEN'}`
  };
}

async function loadDashboardData() {
  await loadServers();
  await loadModpack();
  await loadReleases();
  await loadBans();
  await loadAnalytics();
}

// ----------------------------------------------------
// 3. УПРАВЛЕНИЕ СЕРВЕРАМИ (МУЛЬТИСЕРВЕРНОСТЬ)
// ----------------------------------------------------
function setupServerControls() {
  const btnOpenAdd = document.getElementById('btn-open-add-server');
  const modal = document.getElementById('modal-server');
  const btnClose = document.getElementById('btn-close-server-modal');
  const btnCancel = document.getElementById('btn-cancel-server-modal');
  const formSave = document.getElementById('form-save-server');

  btnOpenAdd.addEventListener('click', () => {
    document.getElementById('modal-server-title').textContent = '➕ Добавить новый сервер';
    document.getElementById('server-edit-id').value = '';
    formSave.reset();
    document.getElementById('server-modloader-ver').value = '21.1.248';
    document.getElementById('server-min-ram').value = '4';
    document.getElementById('server-rec-ram').value = '6';
    document.getElementById('server-auto-join').checked = true;
    modal.classList.remove('hidden');
  });

  const closeModal = () => modal.classList.add('hidden');
  btnClose.addEventListener('click', closeModal);
  btnCancel.addEventListener('click', closeModal);

  formSave.addEventListener('submit', async (e) => {
    e.preventDefault();
    const editId = document.getElementById('server-edit-id').value;
    const name = document.getElementById('server-name').value.trim();
    const server_ip = document.getElementById('server-ip').value.trim();
    const server_port = parseInt(document.getElementById('server-port').value, 10);
    const minecraft_version = document.getElementById('server-mc-ver').value;
    const java_version = parseInt(document.getElementById('server-java-ver').value, 10);
    const modloader = document.getElementById('server-modloader').value;
    const modloader_version = document.getElementById('server-modloader-ver').value.trim();
    const jvm_flags = document.getElementById('server-jvm-flags').value.trim();
    const min_ram_gb = parseInt(document.getElementById('server-min-ram').value, 10);
    const recommended_ram_gb = parseInt(document.getElementById('server-rec-ram').value, 10);
    const game_args = document.getElementById('server-game-args').value.trim();
    const auto_join_server = document.getElementById('server-auto-join').checked ? 1 : 0;
    const description = document.getElementById('server-desc').value.trim();
    const is_default = document.getElementById('server-is-default').checked ? 1 : 0;

    const payload = {
      name,
      server_ip,
      server_port,
      minecraft_version,
      neoforge_version: modloader_version,
      modloader,
      modloader_version,
      java_version,
      jvm_flags,
      min_ram_gb,
      recommended_ram_gb,
      game_args,
      auto_join_server,
      description,
      is_default
    };

    try {
      let res;
      if (editId) {
        res = await fetch(`${API_BASE}/api/v1/admin/servers/${editId}`, {
          method: 'PUT',
          headers: getAuthHeaders(),
          body: JSON.stringify(payload)
        });
      } else {
        res = await fetch(`${API_BASE}/api/v1/admin/servers`, {
          method: 'POST',
          headers: getAuthHeaders(),
          body: JSON.stringify(payload)
        });
      }

      if (res.ok) {
        closeModal();
        await loadServers();
      } else {
        alert('Ошибка при сохранении параметров сервера');
      }
    } catch (err) {
      alert('Сетевая ошибка при сохранении сервера');
    }
  });
}

function openEditServerModal(serverId) {
  const s = state.servers.find(x => x.id === serverId);
  if (!s) return;

  document.getElementById('modal-server-title').textContent = '⚙️ Настройки сервера и сборки';
  document.getElementById('server-edit-id').value = s.id;
  document.getElementById('server-name').value = s.name;
  document.getElementById('server-ip').value = s.server_ip;
  document.getElementById('server-port').value = s.server_port;
  document.getElementById('server-mc-ver').value = s.minecraft_version;
  document.getElementById('server-java-ver').value = s.java_version || 21;
  document.getElementById('server-modloader').value = s.modloader || 'neoforge';
  document.getElementById('server-modloader-ver').value = s.modloader_version || s.neoforge_version || '21.1.248';
  document.getElementById('server-jvm-flags').value = s.jvm_flags || '';
  document.getElementById('server-min-ram').value = s.min_ram_gb || 4;
  document.getElementById('server-rec-ram').value = s.recommended_ram_gb || 6;
  document.getElementById('server-game-args').value = s.game_args || '';
  document.getElementById('server-auto-join').checked = s.auto_join_server !== 0;
  document.getElementById('server-desc').value = s.description || '';
  document.getElementById('server-is-default').checked = s.is_default === 1;

  document.getElementById('modal-server').classList.remove('hidden');
}

async function loadServers() {
  try {
    const res = await fetch(`${API_BASE}/api/v1/admin/servers`, { headers: getAuthHeaders() });
    const data = await res.json();
    state.servers = data.servers || [];

    renderServersList();
    updateServerSelectDropdowns();
  } catch (err) {
    console.error('Ошибка загрузки серверов:', err);
  }
}

function updateServerSelectDropdowns() {
  const selectConfigs = [
    { id: 'select-modpack-server', handler: loadModpack },
    { id: 'select-modrinth-server', handler: loadModpack },
    { id: 'select-rp-server', handler: loadResourcePacks },
    { id: 'select-cs-server', handler: loadClientServers }
  ];

  selectConfigs.forEach(({ id, handler }) => {
    const sel = document.getElementById(id);
    if (!sel) return;
    sel.innerHTML = '';
    state.servers.forEach(s => {
      const opt = document.createElement('option');
      opt.value = s.id;
      opt.textContent = `${s.name} (${s.modloader || 'NeoForge'} ${s.modloader_version || s.minecraft_version})`;
      if (s.id === state.currentServerId) opt.selected = true;
      sel.appendChild(opt);
    });

    sel.onchange = (e) => {
      state.currentServerId = parseInt(e.target.value, 10);
      syncServerDropdownValues();
      updateCurrentServerBadge();
      if (handler) handler();
    };
  });

  syncServerDropdownValues();
  updateCurrentServerBadge();
}

function syncServerDropdownValues() {
  ['select-modpack-server', 'select-modrinth-server', 'select-rp-server', 'select-cs-server'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = state.currentServerId;
  });
}

function updateCurrentServerBadge() {
  const current = state.servers.find(s => s.id === state.currentServerId) || state.servers[0];
  const badge = document.getElementById('sidebar-current-server');
  if (badge && current) {
    badge.textContent = current.name;
  }
}

function renderServersList() {
  const container = document.getElementById('servers-list-container');
  if (!container) return;
  container.innerHTML = '';

  state.servers.forEach(server => {
    const card = document.createElement('div');
    card.className = 'server-card glass-panel';
    card.innerHTML = `
      <div>
        <div class="server-card-header">
          <div>
            <h3 class="server-card-title">${server.name} ${server.is_default ? '⭐' : ''}</h3>
            <span class="server-card-address">${server.server_ip}:${server.server_port}</span>
          </div>
          <div class="server-ping-badge online" id="ping-badge-${server.id}">
            <span class="ping-dot"></span>
            <span class="ping-text" id="ping-text-${server.id}">Проверка...</span>
          </div>
        </div>

        <div class="server-card-meta">
          <span class="meta-pill">MC: ${server.minecraft_version}</span>
          <span class="meta-pill">${(server.modloader || 'NeoForge').toUpperCase()}: ${server.modloader_version || server.neoforge_version || '21.1.248'}</span>
          <span class="meta-pill">Java ${server.java_version || 21}</span>
          <span class="meta-pill">Модов: ${server.mods_count || 0}</span>
        </div>

        <p class="server-card-desc">${server.description || 'Официальный сервер VozduCraft'}</p>
      </div>

      <div class="server-card-actions">
        <button class="btn-primary btn-select-server" data-id="${server.id}">📦 Моды</button>
        <button class="btn-secondary btn-edit-server" data-id="${server.id}">⚙️ Настройки</button>
        <button class="btn-danger btn-delete-server" data-id="${server.id}">🗑️</button>
      </div>
    `;

    container.appendChild(card);

    // Запуск прямого TCP пинга сервера
    pingServer(server.id);
  });

  // Привязка действий кнопок карточек
  document.querySelectorAll('.btn-select-server').forEach(b => {
    b.addEventListener('click', (e) => {
      state.currentServerId = parseInt(e.target.dataset.id, 10);
      updateServerSelectDropdowns();
      document.querySelector('.nav-item[data-tab="modpack"]')?.click();
    });
  });

  document.querySelectorAll('.btn-edit-server').forEach(b => {
    b.addEventListener('click', (e) => {
      const sId = parseInt(e.target.dataset.id, 10);
      openEditServerModal(sId);
    });
  });

  document.querySelectorAll('.btn-delete-server').forEach(b => {
    b.addEventListener('click', async (e) => {
      const sId = parseInt(e.target.dataset.id, 10);
      if (confirm('Вы уверены, что хотите удалить этот сервер и всю его сборку модов?')) {
        await deleteServer(sId);
      }
    });
  });
}

async function pingServer(serverId) {
  const badge = document.getElementById(`ping-badge-${serverId}`);
  const text = document.getElementById(`ping-text-${serverId}`);

  try {
    const res = await fetch(`${API_BASE}/api/v1/admin/servers/${serverId}/ping`);
    const data = await res.json();

    if (data.online) {
      badge.className = 'server-ping-badge online';
      text.textContent = `${data.players?.online || 0} / ${data.players?.max || 100} (${data.ping_ms || 15}ms)`;
    } else {
      badge.className = 'server-ping-badge offline';
      text.textContent = 'OFFLINE';
    }
  } catch (err) {
    if (badge) badge.className = 'server-ping-badge offline';
    if (text) text.textContent = 'OFFLINE';
  }
}



async function deleteServer(serverId) {
  try {
    const res = await fetch(`${API_BASE}/api/v1/admin/servers/${serverId}`, {
      method: 'DELETE',
      headers: getAuthHeaders()
    });
    if (res.ok) {
      await loadServers();
    }
  } catch (err) {
    alert('Ошибка при удалении сервера');
  }
}

// ----------------------------------------------------
// 4. УПРАВЛЕНИЕ МОДАМИ СБОРКИ
// ----------------------------------------------------
function updateBulkBar() {
  const bulkBar = document.getElementById('mods-bulk-bar');
  const countEl = document.getElementById('selected-mods-count');
  const thSelectAll = document.getElementById('th-mod-select-all');
  const totalVisible = state.renderedModIds ? state.renderedModIds.length : 0;
  const selectedCount = state.selectedModIds.size;

  if (countEl) countEl.textContent = selectedCount;
  if (bulkBar) {
    if (selectedCount > 0) bulkBar.classList.add('visible');
    else bulkBar.classList.remove('visible');
  }

  if (thSelectAll) {
    thSelectAll.checked = (totalVisible > 0 && selectedCount === totalVisible);
    thSelectAll.indeterminate = (selectedCount > 0 && selectedCount < totalVisible);
  }
}

function setupModpackControls() {
  const dropzone = document.getElementById('mod-dropzone');
  const fileInput = document.getElementById('file-input-mod');
  const browseBtn = document.getElementById('btn-browse-files');
  const searchInput = document.getElementById('search-local-mods');
  const thSelectAll = document.getElementById('th-mod-select-all');
  const btnBulkDelete = document.getElementById('btn-bulk-delete-mods');
  const btnBulkOptional = document.getElementById('btn-bulk-set-optional');
  const btnBulkRequired = document.getElementById('btn-bulk-set-required');
  const btnBulkDeselect = document.getElementById('btn-bulk-deselect-all');

  browseBtn.addEventListener('click', () => fileInput.click());

  fileInput.addEventListener('change', (e) => {
    handleFilesUpload(e.target.files);
  });

  dropzone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropzone.classList.add('dragover');
  });

  dropzone.addEventListener('dragleave', () => {
    dropzone.classList.remove('dragover');
  });

  dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropzone.classList.remove('dragover');
    handleFilesUpload(e.dataTransfer.files);
  });

  searchInput.addEventListener('input', (e) => {
    const query = e.target.value.toLowerCase().trim();
    filterLocalMods(query);
  });

  // Выбрать / снять все моды
  if (thSelectAll) {
    thSelectAll.addEventListener('change', (e) => {
      if (e.target.checked) {
        state.renderedModIds.forEach(id => state.selectedModIds.add(id));
      } else {
        state.renderedModIds.forEach(id => state.selectedModIds.delete(id));
      }
      document.querySelectorAll('.mod-checkbox').forEach(cb => {
        cb.checked = e.target.checked;
      });
      updateBulkBar();
    });
  }

  // Массовое удаление выбранных модов
  if (btnBulkDelete) {
    btnBulkDelete.addEventListener('click', async () => {
      const ids = Array.from(state.selectedModIds);
      if (ids.length === 0) return;
      if (confirm(`Вы уверены, что хотите удалить выбранные моды (${ids.length} шт.) из сборки сервера?`)) {
        try {
          const res = await fetch(`${API_BASE}/api/v1/admin/modpack/bulk-delete`, {
            method: 'POST',
            headers: getAuthHeaders(),
            body: JSON.stringify({ ids })
          });
          const data = await res.json();
          if (data.success) {
            state.selectedModIds.clear();
            await loadModpack();
          } else {
            alert('Ошибка: ' + (data.error || 'Не удалось удалить моды'));
          }
        } catch (err) {
          alert('Ошибка соединения с сервером: ' + err.message);
        }
      }
    });
  }

  // Массовый перевод в опциональные
  if (btnBulkOptional) {
    btnBulkOptional.addEventListener('click', async () => {
      const ids = Array.from(state.selectedModIds);
      if (ids.length === 0) return;
      try {
        const res = await fetch(`${API_BASE}/api/v1/admin/modpack/bulk-set-optional`, {
          method: 'POST',
          headers: getAuthHeaders(),
          body: JSON.stringify({ ids, is_optional: 1 })
        });
        const data = await res.json();
        if (data.success) {
          await loadModpack();
        }
      } catch (err) {
        alert('Ошибка: ' + err.message);
      }
    });
  }

  // Массовый перевод в обязательные
  if (btnBulkRequired) {
    btnBulkRequired.addEventListener('click', async () => {
      const ids = Array.from(state.selectedModIds);
      if (ids.length === 0) return;
      try {
        const res = await fetch(`${API_BASE}/api/v1/admin/modpack/bulk-set-optional`, {
          method: 'POST',
          headers: getAuthHeaders(),
          body: JSON.stringify({ ids, is_optional: 0 })
        });
        const data = await res.json();
        if (data.success) {
          await loadModpack();
        }
      } catch (err) {
        alert('Ошибка: ' + err.message);
      }
    });
  }

  // Снять всё выделение
  if (btnBulkDeselect) {
    btnBulkDeselect.addEventListener('click', () => {
      state.selectedModIds.clear();
      document.querySelectorAll('.mod-checkbox').forEach(cb => cb.checked = false);
      updateBulkBar();
    });
  }
}

async function loadModpack() {
  try {
    const res = await fetch(`${API_BASE}/api/v1/admin/modpack?serverId=${state.currentServerId}`, {
      headers: getAuthHeaders()
    });
    const data = await res.json();
    state.currentModpack = data.files || [];
    updateGroupFilterOptions();
    applyModpackFilters();
  } catch (err) {
    console.error('Ошибка загрузки модов:', err);
  }
}

function updateGroupFilterOptions() {
  const sel = document.getElementById('filter-group-select');
  if (!sel) return;
  const currentVal = sel.value;
  const groups = Array.from(new Set(state.currentModpack.map(m => m.group_name || 'Общие'))).sort();
  sel.innerHTML = '<option value="">📁 Все группы модов</option>';
  groups.forEach(g => {
    const opt = document.createElement('option');
    opt.value = g;
    opt.textContent = `📁 ${g}`;
    if (g === currentVal) opt.selected = true;
    sel.appendChild(opt);
  });
}

function applyModpackFilters() {
  const searchInput = document.getElementById('search-local-mods');
  const groupSelect = document.getElementById('filter-group-select');
  const query = searchInput ? searchInput.value.toLowerCase().trim() : '';
  const selectedGroup = groupSelect ? groupSelect.value : '';

  let filtered = state.currentModpack;
  if (selectedGroup) {
    filtered = filtered.filter(m => (m.group_name || 'Общие') === selectedGroup);
  }
  if (query) {
    filtered = filtered.filter(f => 
      (f.mod_name && f.mod_name.toLowerCase().includes(query)) ||
      (f.filepath && f.filepath.toLowerCase().includes(query)) ||
      (f.group_name && f.group_name.toLowerCase().includes(query))
    );
  }
  renderModpackTable(filtered);
}

function renderModpackTable(files) {
  const tbody = document.getElementById('modpack-table-body');
  const badge = document.getElementById('mods-count-badge');
  if (!tbody) return;

  state.renderedModIds = files.map(f => f.id);

  if (badge) badge.textContent = `Всего модов: ${files.length}`;
  tbody.innerHTML = '';

  if (files.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" style="text-align: center; color: var(--text-muted); padding: 30px;">В сборке этого сервера пока нет модов. Перетащите файлы сюда или добавьте из Modrinth.</td></tr>';
    updateBulkBar();
    return;
  }

  files.forEach(file => {
    const tr = document.createElement('tr');
    const sizeMb = (file.size_bytes / (1024 * 1024)).toFixed(2);
    const isChecked = state.selectedModIds.has(file.id);

    const iconHtml = file.icon_url 
      ? `<img src="${file.icon_url}" style="width: 32px; height: 32px; border-radius: 6px; object-fit: cover; flex-shrink: 0; background: rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.1);" alt="logo" onerror="this.src='data:image/svg+xml;utf8,<svg xmlns=\\'http://www.w3.org/2000/svg\\' width=\\'32\\' height=\\'32\\' fill=\\'%23ff6b00\\' viewBox=\\'0 0 24 24\\'><path d=\\'M21 16.5c0 .38-.21.71-.53.88l-7.9 4.44c-.16.12-.36.18-.57.18s-.41-.06-.57-.18l-7.9-4.44A.991.991 0 0 1 3 16.5v-9c0-.38.21-.71.53-.88l7.9-4.44c.16-.12.36-.18.57-.18s.41.06.57.18l7.9 4.44c.32.17.53.5.53.88v9z\\'/></svg>'">`
      : `<div style="width: 32px; height: 32px; border-radius: 6px; display: flex; align-items: center; justify-content: center; background: rgba(255,107,0,0.1); color: #ff6b00; font-size: 16px; flex-shrink: 0;">🧩</div>`;

    const isAllUsers = !file.allowed_users || file.allowed_users === 'ALL' || file.allowed_users === '["ALL"]' || file.allowed_users.trim() === '';
    let userBadgeHtml = `<span style="font-size: 11px; padding: 2px 8px; border-radius: 10px; background: rgba(34, 197, 94, 0.15); color: #4ade80; font-weight: 600;">Всем</span>`;
    if (!isAllUsers) {
      let displayUsers = file.allowed_users;
      try {
        const parsed = JSON.parse(file.allowed_users);
        if (Array.isArray(parsed)) displayUsers = parsed.join(', ');
      } catch (_) {}
      userBadgeHtml = `<span style="font-size: 11px; padding: 2px 8px; border-radius: 10px; background: rgba(245, 158, 11, 0.15); color: #fbbf24; font-weight: 600; max-width: 140px; display: inline-block; text-overflow: ellipsis; overflow: hidden; white-space: nowrap;" title="${displayUsers}">🔒 ${displayUsers}</span>`;
    }

    tr.innerHTML = `
      <td style="text-align: center;">
        <input type="checkbox" class="mod-checkbox styled-checkbox" data-id="${file.id}" ${isChecked ? 'checked' : ''}>
      </td>
      <td>
        <div style="display: flex; align-items: center; gap: 10px;">
          ${iconHtml}
          <div style="overflow: hidden;">
            <div class="mod-title-cell" title="${file.mod_name || file.filepath}">${file.mod_name || file.filepath}</div>
            <div class="mod-path-sub">${file.filepath}</div>
          </div>
        </div>
      </td>
      <td>
        <span style="font-size: 11px; padding: 3px 8px; border-radius: 12px; background: rgba(255, 107, 0, 0.15); color: #ff6b00; border: 1px solid rgba(255, 107, 0, 0.3); font-weight: 600;">
          ${file.group_name || 'Общие'}
        </span>
      </td>
      <td>${userBadgeHtml}</td>
      <td>${sizeMb} MB</td>
      <td>
        <span class="tag-badge ${file.is_optional ? 'optional' : 'required'}">
          ${file.is_optional ? 'Опциональный' : 'Обязательный'}
        </span>
      </td>
      <td>
        <button class="btn-icon btn-edit-mod-details" data-id="${file.id}" title="⚙️ Настроить группу, доступ и превью" style="background: rgba(59, 130, 246, 0.2); color: #60a5fa; margin-right: 4px;">⚙️</button>
        <button class="btn-icon btn-toggle-opt" data-id="${file.id}" title="Переключить тип">${file.is_optional ? '🔒' : '⚡'}</button>
        <button class="btn-icon btn-delete-mod" data-id="${file.id}" title="Удалить из сборки">🗑️</button>
      </td>
    `;
    tbody.appendChild(tr);
  });

  // Чекбоксы выбора строк
  document.querySelectorAll('.mod-checkbox').forEach(cb => {
    cb.addEventListener('change', (e) => {
      const id = parseInt(e.target.dataset.id, 10);
      if (e.target.checked) {
        state.selectedModIds.add(id);
      } else {
        state.selectedModIds.delete(id);
      }
      updateBulkBar();
    });
  });

  document.querySelectorAll('.btn-edit-mod-details').forEach(b => {
    b.addEventListener('click', (e) => {
      const id = parseInt(e.currentTarget.dataset.id, 10);
      openEditModModal(id);
    });
  });

  document.querySelectorAll('.btn-toggle-opt').forEach(b => {
    b.addEventListener('click', async (e) => {
      const id = e.currentTarget.dataset.id;
      await fetch(`${API_BASE}/api/v1/admin/modpack/${id}/toggle-optional`, {
        method: 'PATCH',
        headers: getAuthHeaders()
      });
      loadModpack();
    });
  });

  document.querySelectorAll('.btn-delete-mod').forEach(b => {
    b.addEventListener('click', async (e) => {
      const id = e.currentTarget.dataset.id;
      if (confirm('Удалить этот мод из сборки сервера?')) {
        await fetch(`${API_BASE}/api/v1/admin/modpack/${id}`, {
          method: 'DELETE',
          headers: getAuthHeaders()
        });
        state.selectedModIds.delete(parseInt(id, 10));
        loadModpack();
      }
    });
  });

  updateBulkBar();
}

function filterLocalMods(query) {
  applyModpackFilters();
}

async function handleFilesUpload(files) {
  if (!files || files.length === 0) return;

  const dropzone = document.getElementById('mod-dropzone');
  const dropzoneTextEl = dropzone.querySelector('.dropzone-text');
  const oldText = dropzoneTextEl.innerHTML;

  const fileList = Array.from(files).filter(f => f.name.endsWith('.jar') || f.name.endsWith('.zip'));
  if (fileList.length === 0) {
    alert('Пожалуйста, выберите файлы с расширением .jar или .zip');
    return;
  }

  for (let i = 0; i < fileList.length; i++) {
    const file = fileList[i];
    const sizeMb = (file.size / (1024 * 1024)).toFixed(1);
    dropzoneTextEl.innerHTML = `⏳ [${i + 1}/${fileList.length}] Загрузка <b>${file.name}</b> (${sizeMb} MB)...`;

    try {
      const base64Data = await readFileAsBase64(file);
      const res = await fetch(`${API_BASE}/api/v1/admin/modpack/upload`, {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({
          serverId: state.currentServerId,
          filename: file.name,
          base64Data: base64Data,
          modName: file.name.replace(/\.jar$/i, '').replace(/[-_]/g, ' '),
          modDescription: 'Локальный мод, загруженный администратором'
        })
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.success) {
        alert(`Ошибка при загрузке ${file.name}: ${data.error || res.statusText || 'Сервер отклонил файл'}`);
      }
    } catch (err) {
      console.error('Ошибка загрузки файла:', file.name, err);
      alert(`Сбой передачи файла ${file.name}: ${err.message}`);
    }
  }

  dropzoneTextEl.innerHTML = oldText;
  await loadModpack();
}

function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      const base64 = result.includes(',') ? result.split(',')[1] : result;
      resolve(base64);
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function setupCopyModsModal() {
  const btnOpen = document.getElementById('btn-open-copy-mods');
  const modal = document.getElementById('modal-copy-mods');
  const btnClose = document.getElementById('btn-close-copy-modal');
  const btnCancel = document.getElementById('btn-cancel-copy-modal');
  const form = document.getElementById('form-copy-mods');
  const selectSource = document.getElementById('copy-source-server');

  if (btnOpen && modal) {
    btnOpen.addEventListener('click', () => {
      // Заполняем список других серверов
      selectSource.innerHTML = '';
      const otherServers = state.servers.filter(s => s.id !== state.currentServerId);
      if (otherServers.length === 0) {
        alert('Для заимствования модов требуется наличие хотя бы двух серверов в системе.');
        return;
      }

      otherServers.forEach(s => {
        const opt = document.createElement('option');
        opt.value = s.id;
        opt.textContent = `${s.name} (${s.minecraft_version} • модов: ${s.mods_count || 0})`;
        selectSource.appendChild(opt);
      });

      modal.classList.remove('hidden');
    });

    const hide = () => modal.classList.add('hidden');
    btnClose?.addEventListener('click', hide);
    btnCancel?.addEventListener('click', hide);

    form?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const sourceId = parseInt(selectSource.value, 10);
      const copyMode = form.querySelector('input[name="copy-mode"]:checked')?.value || 'optional';

      try {
        const res = await fetch(`${API_BASE}/api/v1/admin/modpack/copy-from-server`, {
          method: 'POST',
          headers: getAuthHeaders(),
          body: JSON.stringify({
            targetServerId: state.currentServerId,
            sourceServerId: sourceId,
            onlyOptional: copyMode === 'optional'
          })
        });
        const data = await res.json();
        if (res.ok) {
          alert(`✅ Успешно скопировано ${data.count} модов!`);
          hide();
          loadModpack();
        } else {
          alert(data.error || 'Ошибка копирования');
        }
      } catch (err) {
        alert('Ошибка при выполнении запроса');
      }
    });
  }
}

// ----------------------------------------------------
// 5. MODRINTH ПОИСК И ДОБАВЛЕНИЕ
// ----------------------------------------------------
function setupModrinthControls() {
  const searchInput = document.getElementById('modrinth-query');
  const searchBtn = document.getElementById('btn-search-modrinth');

  const executeSearch = async () => {
    const q = searchInput.value.trim();
    if (!q) return;

    const container = document.getElementById('modrinth-results-container');
    container.innerHTML = '<div class="empty-state">Поиск модов в базе Modrinth API...</div>';

    try {
      const res = await fetch(`${API_BASE}/api/v1/admin/modrinth/search?q=${encodeURIComponent(q)}`, {
        headers: getAuthHeaders()
      });
      const data = await res.json();
      renderModrinthResults(data.hits || []);
    } catch (err) {
      container.innerHTML = '<div class="empty-state" style="color: var(--accent-rose);">Ошибка подключения к Modrinth API</div>';
    }
  };

  searchBtn.addEventListener('click', executeSearch);
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') executeSearch();
  });
}

function renderModrinthResults(hits) {
  const container = document.getElementById('modrinth-results-container');
  container.innerHTML = '';

  if (hits.length === 0) {
    container.innerHTML = '<div class="empty-state">По вашему запросу ничего не найдено на Modrinth</div>';
    return;
  }

  hits.forEach(item => {
    const card = document.createElement('div');
    card.className = 'modrinth-card glass-panel';
    card.innerHTML = `
      <div>
        <h4 class="modrinth-title">${item.title}</h4>
        <p class="modrinth-desc">${item.description || 'Без описания'}</p>
      </div>
      <button class="btn-primary full-width btn-install-modrinth" data-project="${item.project_id}">
        ➕ Добавить в сборку сервера
      </button>
    `;
    container.appendChild(card);
  });

  document.querySelectorAll('.btn-install-modrinth').forEach(b => {
    b.addEventListener('click', async (e) => {
      const pId = e.target.dataset.project;
      e.target.disabled = true;
      e.target.textContent = 'Установка...';

      try {
        // Получаем версии проекта
        const vRes = await fetch(`${API_BASE}/api/v1/admin/modrinth/versions?projectId=${pId}`, {
          headers: getAuthHeaders()
        });
        const versions = await vRes.json();
        if (versions && versions.length > 0) {
          const firstVer = versions[0];
          await fetch(`${API_BASE}/api/v1/admin/modpack/add-modrinth`, {
            method: 'POST',
            headers: getAuthHeaders(),
            body: JSON.stringify({
              serverId: state.currentServerId,
              projectId: pId,
              versionId: firstVer.id
            })
          });

          e.target.textContent = '✅ Установлен!';
          e.target.style.background = '#10b981';
        } else {
          e.target.textContent = '❌ Нет файлов для 1.21.1';
        }
      } catch (err) {
        e.target.textContent = '❌ Ошибка';
      }
    });
  });
}

// ----------------------------------------------------
// 6. ПАТЧИ И РЕЛИЗЫ ЛАУНЧЕРА
// ----------------------------------------------------
function setupReleasesControls() {
  const form = document.getElementById('form-publish-release');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const version = document.getElementById('release-version').value.trim();
    const release_notes = document.getElementById('release-notes').value.trim();
    const mac_download_url = document.getElementById('release-mac-url').value.trim();
    const win_download_url = document.getElementById('release-win-url').value.trim();
    const is_mandatory = document.getElementById('release-mandatory').checked ? 1 : 0;

    try {
      const res = await fetch(`${API_BASE}/api/v1/admin/launcher/upload-release`, {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({ version, release_notes, mac_download_url, win_download_url, is_mandatory })
      });

      if (res.ok) {
        form.reset();
        alert(`Патч лаунчера v${version} успешно опубликован!`);
        await loadReleases();
      } else {
        alert('Ошибка публикации патча');
      }
    } catch (err) {
      alert('Сетевая ошибка при публикации патча');
    }
  });
}

async function loadReleases() {
  try {
    const res = await fetch(`${API_BASE}/api/v1/admin/launcher/releases`, { headers: getAuthHeaders() });
    const data = await res.json();
    state.releases = data.releases || [];

    const container = document.getElementById('releases-history-container');
    if (!container) return;
    container.innerHTML = '';

    if (state.releases.length === 0) {
      container.innerHTML = '<div style="color: var(--text-muted); text-align: center; padding: 20px;">Нет опубликованных релизов</div>';
      return;
    }

    state.releases.forEach(rel => {
      const item = document.createElement('div');
      item.style.cssText = 'padding: 14px; border-bottom: 1px solid var(--panel-border); display: flex; justify-content: space-between; align-items: center;';
      item.innerHTML = `
        <div>
          <div style="font-weight: 700; font-size: 15px; color: var(--accent-cyan);">v${rel.version} ${rel.is_mandatory ? '🔒 (Обязательный)' : ''}</div>
          <div style="font-size: 12px; color: var(--text-secondary); margin: 4px 0;">${rel.release_notes || 'Без описания'}</div>
          <div style="font-size: 11px; color: var(--text-muted);">${new Date(rel.created_at).toLocaleString('ru-RU')}</div>
        </div>
      `;
      container.appendChild(item);
    });
  } catch (err) {
    console.error('Ошибка загрузки релизов:', err);
  }
}

// ----------------------------------------------------
// 7. БАНЫ И БЕЗОПАСНОСТЬ (IP, HWID, NICK, POOL)
// ----------------------------------------------------
function setupBansControls() {
  const form = document.getElementById('form-create-ban');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const ban_type = document.getElementById('ban-type').value;
    const target_value = document.getElementById('ban-target').value.trim();
    const reason = document.getElementById('ban-reason').value.trim();
    const expires_in_hours = document.getElementById('ban-duration').value;

    try {
      const res = await fetch(`${API_BASE}/api/v1/admin/bans`, {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({ ban_type, target_value, reason, expires_in_hours })
      });

      if (res.ok) {
        form.reset();
        await loadBans();
      } else {
        alert('Ошибка при создании блокировки');
      }
    } catch (err) {
      alert('Сетевая ошибка при создании бана');
    }
  });
}

async function loadBans() {
  try {
    const res = await fetch(`${API_BASE}/api/v1/admin/bans`, { headers: getAuthHeaders() });
    const data = await res.json();
    state.bans = data.bans || [];

    const tbody = document.getElementById('bans-table-body');
    if (!tbody) return;
    tbody.innerHTML = '';

    if (state.bans.length === 0) {
      tbody.innerHTML = '<tr><td colspan="4" style="text-align: center; color: var(--text-muted); padding: 20px;">Активных блокировок нет</td></tr>';
      return;
    }

    state.bans.forEach(ban => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td><span class="tag-badge optional">${ban.ban_type}</span></td>
        <td style="font-weight: 600; color: var(--text-primary); font-family: monospace;">${ban.target_value}</td>
        <td>${ban.reason || 'Нарушение правил'}</td>
        <td>
          <button class="btn-danger btn-unban" data-id="${ban.id}" style="padding: 4px 10px; font-size: 11px;">Разблокировать</button>
        </td>
      `;
      tbody.appendChild(tr);
    });

    document.querySelectorAll('.btn-unban').forEach(b => {
      b.addEventListener('click', async (e) => {
        const id = e.target.dataset.id;
        await fetch(`${API_BASE}/api/v1/admin/bans/${id}`, {
          method: 'DELETE',
          headers: getAuthHeaders()
        });
        loadBans();
      });
    });
  } catch (err) {
    console.error('Ошибка загрузки бан-листа:', err);
  }
}

// ----------------------------------------------------
// 8. АНАЛИТИКА И АУДИТ
// ----------------------------------------------------
async function loadAnalytics() {
  try {
    const res = await fetch(`${API_BASE}/api/v1/admin/analytics`, { headers: getAuthHeaders() });
    const data = await res.json();

    document.getElementById('stat-success-joins').textContent = data.successJoins || 0;
    document.getElementById('stat-failed-auths').textContent = data.failedAuths || 0;
    document.getElementById('stat-total-bans').textContent = data.totalBans || 0;
    document.getElementById('stat-total-users').textContent = data.totalUsers || 0;

    // Журнал подключений
    const connTbody = document.getElementById('connections-table-body');
    if (connTbody) {
      connTbody.innerHTML = '';
      (data.recentEvents || []).forEach(ev => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td style="font-weight: 600; color: var(--accent-cyan);">${ev.username || 'Аноним'}</td>
          <td>${ev.event_type}</td>
          <td style="font-family: monospace; font-size: 11px;">${ev.ip_address || ev.hwid || '—'}</td>
          <td style="font-size: 11px;">${new Date(ev.created_at).toLocaleTimeString('ru-RU')}</td>
        `;
        connTbody.appendChild(tr);
      });
    }

    // Журнал аудита
    const auditRes = await fetch(`${API_BASE}/api/v1/admin/audit-logs`, { headers: getAuthHeaders() });
    const auditData = await auditRes.json();
    const auditTbody = document.getElementById('audit-table-body');
    if (auditTbody) {
      auditTbody.innerHTML = '';
      (auditData.logs || []).forEach(log => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td style="font-weight: 700; color: var(--accent-amber);">${log.actor_username}</td>
          <td><span class="tag-badge required">${log.action_type}</span></td>
          <td style="font-size: 12px;">${log.details || log.target}</td>
          <td style="font-size: 11px;">${new Date(log.created_at).toLocaleTimeString('ru-RU')}</td>
        `;
        auditTbody.appendChild(tr);
      });
    }
  } catch (err) {
    console.error('Ошибка аналитики:', err);
  }
}

// ----------------------------------------------------
// 9. ОТКАЗОУСТОЙЧИВЫЕ ЗЕРКАЛА И МИГРАЦИЯ (FAILOVER)
// ----------------------------------------------------
function setupMirrorsControls() {
  const btnOpen = document.getElementById('btn-open-add-mirror');
  const modal = document.getElementById('modal-add-mirror');
  const btnClose = document.getElementById('btn-close-mirror-modal');
  const btnCancel = document.getElementById('btn-cancel-mirror-modal');
  const form = document.getElementById('form-add-mirror');

  if (btnOpen && modal) {
    btnOpen.addEventListener('click', () => {
      form.reset();
      modal.classList.remove('hidden');
    });

    const hide = () => modal.classList.add('hidden');
    btnClose?.addEventListener('click', hide);
    btnCancel?.addEventListener('click', hide);

    form?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const payload = {
        name: document.getElementById('mirror-name').value.trim(),
        url: document.getElementById('mirror-url').value.trim(),
        region: document.getElementById('mirror-region').value,
        priority: parseInt(document.getElementById('mirror-priority').value, 10) || 50,
        is_primary: document.getElementById('mirror-is-primary').checked
      };

      try {
        const res = await fetch(`${API_BASE}/api/v1/admin/mirrors`, {
          method: 'POST',
          headers: getAuthHeaders(),
          body: JSON.stringify(payload)
        });
        if (res.ok) {
          hide();
          loadMirrors();
        } else {
          const err = await res.json();
          alert(err.error || 'Ошибка добавления зеркала');
        }
      } catch (err) {
        alert('Ошибка при выполнении запроса');
      }
    });
  }
}

async function loadMirrors() {
  const container = document.getElementById('mirrors-list-container');
  if (!container) return;

  try {
    const res = await fetch(`${API_BASE}/api/v1/admin/mirrors`, { headers: getAuthHeaders() });
    const data = await res.json();
    state.mirrors = data.mirrors || [];
    renderMirrorsList();
  } catch (err) {
    console.error('Ошибка загрузки зеркал:', err);
  }
}

function renderMirrorsList() {
  const container = document.getElementById('mirrors-list-container');
  if (!container) return;
  container.innerHTML = '';

  if (state.mirrors.length === 0) {
    container.innerHTML = '<div class="glass-panel" style="grid-column: 1 / -1; padding: 30px; text-align: center; color: var(--text-muted);">Зеркала не добавлены</div>';
    return;
  }

  state.mirrors.forEach(mirror => {
    const card = document.createElement('div');
    card.className = 'server-card glass-panel';
    card.innerHTML = `
      <div>
        <div class="server-card-header">
          <div>
            <h3 class="server-card-title">${mirror.name} ${mirror.is_primary ? '⭐' : ''}</h3>
            <span class="server-card-address">${mirror.url}</span>
          </div>
          <div class="server-ping-badge ${mirror.is_primary ? 'online' : 'optional'}">
            <span class="ping-dot"></span>
            <span>${mirror.is_primary ? 'ОСНОВНОЙ УЗЕЛ (PRIMARY)' : 'РЕЗЕРВНЫЙ (FAILOVER)'}</span>
          </div>
        </div>

        <div class="server-card-meta" style="margin-top: 10px;">
          <span class="meta-pill">📍 Регион: ${mirror.region || 'Global'}</span>
          <span class="meta-pill">⚡ Приоритет: ${mirror.priority || 50}</span>
          <span class="meta-pill">Статус: ${mirror.is_active ? '🟢 Активен' : '🔴 Отключен'}</span>
        </div>

        <p class="server-card-desc" style="font-size: 13px; color: var(--text-muted); margin-top: 12px;">
          ${mirror.is_primary 
            ? 'Все лаунчеры игроков обращаются к этому адресу в первую очередь.' 
            : 'Лаунчеры игроков автоматически переключатся на этот IP в случае недоступности основного сервера.'}
        </p>
      </div>

      <div class="server-card-actions" style="margin-top: 16px;">
        ${!mirror.is_primary ? `
          <button class="btn-primary btn-set-primary-mirror" data-id="${mirror.id}" style="background: linear-gradient(135deg, #10b981, #059669); font-size: 13px;">
            ⭐ Сделать основным (Мигрировать игроков)
          </button>
          <button class="btn-danger btn-delete-mirror" data-id="${mirror.id}">🗑️</button>
        ` : `
          <span style="color: #34d399; font-weight: 700; font-size: 13px;">✅ Текущий мастер-узел проекта</span>
        `}
      </div>
    `;
    container.appendChild(card);
  });

  // События назначения основным
  document.querySelectorAll('.btn-set-primary-mirror').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const id = e.target.dataset.id;
      if (confirm('Вы уверены, что хотите сделать этот узел основным? Все лаунчеры игроков будут автоматически перенаправлены на него.')) {
        await fetch(`${API_BASE}/api/v1/admin/mirrors/${id}/set-primary`, {
          method: 'POST',
          headers: getAuthHeaders()
        });
        loadMirrors();
      }
    });
  });

  // События удаления
  document.querySelectorAll('.btn-delete-mirror').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const id = e.target.dataset.id;
      if (confirm('Удалить это зеркало из списка?')) {
        await fetch(`${API_BASE}/api/v1/admin/mirrors/${id}`, {
          method: 'DELETE',
          headers: getAuthHeaders()
        });
        loadMirrors();
      }
    });
  });
}

// ----------------------------------------------------
// 10. СМЕНА ПАРОЛЯ АДМИНИСТРАТОРА
// ----------------------------------------------------
function setupChangePasswordModal() {
  const btnOpen = document.getElementById('btn-open-change-pwd');
  const modal = document.getElementById('modal-change-password');
  const btnClose = document.getElementById('btn-close-pwd-modal');
  const btnCancel = document.getElementById('btn-cancel-pwd-modal');
  const form = document.getElementById('form-change-password');

  if (btnOpen && modal) {
    btnOpen.addEventListener('click', () => {
      form.reset();
      modal.classList.remove('hidden');
    });

    const hide = () => modal.classList.add('hidden');
    btnClose?.addEventListener('click', hide);
    btnCancel?.addEventListener('click', hide);

    form?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const currentPassword = document.getElementById('pwd-current').value;
      const newPassword = document.getElementById('pwd-new').value;
      const confirmPassword = document.getElementById('pwd-confirm').value;

      if (newPassword !== confirmPassword) {
        alert('Новые пароли не совпадают!');
        return;
      }

      try {
        const res = await fetch(`${API_BASE}/api/v1/auth/change-password`, {
          method: 'POST',
          headers: getAuthHeaders(),
          body: JSON.stringify({ currentPassword, newPassword })
        });

        const data = await res.json();
        if (res.ok) {
          alert('✅ Пароль успешно изменен!');
          hide();
        } else {
          alert(data.error || 'Ошибка смены пароля');
        }
      } catch (err) {
        alert('Ошибка при выполнении запроса');
      }
    });
  }
}

// ----------------------------------------------------
// 11. УПРАВЛЕНИЕ DISCORD-БОТОМ
// ----------------------------------------------------
async function loadDiscordBotStatus() {
  try {
    const res = await fetch(`${API_BASE}/api/v1/admin/discord/status`, {
      headers: getAuthHeaders()
    });
    if (!res.ok) return;

    const data = await res.json();
    const badgeEl = document.getElementById('discord-bot-status-badge');
    const tagEl = document.getElementById('discord-bot-tag-display');
    const guildsEl = document.getElementById('discord-bot-guilds-display');
    const tokenInput = document.getElementById('discord-token-input');
    const guildInput = document.getElementById('discord-guild-id-input');
    const proxyInput = document.getElementById('discord-proxy-input');

    if (badgeEl) {
      if (data.isReady) {
        badgeEl.textContent = '🟢 ПОДКЛЮЧЕН';
        badgeEl.style.color = '#22c55e';
      } else if (data.hasConfiguredToken) {
        badgeEl.textContent = '🔴 ОШИБКА ПОДКЛЮЧЕНИЯ';
        badgeEl.style.color = '#ef4444';
      } else {
        badgeEl.textContent = '⚪ НЕ НАСТРОЕН';
        badgeEl.style.color = '#94a3b8';
      }
    }

    if (tagEl) {
      tagEl.textContent = data.tag || (data.lastError ? `Ошибка: ${data.lastError}` : 'Не в сети');
    }

    if (guildsEl) {
      guildsEl.textContent = data.guildsCount || 0;
    }

    if (guildInput && data.guildId) {
      guildInput.value = data.guildId;
    }

    if (proxyInput && data.proxy) {
      proxyInput.value = data.proxy;
    }

    if (tokenInput && data.maskedToken && !tokenInput.value) {
      tokenInput.placeholder = data.maskedToken;
    }

    loadPendingRequests();
  } catch (err) {
    console.error('Ошибка загрузки статуса Discord:', err);
  }
}

function setupDiscordBotTab() {
  const btnRefresh = document.getElementById('btn-refresh-discord-status');
  const btnToggleVis = document.getElementById('btn-toggle-token-visibility');
  const tokenInput = document.getElementById('discord-token-input');
  const formConfig = document.getElementById('form-discord-config');
  const formTest = document.getElementById('form-discord-test-dm');
  const configAlert = document.getElementById('discord-config-alert');
  const testAlert = document.getElementById('discord-test-alert');

  btnRefresh?.addEventListener('click', () => {
    loadDiscordBotStatus();
  });

  btnToggleVis?.addEventListener('click', () => {
    if (tokenInput) {
      tokenInput.type = tokenInput.type === 'password' ? 'text' : 'password';
      btnToggleVis.textContent = tokenInput.type === 'password' ? '👁️' : '🙈';
    }
  });

  formConfig?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const botToken = tokenInput.value.trim();
    const guildId = document.getElementById('discord-guild-id-input')?.value.trim() || '';
    const proxy = document.getElementById('discord-proxy-input')?.value.trim() || '';

    if (!botToken && !tokenInput.placeholder) {
      alert('Введите токен бота');
      return;
    }

    const saveBtn = document.getElementById('btn-save-discord-config');
    const oldText = saveBtn.textContent;
    saveBtn.disabled = true;
    saveBtn.textContent = '⏳ Подключение к Discord...';

    configAlert.classList.add('hidden');

    try {
      const res = await fetch(`${API_BASE}/api/v1/admin/discord/config`, {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({ botToken: botToken || tokenInput.placeholder, guildId, proxy })
      });

      const data = await res.json();
      configAlert.classList.remove('hidden');

      if (res.ok && data.success) {
        configAlert.style.background = 'rgba(34, 197, 94, 0.2)';
        configAlert.style.color = '#4ade80';
        configAlert.style.border = '1px solid rgba(34, 197, 94, 0.4)';
        configAlert.textContent = `✅ ${data.message}`;
        tokenInput.value = '';
      } else {
        configAlert.style.background = 'rgba(239, 68, 68, 0.2)';
        configAlert.style.color = '#f87171';
        configAlert.style.border = '1px solid rgba(239, 68, 68, 0.4)';
        configAlert.textContent = `❌ ${data.error || 'Ошибка подключения бота'}`;
      }

      await loadDiscordBotStatus();
    } catch (err) {
      configAlert.classList.remove('hidden');
      configAlert.style.background = 'rgba(239, 68, 68, 0.2)';
      configAlert.style.color = '#f87171';
      configAlert.textContent = '❌ Ошибка выполнения запроса к серверу';
    } finally {
      saveBtn.disabled = false;
      saveBtn.textContent = oldText;
    }
  });

  formTest?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = document.getElementById('discord-test-username')?.value.trim();
    if (!username) return;

    const testBtn = document.getElementById('btn-send-test-dm');
    const oldText = testBtn.textContent;
    testBtn.disabled = true;
    testBtn.textContent = '⏳ Отправка сообщения...';

    testAlert.classList.add('hidden');

    try {
      const res = await fetch(`${API_BASE}/api/v1/admin/discord/test-dm`, {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({ username })
      });

      const data = await res.json();
      testAlert.classList.remove('hidden');

      if (res.ok && data.success) {
        testAlert.style.background = 'rgba(34, 197, 94, 0.2)';
        testAlert.style.color = '#4ade80';
        testAlert.style.border = '1px solid rgba(34, 197, 94, 0.4)';
        testAlert.textContent = `✅ ${data.message}`;
      } else {
        testAlert.style.background = 'rgba(239, 68, 68, 0.2)';
        testAlert.style.color = '#f87171';
        testAlert.style.border = '1px solid rgba(239, 68, 68, 0.4)';
        testAlert.textContent = `❌ ${data.error || 'Не удалось отправить сообщение'}`;
      }
    } catch (err) {
      testAlert.classList.remove('hidden');
      testAlert.style.background = 'rgba(239, 68, 68, 0.2)';
      testAlert.style.color = '#f87171';
      testAlert.textContent = '❌ Ошибка выполнения запроса';
    } finally {
      testBtn.disabled = false;
      testBtn.textContent = oldText;
    }
  });

  const btnRefreshPending = document.getElementById('btn-refresh-pending-requests');
  btnRefreshPending?.addEventListener('click', loadPendingRequests);
}

// Загрузка и рендер активных запросов на вход игроков
async function loadPendingRequests() {
  const container = document.getElementById('pending-requests-container');
  if (!container) return;

  try {
    const res = await fetch(`${API_BASE}/api/v1/admin/discord/pending-requests`, {
      headers: getAuthHeaders()
    });
    if (!res.ok) return;

    const requests = await res.json();
    if (!requests || requests.length === 0) {
      container.innerHTML = `
        <div style="text-align: center; padding: 24px; color: var(--text-secondary); font-size: 13px;">
          Нет активных ожидающих запросов на вход в лаунчер
        </div>
      `;
      return;
    }

    container.innerHTML = `
      <table style="width: 100%; border-collapse: collapse; font-size: 13px;">
        <thead>
          <tr style="border-bottom: 1px solid rgba(255,255,255,0.1); text-align: left; color: var(--text-secondary);">
            <th style="padding: 10px;">Никнейм игрока</th>
            <th style="padding: 10px;">IP-адрес</th>
            <th style="padding: 10px;">Время запроса</th>
            <th style="padding: 10px; text-align: right;">Действие</th>
          </tr>
        </thead>
        <tbody>
          ${requests.map(r => `
            <tr style="border-bottom: 1px solid rgba(255,255,255,0.05);">
              <td style="padding: 10px; font-weight: 600; color: #ffedd5;">👤 ${r.username}</td>
              <td style="padding: 10px; font-family: monospace; color: var(--text-secondary);">${r.ip_address}</td>
              <td style="padding: 10px; color: var(--text-secondary);">${new Date(r.created_at).toLocaleTimeString('ru-RU')}</td>
              <td style="padding: 10px; text-align: right;">
                <button class="btn-primary btn-approve-request" data-id="${r.id}" data-user="${r.username}" style="padding: 6px 14px; font-size: 12px; background: #22c55e;">
                  ✅ Одобрить вход
                </button>
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;

    container.querySelectorAll('.btn-approve-request').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        const requestId = btn.dataset.id;
        const username = btn.dataset.user;
        btn.disabled = true;
        btn.textContent = '⏳ Одобрение...';

        try {
          const approveRes = await fetch(`${API_BASE}/api/v1/admin/discord/approve-request`, {
            method: 'POST',
            headers: getAuthHeaders(),
            body: JSON.stringify({ requestId })
          });
          const approveData = await approveRes.json();
          if (approveRes.ok && approveData.success) {
            alert(`✅ Вход для ${username} успешно одобрен! Лаунчер игрока сразу войдет в меню.`);
            loadPendingRequests();
          } else {
            alert(`❌ ${approveData.error || 'Ошибка'}`);
            btn.disabled = false;
          }
        } catch (err) {
          alert('Ошибка связи с сервером');
          btn.disabled = false;
        }
      });
    });
  } catch (err) {
    console.error('Ошибка загрузки pending requests:', err);
  }
}

// ----------------------------------------------------
// 10. МОБИЛЬНЫЕ БАЙПАСЫ (PojavLauncher / Телефоны)
// ----------------------------------------------------
function setupBypassesControls() {
  const form = document.getElementById('form-grant-bypass');
  if (form) {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const username = document.getElementById('bypass-username').value.trim();
      const reason = document.getElementById('bypass-reason').value.trim();
      const days = document.getElementById('bypass-days').value;

      try {
        const res = await fetch(`${API_BASE}/api/v1/admin/launcher/bypasses`, {
          method: 'POST',
          headers: getAuthHeaders(),
          body: JSON.stringify({ username, reason, days })
        });
        const data = await res.json();
        if (res.ok && data.success) {
          alert(`✅ Мобильный байпас для ${username} успешно выдан!`);
          document.getElementById('bypass-username').value = '';
          loadBypasses();
        } else {
          alert(`❌ ${data.error || 'Ошибка'}`);
        }
      } catch (err) {
        alert('Ошибка связи с сервером');
      }
    });
  }

  const refreshBtn = document.getElementById('btn-refresh-bypasses');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', loadBypasses);
  }
}

async function loadBypasses() {
  const tbody = document.getElementById('bypasses-table-body');
  if (!tbody) return;

  try {
    const res = await fetch(`${API_BASE}/api/v1/admin/launcher/bypasses`, { headers: getAuthHeaders() });
    const data = await res.json();
    const list = data.bypasses || [];

    if (list.length === 0) {
      tbody.innerHTML = `<tr><td colspan="5" style="text-align: center; color: var(--text-muted); padding: 20px;">Нет активных мобильных байпасов</td></tr>`;
      return;
    }

    tbody.innerHTML = list.map(b => `
      <tr>
        <td style="font-weight: 600; color: #ffedd5;">📱 ${b.username}</td>
        <td>${b.reason || 'PojavLauncher'}</td>
        <td>${b.created_by || 'ADMIN'}</td>
        <td>${b.expires_at ? new Date(b.expires_at).toLocaleDateString('ru-RU') : 'Бессрочно'}</td>
        <td>
          <button class="btn-danger btn-sm btn-revoke-bypass" data-id="${b.id}" data-user="${b.username}">🗑️ Отозвать</button>
        </td>
      </tr>
    `).join('');

    tbody.querySelectorAll('.btn-revoke-bypass').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm(`Отозвать мобильный байпас для ${btn.dataset.user}?`)) return;
        try {
          const delRes = await fetch(`${API_BASE}/api/v1/admin/launcher/bypasses/${btn.dataset.id}`, {
            method: 'DELETE',
            headers: getAuthHeaders()
          });
          if (delRes.ok) {
            loadBypasses();
          }
        } catch (_) {}
      });
    });
  } catch (err) {
    console.error('Ошибка загрузки байпасов:', err);
  }
}

// ----------------------------------------------------
// 11. ДЕБАГ-ЛОГИ ЛАУНЧЕРОВ (Хранение 3 дня)
// ----------------------------------------------------
function setupDebugLogsControls() {
  const searchInput = document.getElementById('search-debug-player');
  const filterOs = document.getElementById('filter-debug-os');
  const refreshBtn = document.getElementById('btn-refresh-debug-logs');

  if (searchInput) searchInput.addEventListener('input', () => debounce(loadDebugLogs, 300)());
  if (filterOs) filterOs.addEventListener('change', loadDebugLogs);
  if (refreshBtn) refreshBtn.addEventListener('click', loadDebugLogs);
}

async function loadDebugLogs() {
  const tbody = document.getElementById('debug-logs-table-body');
  if (!tbody) return;

  const username = document.getElementById('search-debug-player')?.value.trim() || '';
  const os = document.getElementById('filter-debug-os')?.value || '';

  try {
    const url = new URL(`${API_BASE}/api/v1/admin/debug-logs`);
    if (username) url.searchParams.set('username', username);
    if (os) url.searchParams.set('os', os);

    const res = await fetch(url.toString(), { headers: getAuthHeaders() });
    const data = await res.json();
    const logs = data.logs || [];

    if (logs.length === 0) {
      tbody.innerHTML = `<tr><td colspan="7" style="text-align: center; color: var(--text-muted); padding: 25px;">Логи не найдены</td></tr>`;
      return;
    }

    tbody.innerHTML = logs.map(l => `
      <tr>
        <td style="font-family: monospace; font-size: 12px; color: var(--text-secondary);">${new Date(l.created_at).toLocaleString('ru-RU')}</td>
        <td style="font-weight: 600; color: #bae6fd;">👤 ${l.username}</td>
        <td><span class="badge" style="background: rgba(59,130,246,0.2); color: #93c5fd;">${l.os || 'OS'}</span></td>
        <td style="font-family: monospace;">v${l.launcher_version || '3.1.0'}</td>
        <td><span class="badge" style="background: ${l.event_type === 'ERROR' ? 'rgba(239,68,68,0.2)' : 'rgba(34,197,94,0.2)'}; color: ${l.event_type === 'ERROR' ? '#fca5a5' : '#86efac'};">${l.event_type || 'INFO'}</span></td>
        <td style="color: var(--text-secondary); font-size: 12px;">${((l.size || 0) / 1024).toFixed(1)} КБ</td>
        <td>
          <button class="btn-secondary btn-sm btn-view-debug" data-id="${l.id}" data-user="${l.username}" data-time="${l.created_at}">👁️ Просмотр</button>
          <a class="btn-secondary btn-sm" href="${API_BASE}/api/v1/admin/debug-logs/${l.id}/download?token=${encodeURIComponent(state.token || localStorage.getItem('vozducraft_admin_token') || '')}" target="_blank" style="text-decoration: none; display: inline-block;">💾 .log</a>
          <button class="btn-danger btn-sm btn-del-debug" data-id="${l.id}">🗑️</button>
        </td>
      </tr>
    `).join('');

    tbody.querySelectorAll('.btn-view-debug').forEach(btn => {
      btn.addEventListener('click', () => openLogViewer('debug', btn.dataset.id, btn.dataset.user, btn.dataset.time));
    });

    tbody.querySelectorAll('.btn-del-debug').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm('Удалить эту запись лога?')) return;
        await fetch(`${API_BASE}/api/v1/admin/debug-logs/${btn.dataset.id}`, { method: 'DELETE', headers: getAuthHeaders() });
        loadDebugLogs();
      });
    });
  } catch (err) {
    console.error('Ошибка загрузки дебаг-логов:', err);
  }
}

// ----------------------------------------------------
// 12. КРАШ-РЕПОРТЫ MINECRAFT (/crash-reports, Хранение 3 дня)
// ----------------------------------------------------
function setupCrashReportsControls() {
  const searchInput = document.getElementById('search-crash-player');
  const refreshBtn = document.getElementById('btn-refresh-crash-reports');

  if (searchInput) searchInput.addEventListener('input', () => debounce(loadCrashReports, 300)());
  if (refreshBtn) refreshBtn.addEventListener('click', loadCrashReports);
}

async function loadCrashReports() {
  const tbody = document.getElementById('crash-reports-table-body');
  if (!tbody) return;

  const username = document.getElementById('search-crash-player')?.value.trim() || '';

  try {
    const url = new URL(`${API_BASE}/api/v1/admin/crash-reports`);
    if (username) url.searchParams.set('username', username);

    const res = await fetch(url.toString(), { headers: getAuthHeaders() });
    const data = await res.json();
    const reports = data.reports || [];

    if (reports.length === 0) {
      tbody.innerHTML = `<tr><td colspan="7" style="text-align: center; color: var(--text-muted); padding: 25px;">Краш-репорты отсутствуют</td></tr>`;
      return;
    }

    tbody.innerHTML = reports.map(c => `
      <tr>
        <td style="font-family: monospace; font-size: 12px; color: var(--text-secondary);">${new Date(c.created_at).toLocaleString('ru-RU')}</td>
        <td style="font-weight: 600; color: #fca5a5;">💥 ${c.username}</td>
        <td><span class="badge" style="background: rgba(239,68,68,0.2); color: #fca5a5;">${c.os || 'OS'}</span></td>
        <td>#${c.server_id || 1}</td>
        <td style="font-family: monospace; font-size: 12px;">${c.crash_filename}</td>
        <td style="color: var(--text-secondary); font-size: 12px;">${((c.size || 0) / 1024).toFixed(1)} КБ</td>
        <td>
          <button class="btn-secondary btn-sm btn-view-crash" data-id="${c.id}" data-user="${c.username}" data-file="${c.crash_filename}">👁️ Просмотр</button>
          <a class="btn-secondary btn-sm" href="${API_BASE}/api/v1/admin/crash-reports/${c.id}/download?token=${encodeURIComponent(state.token || localStorage.getItem('vozducraft_admin_token') || '')}" target="_blank" style="text-decoration: none; display: inline-block;">💾 .txt</a>
          <button class="btn-danger btn-sm btn-del-crash" data-id="${c.id}">🗑️</button>
        </td>
      </tr>
    `).join('');

    tbody.querySelectorAll('.btn-view-crash').forEach(btn => {
      btn.addEventListener('click', () => openLogViewer('crash', btn.dataset.id, btn.dataset.user, btn.dataset.file));
    });

    tbody.querySelectorAll('.btn-del-crash').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm('Удалить этот краш-отчет?')) return;
        await fetch(`${API_BASE}/api/v1/admin/crash-reports/${btn.dataset.id}`, { method: 'DELETE', headers: getAuthHeaders() });
        loadCrashReports();
      });
    });
  } catch (err) {
    console.error('Ошибка загрузки краш-репортов:', err);
  }
}

// ----------------------------------------------------
// 13. МОДАЛЬНОЕ ОКНО ПРОСМОТРА ЛОГА / КРАШ-РЕПОРТА
// ----------------------------------------------------
function setupLogViewerModal() {
  const modal = document.getElementById('modal-log-viewer');
  const closeBtn = document.getElementById('btn-close-log-viewer');
  const copyBtn = document.getElementById('btn-copy-log-content');

  if (closeBtn && modal) {
    closeBtn.addEventListener('click', () => modal.classList.add('hidden'));
    modal.addEventListener('click', (e) => {
      if (e.target === modal) modal.classList.add('hidden');
    });
  }

  if (copyBtn) {
    copyBtn.addEventListener('click', () => {
      const content = document.getElementById('log-viewer-content')?.textContent || '';
      navigator.clipboard.writeText(content).then(() => {
        copyBtn.textContent = '✅ Скопировано!';
        setTimeout(() => copyBtn.textContent = '📋 Копировать текст', 2000);
      });
    });
  }
}

async function openLogViewer(type, id, user, metaInfo) {
  const modal = document.getElementById('modal-log-viewer');
  const titleEl = document.getElementById('log-viewer-title');
  const metaEl = document.getElementById('log-viewer-meta');
  const contentEl = document.getElementById('log-viewer-content');
  const downloadLink = document.getElementById('btn-download-log-file');

  if (!modal || !contentEl) return;

  titleEl.textContent = type === 'debug' ? `🔍 Дебаг-лог игрока: ${user}` : `💥 Краш-репорт Minecraft: ${user}`;
  metaEl.textContent = `Игрок: ${user} • ${metaInfo}`;
  contentEl.textContent = 'Загрузка содержимого...';

  const token = state.token || localStorage.getItem('vozducraft_admin_token') || '';
  const downloadUrl = type === 'debug' 
    ? `${API_BASE}/api/v1/admin/debug-logs/${id}/download?token=${encodeURIComponent(token)}`
    : `${API_BASE}/api/v1/admin/crash-reports/${id}/download?token=${encodeURIComponent(token)}`;

  if (downloadLink) downloadLink.href = downloadUrl;

  modal.classList.remove('hidden');

  try {
    const fetchUrl = type === 'debug' 
      ? `${API_BASE}/api/v1/admin/debug-logs/${id}`
      : `${API_BASE}/api/v1/admin/crash-reports/${id}`;

    const res = await fetch(fetchUrl, { headers: getAuthHeaders() });
    const data = await res.json();

    contentEl.textContent = data.log_content || data.report_content || 'Лог пуст';
  } catch (err) {
    contentEl.textContent = 'Ошибка загрузки файла лога с сервера.';
  }
}

function debounce(func, wait) {
  let timeout;
  return function(...args) {
    clearTimeout(timeout);
    timeout = setTimeout(() => func.apply(this, args), wait);
  };
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// ----------------------------------------------------
// 13. УПРАВЛЕНИЕ АДМИНИСТРАТОРАМИ И МОДЕРАТОРАМИ
// ----------------------------------------------------

function setupAdminsControls() {
  const openModalBtn = document.getElementById('btn-open-create-admin');
  const modal = document.getElementById('modal-create-admin');
  const closeModalBtn = document.getElementById('btn-close-create-admin');
  const cancelModalBtn = document.getElementById('btn-cancel-create-admin');
  const refreshBtn = document.getElementById('btn-refresh-admins');
  const form = document.getElementById('form-create-admin');

  if (openModalBtn) {
    openModalBtn.addEventListener('click', () => {
      if (modal) modal.classList.remove('hidden');
    });
  }

  const closeModal = () => {
    if (modal) modal.classList.add('hidden');
    if (form) form.reset();
  };

  if (closeModalBtn) closeModalBtn.addEventListener('click', closeModal);
  if (cancelModalBtn) cancelModalBtn.addEventListener('click', closeModal);

  if (refreshBtn) {
    refreshBtn.addEventListener('click', () => {
      loadAdmins();
    });
  }

  if (form) {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const username = document.getElementById('admin-new-nick').value.trim();
      const password = document.getElementById('admin-new-pwd').value;
      const role = document.getElementById('admin-new-role').value;

      try {
        const res = await fetch(`${API_BASE}/api/v1/admin/admins`, {
          method: 'POST',
          headers: getAuthHeaders(),
          body: JSON.stringify({ username, password, role })
        });
        const data = await res.json();
        if (res.ok) {
          alert(data.message || 'Администратор успешно сохранен!');
          closeModal();
          loadAdmins();
        } else {
          alert(data.error || 'Ошибка добавления администратора');
        }
      } catch (err) {
        alert('Ошибка подключения к серверу: ' + err.message);
      }
    });
  }
}

async function loadAdmins() {
  const tbody = document.getElementById('admins-table-body');
  if (!tbody) return;
  tbody.innerHTML = '<tr><td colspan="6" style="text-align: center; color: var(--text-muted);">Загрузка администраторов...</td></tr>';

  try {
    const res = await fetch(`${API_BASE}/api/v1/admin/admins`, { headers: getAuthHeaders() });
    const data = await res.json();
    const admins = data.admins || [];

    if (admins.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" style="text-align: center; color: var(--text-muted);">Нет других администраторов</td></tr>';
      return;
    }

    tbody.innerHTML = admins.map(a => {
      const isMe = state.adminUser && a.username.toLowerCase() === state.adminUser.toLowerCase();
      let roleBadge = '<span class="badge" style="background: rgba(34, 197, 94, 0.2); color: #4ade80; border: 1px solid rgba(34, 197, 94, 0.4); padding: 4px 8px; border-radius: 4px; font-size: 11px;">🎮 Игрок</span>';
      if (a.role === 'ADMIN') {
        roleBadge = '<span class="badge" style="background: rgba(239, 68, 68, 0.2); color: #f87171; border: 1px solid rgba(239, 68, 68, 0.4); padding: 4px 8px; border-radius: 4px; font-size: 11px;">👑 Главный Администратор</span>';
      } else if (a.role === 'MODERATOR') {
        roleBadge = '<span class="badge" style="background: rgba(59, 130, 246, 0.2); color: #60a5fa; border: 1px solid rgba(59, 130, 246, 0.4); padding: 4px 8px; border-radius: 4px; font-size: 11px;">🛡️ Модератор</span>';
      }

      const dateStr = a.created_at ? new Date(a.created_at).toLocaleString('ru-RU') : 'Не указана';

      return `
        <tr>
          <td>#${a.id}</td>
          <td><strong>${escapeHtml(a.username)}</strong> ${isMe ? '<span style="font-size: 11px; color: var(--primary);"> (Вы)</span>' : ''}</td>
          <td>${roleBadge}</td>
          <td>${escapeHtml(a.last_ip || '—')}</td>
          <td>${dateStr}</td>
          <td>
            ${isMe ? '<span style="color: var(--text-muted); font-size: 12px;">Текущий аккаунт</span>' : `
              <button class="btn-danger btn-sm btn-delete-admin" data-id="${a.id}" data-name="${escapeHtml(a.username)}">🗑️ Удалить доступ</button>
            `}
          </td>
        </tr>
      `;
    }).join('');

    tbody.querySelectorAll('.btn-delete-admin').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.id;
        const name = btn.dataset.name;
        if (!confirm(`Вы действительно хотите удалить администратора "${name}"?\nЕго активная сессия будет немедленно сброшена, и доступ к панели заблокирован!`)) {
          return;
        }

        try {
          const delRes = await fetch(`${API_BASE}/api/v1/admin/admins/${id}`, {
            method: 'DELETE',
            headers: getAuthHeaders()
          });
          const delData = await delRes.json();
          if (delRes.ok) {
            alert(delData.message || 'Администратор удален');
            loadAdmins();
          } else {
            alert(delData.error || 'Ошибка удаления');
          }
        } catch (e) {
          alert('Ошибка соединения: ' + e.message);
        }
      });
    });
  } catch (err) {
    tbody.innerHTML = '<tr><td colspan="6" style="text-align: center; color: var(--danger);">Ошибка загрузки списка администраторов</td></tr>';
  }
}

// ----------------------------------------------------
// 14. ПРОВЕРКА И ОБНОВЛЕНИЕ ВСЕХ МОДОВ ЧЕРЕЗ MODRINTH
// ----------------------------------------------------
let currentModUpdates = [];

function setupModUpdatesControls() {
  const btnCheckUpdates = document.getElementById('btn-check-all-updates');
  const modal = document.getElementById('modal-mod-updates');
  const btnClose = document.getElementById('btn-close-mod-updates');
  const btnCloseBottom = document.getElementById('btn-close-mod-updates-bottom');
  const btnRecheck = document.getElementById('btn-recheck-mod-updates');
  const btnUpdateAll = document.getElementById('btn-update-all-mods');
  const btnUpdateAllZip = document.getElementById('btn-update-all-zip');

  const closeModal = () => {
    if (modal) modal.classList.add('hidden');
  };

  if (btnCheckUpdates) {
    btnCheckUpdates.addEventListener('click', () => {
      openModUpdatesModal();
    });
  }

  if (btnClose) btnClose.addEventListener('click', closeModal);
  if (btnCloseBottom) btnCloseBottom.addEventListener('click', closeModal);

  if (btnRecheck) {
    btnRecheck.addEventListener('click', () => {
      runCheckModUpdates();
    });
  }

  if (btnUpdateAll) {
    btnUpdateAll.addEventListener('click', async () => {
      await updateAllPendingMods();
    });
  }

  if (btnUpdateAllZip) {
    btnUpdateAllZip.addEventListener('click', async () => {
      await updateAllModsAndDownloadZip();
    });
  }
}

function openModUpdatesModal() {
  const modal = document.getElementById('modal-mod-updates');
  if (modal) modal.classList.remove('hidden');
  runCheckModUpdates();
}

async function runCheckModUpdates() {
  const loadingEl = document.getElementById('mod-updates-loading');
  const emptyEl = document.getElementById('mod-updates-empty');
  const listContainer = document.getElementById('mod-updates-list-container');
  const summaryText = document.getElementById('mod-updates-summary-text');
  const loaderBadge = document.getElementById('badge-update-server-loader');
  const btnUpdateAll = document.getElementById('btn-update-all-mods');
  const countPending = document.getElementById('count-pending-updates');

  if (loadingEl) loadingEl.classList.remove('hidden');
  if (emptyEl) emptyEl.classList.add('hidden');
  if (listContainer) {
    listContainer.classList.add('hidden');
    listContainer.innerHTML = '';
  }
  if (summaryText) summaryText.textContent = 'Сверка хэшей установленных модов с Modrinth API...';
  if (btnUpdateAll) btnUpdateAll.disabled = true;

  try {
    const res = await fetch(`${API_BASE}/api/v1/admin/modpack/check-updates`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({ serverId: state.currentServerId || 1 })
    });
    const data = await res.json();

    if (loadingEl) loadingEl.classList.add('hidden');

    if (!res.ok) {
      alert(data.error || 'Ошибка проверки обновлений модов');
      return;
    }

    if (loaderBadge && data.serverInfo) {
      loaderBadge.textContent = `${(data.serverInfo.modloader || 'NeoForge').toUpperCase()} ${data.serverInfo.minecraftVersion || '1.21.1'}`;
    }

    currentModUpdates = data.updates || [];

    if (currentModUpdates.length === 0) {
      if (emptyEl) emptyEl.classList.remove('hidden');
      if (summaryText) summaryText.textContent = `Проверено ${data.totalChecked} модов — все актуальны!`;
      if (countPending) countPending.textContent = '0';
      if (btnUpdateAll) btnUpdateAll.disabled = true;
      return;
    }

    if (summaryText) {
      summaryText.textContent = `Найдено ${currentModUpdates.length} обновлений из ${data.totalChecked} проверенных модов`;
    }
    if (countPending) countPending.textContent = currentModUpdates.length;
    if (btnUpdateAll) btnUpdateAll.disabled = false;

    renderModUpdatesList(currentModUpdates);
  } catch (err) {
    if (loadingEl) loadingEl.classList.add('hidden');
    alert('Ошибка соединения с сервером: ' + err.message);
  }
}

function renderModUpdatesList(updates) {
  const listContainer = document.getElementById('mod-updates-list-container');
  if (!listContainer) return;

  listContainer.classList.remove('hidden');
  listContainer.innerHTML = '';

  updates.forEach((item, index) => {
    const card = document.createElement('div');
    card.className = 'mod-update-card';
    card.id = `mod-update-card-${index}`;

    const sizeMb = (item.newFileSize / (1024 * 1024)).toFixed(2);
    const dateStr = item.datePublished ? new Date(item.datePublished).toLocaleDateString('ru-RU') : '';

    const iconHtml = item.projectIcon 
      ? `<img src="${item.projectIcon}" alt="${escapeHtml(item.projectTitle)}" class="mod-logo-img" onerror="this.outerHTML='<span class=\\'mod-logo-fallback\\'>📦</span>'">`
      : `<span class="mod-logo-fallback">📦</span>`;

    card.innerHTML = `
      <div class="mod-info-left">
        <div class="mod-logo-box">
          ${iconHtml}
        </div>
        <div class="mod-details-text">
          <div class="mod-title-row">
            <a href="${item.modrinthUrl}" target="_blank" rel="noopener noreferrer" class="mod-title-link" title="Открыть страницу мода на Modrinth">
              ${escapeHtml(item.projectTitle || item.currentModName)}
              <span class="mod-link-icon">↗</span>
            </a>
            ${item.newVersionNumber ? `<span class="badge" style="background: rgba(14, 165, 233, 0.2); color: #38bdf8; font-size: 11px; padding: 2px 6px; border-radius: 4px;">v${escapeHtml(item.newVersionNumber)}</span>` : ''}
          </div>
          <div class="version-comparison-row">
            <span class="version-pill-old" title="Текущий файл">${escapeHtml(item.currentFilename)}</span>
            <span class="version-arrow">➔</span>
            <span class="version-pill-new" title="Новый файл">${escapeHtml(item.newFilename)} (${sizeMb} MB)</span>
            ${dateStr ? `<span style="color: var(--text-muted); font-size: 11px; margin-left: 4px;">• ${dateStr}</span>` : ''}
          </div>
        </div>
      </div>
      <div class="mod-update-actions">
        <button type="button" class="btn-update-direct btn-apply-update" data-index="${index}">⚡ Обновить</button>
        <button type="button" class="btn-update-download btn-apply-download-update" data-index="${index}">📥 Обновить и скачать</button>
      </div>
    `;

    listContainer.appendChild(card);
  });

  // Привязка действий к кнопкам
  listContainer.querySelectorAll('.btn-apply-update').forEach(btn => {
    btn.addEventListener('click', async () => {
      const idx = parseInt(btn.dataset.index, 10);
      await performModUpdate(idx, false);
    });
  });

  listContainer.querySelectorAll('.btn-apply-download-update').forEach(btn => {
    btn.addEventListener('click', async () => {
      const idx = parseInt(btn.dataset.index, 10);
      await performModUpdate(idx, true);
    });
  });
}

async function performModUpdate(index, downloadToBrowser) {
  const item = currentModUpdates[index];
  if (!item) return;

  const card = document.getElementById(`mod-update-card-${index}`);
  if (card) {
    card.classList.add('updating');
    const actions = card.querySelector('.mod-update-actions');
    if (actions) actions.innerHTML = '<span style="color: #38bdf8; font-size: 12px;">⏳ Скачивание и установка...</span>';
  }

  try {
    const res = await fetch(`${API_BASE}/api/v1/admin/modpack/apply-update`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({
        serverId: state.currentServerId || 1,
        oldFilepath: item.currentFilepath,
        newFileUrl: item.newFileUrl,
        newFilename: item.newFilename,
        modName: item.projectTitle || item.currentModName,
        modDescription: item.changelog || 'Обновлено через Modrinth'
      })
    });
    const data = await res.json();

    if (res.ok && data.success) {
      if (downloadToBrowser) {
        triggerBrowserDownload(data.downloadUrl || data.directCdnUrl, item.newFilename);
      }

      if (card) {
        card.classList.remove('updating');
        card.classList.add('updated');
        const actions = card.querySelector('.mod-update-actions');
        if (actions) {
          actions.innerHTML = `
            <span style="color: #4ade80; font-weight: 600; font-size: 13px; display: inline-flex; align-items: center; gap: 4px;">
              ✅ Обновлено ${downloadToBrowser ? '+ Скачано' : ''}
            </span>
          `;
        }
      }

      // Обновляем счетчик
      item._updated = true;
      const remaining = currentModUpdates.filter(u => !u._updated).length;
      const countPending = document.getElementById('count-pending-updates');
      if (countPending) countPending.textContent = remaining;

      // Обновляем список в основном интерфейсе
      await loadModpack();
    } else {
      alert(data.error || 'Ошибка обновления мода');
      if (card) {
        card.classList.remove('updating');
        const actions = card.querySelector('.mod-update-actions');
        if (actions) {
          actions.innerHTML = `
            <button type="button" class="btn-update-direct btn-apply-update" data-index="${index}">⚡ Повторить</button>
            <button type="button" class="btn-update-download btn-apply-download-update" data-index="${index}">📥 Скачать</button>
          `;
          actions.querySelector('.btn-apply-update')?.addEventListener('click', () => performModUpdate(index, false));
          actions.querySelector('.btn-apply-download-update')?.addEventListener('click', () => performModUpdate(index, true));
        }
      }
    }
  } catch (err) {
    alert('Ошибка соединения: ' + err.message);
    if (card) card.classList.remove('updating');
  }
}

function triggerBrowserDownload(url, filename) {
  let fullUrl = url;
  if (url.startsWith('/')) {
    const origin = API_BASE.replace('/api/v1', '');
    fullUrl = `${origin}${url}`;
  }
  const a = document.createElement('a');
  a.href = fullUrl;
  a.download = filename;
  a.target = '_blank';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

async function updateAllPendingMods() {
  const pendingIndices = currentModUpdates
    .map((item, idx) => ({ item, idx }))
    .filter(({ item }) => !item._updated);

  if (pendingIndices.length === 0) {
    alert('Все доступные обновления уже установлены!');
    return;
  }

  const btnUpdateAll = document.getElementById('btn-update-all-mods');
  if (btnUpdateAll) btnUpdateAll.disabled = true;

  for (let i = 0; i < pendingIndices.length; i++) {
    const { idx } = pendingIndices[i];
    if (btnUpdateAll) btnUpdateAll.textContent = `Обновление (${i + 1}/${pendingIndices.length})...`;
    await performModUpdate(idx, false);
  }

  if (btnUpdateAll) {
    btnUpdateAll.textContent = '✅ Все моды обновлены!';
    btnUpdateAll.disabled = true;
  }
}

async function updateAllModsAndDownloadZip() {
  const pendingUpdates = currentModUpdates.filter(u => !u._updated);
  if (pendingUpdates.length === 0) {
    alert('Все доступные обновления уже установлены!');
    return;
  }

  const btnUpdateAllZip = document.getElementById('btn-update-all-zip');
  const btnUpdateAll = document.getElementById('btn-update-all-mods');
  const summaryText = document.getElementById('mod-updates-summary-text');

  if (btnUpdateAllZip) {
    btnUpdateAllZip.disabled = true;
    btnUpdateAllZip.textContent = `⏳ Скачивание и сборка ZIP (${pendingUpdates.length} модов)...`;
  }
  if (btnUpdateAll) btnUpdateAll.disabled = true;
  if (summaryText) summaryText.textContent = `Сервер скачивает ${pendingUpdates.length} модов и упаковывает в ZIP архив...`;

  try {
    const res = await fetch(`${API_BASE}/api/v1/admin/modpack/batch-update-and-zip`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({
        serverId: state.currentServerId || 1,
        updates: pendingUpdates.map(item => ({
          oldFilepath: item.currentFilepath,
          newFileUrl: item.newFileUrl,
          newFilename: item.newFilename,
          modName: item.projectTitle || item.currentModName,
          modDescription: item.changelog || 'Обновлено через Modrinth Batch ZIP'
        }))
      })
    });
    const data = await res.json();

    if (res.ok && data.success) {
      // Инициируем скачивание ZIP-архива в браузер
      triggerBrowserDownload(data.zipDownloadUrl, data.zipFilename);

      // Помечаем все карточки как обновленные
      currentModUpdates.forEach((item, idx) => {
        item._updated = true;
        const card = document.getElementById(`mod-update-card-${idx}`);
        if (card) {
          card.classList.remove('updating');
          card.classList.add('updated');
          const actions = card.querySelector('.mod-update-actions');
          if (actions) {
            actions.innerHTML = '<span style="color: #4ade80; font-weight: 600; font-size: 13px;">✅ Обновлено + В архиве</span>';
          }
        }
      });

      const countPending = document.getElementById('count-pending-updates');
      if (countPending) countPending.textContent = '0';
      if (summaryText) {
        summaryText.textContent = `✅ Успешно обновлено ${data.updatedCount} модов! Архив (${(data.zipSizeBytes / (1024*1024)).toFixed(2)} MB) скачивается в браузер.`;
      }

      if (btnUpdateAllZip) {
        btnUpdateAllZip.textContent = '✅ ZIP скачан';
        btnUpdateAllZip.disabled = true;
      }
      if (btnUpdateAll) {
        btnUpdateAll.textContent = '✅ Всё обновлено';
        btnUpdateAll.disabled = true;
      }

      await loadModpack();
      alert(`Успешно обновлено ${data.updatedCount} модов на сервере!\nАрхив ${data.zipFilename} отправлен в ваши загрузки.`);
    } else {
      alert(data.error || 'Ошибка при пакетном обновлении модов');
      if (btnUpdateAllZip) {
        btnUpdateAllZip.disabled = false;
        btnUpdateAllZip.textContent = '📦 Обновить всё и скачать ZIP';
      }
      if (btnUpdateAll) btnUpdateAll.disabled = false;
    }
  } catch (err) {
    alert('Ошибка соединения: ' + err.message);
    if (btnUpdateAllZip) {
      btnUpdateAllZip.disabled = false;
      btnUpdateAllZip.textContent = '📦 Обновить всё и скачать ZIP';
    }
    if (btnUpdateAll) btnUpdateAll.disabled = false;
  }
}

// ----------------------------------------------------
// 15. SFTP СИНХРОНИЗАЦИЯ И ОБНОВЛЕНИЕ МОДОВ НА MINECRAFT СЕРВЕРЕ
// ----------------------------------------------------
let sftpSessionConfig = null;
let sftpMatchedUpdates = [];

function setupSftpSyncControls() {
  const btnOpenSftp = document.getElementById('btn-open-sftp-sync');
  const modal = document.getElementById('modal-sftp-sync');
  const btnClose = document.getElementById('btn-close-sftp-sync');
  const btnCancel = document.getElementById('btn-cancel-sftp-sync');
  const formConnect = document.getElementById('form-sftp-connect');
  const btnBackCreds = document.getElementById('btn-back-to-sftp-creds');
  const btnConfirmDeploy = document.getElementById('btn-confirm-sftp-deploy');
  const btnDoneClose = document.getElementById('btn-sftp-done-close');

  const closeModal = () => {
    if (modal) modal.classList.add('hidden');
    resetSftpModal();
  };

  if (btnOpenSftp) {
    btnOpenSftp.addEventListener('click', () => {
      openSftpSyncModal();
    });
  }

  if (btnClose) btnClose.addEventListener('click', closeModal);
  if (btnCancel) btnCancel.addEventListener('click', closeModal);
  if (btnDoneClose) btnDoneClose.addEventListener('click', closeModal);

  if (btnBackCreds) {
    btnBackCreds.addEventListener('click', () => {
      showSftpStep('sftp-step-credentials');
    });
  }

  if (formConnect) {
    formConnect.addEventListener('submit', async (e) => {
      e.preventDefault();
      await handleSftpTestAndScan();
    });
  }

  const hostInput = document.getElementById('sftp-host');
  const portInput = document.getElementById('sftp-port');
  const userInput = document.getElementById('sftp-user');

  if (hostInput) {
    hostInput.addEventListener('input', () => {
      let val = hostInput.value.trim();
      if (/^(sftp|ssh|ftp):\/\//i.test(val) || val.includes(':') || val.includes('@')) {
        val = val.replace(/^(sftp|ssh|ftp):\/\//i, '');
        if (val.includes('@')) {
          const atParts = val.split('@');
          if (userInput && !userInput.value && atParts[0]) userInput.value = atParts[0].trim();
          val = atParts.slice(1).join('@');
        }
        if (val.includes(':')) {
          const colonParts = val.split(':');
          val = colonParts[0].trim();
          const p = parseInt(colonParts[1], 10);
          if (portInput && !isNaN(p) && p > 0) portInput.value = p;
        }
        if (val.includes('/')) val = val.split('/')[0].trim();
        hostInput.value = val;
      }
    });
  }

  if (btnConfirmDeploy) {
    btnConfirmDeploy.addEventListener('click', async () => {
      await handleSftpDeploy();
    });
  }
}

function resetSftpModal() {
  showSftpStep('sftp-step-credentials');
  const passInput = document.getElementById('sftp-pass');
  if (passInput) passInput.value = '';
  sftpSessionConfig = null;
  sftpMatchedUpdates = [];
}

function showSftpStep(stepId) {
  ['sftp-step-credentials', 'sftp-step-confirm', 'sftp-step-progress', 'sftp-step-done'].forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      if (id === stepId) el.classList.remove('hidden');
      else el.classList.add('hidden');
    }
  });
}

function openSftpSyncModal() {
  const modal = document.getElementById('modal-sftp-sync');
  if (!modal) return;

  const pending = currentModUpdates.filter(u => !u._updated);
  if (pending.length === 0) {
    alert('Все доступные обновления уже установлены!');
    return;
  }

  // Автозаполнение хоста IP сервера
  const hostInput = document.getElementById('sftp-host');
  if (hostInput && !hostInput.value) {
    const activeServer = state.servers?.find(s => s.id === state.currentServerId);
    if (activeServer && activeServer.server_ip) {
      hostInput.value = activeServer.server_ip;
    }
  }

  resetSftpModal();
  modal.classList.remove('hidden');
}

async function handleSftpTestAndScan() {
  const host = document.getElementById('sftp-host').value.trim();
  const port = parseInt(document.getElementById('sftp-port').value, 10) || 22;
  const username = document.getElementById('sftp-user').value.trim();
  const password = document.getElementById('sftp-pass').value;
  const remotePath = document.getElementById('sftp-path').value.trim() || 'mods';
  const submitBtn = document.getElementById('btn-submit-sftp-test');

  if (!host || !username || !password) {
    alert('Заполните все поля подключения');
    return;
  }

  const pending = currentModUpdates.filter(u => !u._updated);
  if (pending.length === 0) {
    alert('Нет модов для обновления!');
    return;
  }

  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.textContent = '⏳ Подключение к SFTP и проверка...';
  }

  try {
    const res = await fetch(`${API_BASE}/api/v1/admin/modpack/sftp-test-scan`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({
        host,
        port,
        username,
        password,
        remotePath,
        updates: pending
      })
    });
    const data = await res.json();

    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent = '🔍 Подключиться и сверить файлы';
    }

    if (!res.ok) {
      alert(data.error || 'Ошибка подключения по SFTP');
      return;
    }

    sftpSessionConfig = { host, port, username, password, remotePath: data.remotePath || remotePath };
    sftpMatchedUpdates = data.matchedUpdates || pending;

    const summaryEl = document.getElementById('sftp-confirm-summary');
    if (summaryEl) {
      const onRemoteCount = sftpMatchedUpdates.filter(u => u.existsOnRemote).length;
      summaryEl.textContent = `Директория: "${data.remotePath}" (${data.totalRemoteFiles} файлов). Найдено на сервере для замены: ${onRemoteCount} из ${sftpMatchedUpdates.length} модов.`;
    }

    renderSftpMatchedList(sftpMatchedUpdates);
    showSftpStep('sftp-step-confirm');
  } catch (err) {
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent = '🔍 Подключиться и сверить файлы';
    }
    alert('Ошибка соединения с бэкендом: ' + err.message);
  }
}

function renderSftpMatchedList(updates) {
  const container = document.getElementById('sftp-matched-files-list');
  if (!container) return;

  container.innerHTML = '';

  updates.forEach(u => {
    const item = document.createElement('div');
    item.style.cssText = 'display: flex; align-items: center; justify-content: space-between; padding: 6px 10px; background: rgba(255,255,255,0.03); border-radius: 6px; font-size: 12px; gap: 8px;';

    const statusBadge = u.existsOnRemote 
      ? '<span style="color: #4ade80; background: rgba(34,197,94,0.15); padding: 2px 6px; border-radius: 4px; font-size: 11px;">🔄 Заменит файл на сервере</span>'
      : '<span style="color: #38bdf8; background: rgba(56,189,248,0.15); padding: 2px 6px; border-radius: 4px; font-size: 11px;">➕ Добавит новый файл</span>';

    item.innerHTML = `
      <div style="flex: 1; min-width: 0; display: flex; flex-direction: column;">
        <strong style="color: #f8fafc;">${escapeHtml(u.projectTitle || u.currentModName)}</strong>
        <span style="color: #94a3b8; font-family: monospace; font-size: 11px;">
          ${escapeHtml(u.currentFilename)} ➔ <span style="color: #a7f3d0;">${escapeHtml(u.newFilename)}</span>
        </span>
      </div>
      <div style="flex-shrink: 0;">
        ${statusBadge}
      </div>
    `;

    container.appendChild(item);
  });
}

async function handleSftpDeploy() {
  if (!sftpSessionConfig) {
    alert('Сессия SFTP истекла. Пожалуйста, введите данные снова.');
    showSftpStep('sftp-step-credentials');
    return;
  }

  const pending = currentModUpdates.filter(u => !u._updated);
  if (pending.length === 0) {
    alert('Нет модов для обновления!');
    return;
  }

  showSftpStep('sftp-step-progress');

  const titleEl = document.getElementById('sftp-progress-title');
  const subEl = document.getElementById('sftp-progress-sub');
  if (titleEl) titleEl.textContent = `Обновление ${pending.length} модов и загрузка на SFTP...`;
  if (subEl) subEl.textContent = `Сервер ${sftpSessionConfig.host}:${sftpSessionConfig.port} (${sftpSessionConfig.remotePath})`;

  try {
    const res = await fetch(`${API_BASE}/api/v1/admin/modpack/sftp-deploy-updates`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({
        ...sftpSessionConfig,
        serverId: state.currentServerId || 1,
        updates: pending.map(item => ({
          oldFilepath: item.currentFilepath,
          newFileUrl: item.newFileUrl,
          newFilename: item.newFilename,
          modName: item.projectTitle || item.currentModName,
          modDescription: item.changelog || 'Обновлено через Modrinth SFTP Deploy'
        }))
      })
    });
    const data = await res.json();

    if (res.ok && data.success) {
      currentModUpdates.forEach((item, idx) => {
        item._updated = true;
        const card = document.getElementById(`mod-update-card-${idx}`);
        if (card) {
          card.classList.remove('updating');
          card.classList.add('updated');
          const actions = card.querySelector('.mod-update-actions');
          if (actions) {
            actions.innerHTML = '<span style="color: #4ade80; font-weight: 600; font-size: 13px;">✅ Установлено на сервер и лаунчер</span>';
          }
        }
      });

      const countPending = document.getElementById('count-pending-updates');
      if (countPending) countPending.textContent = '0';

      const detailsEl = document.getElementById('sftp-done-details');
      if (detailsEl) {
        detailsEl.innerHTML = `
          ✅ В лаунчере обновлено: <b>${data.updatedInLauncher}</b> модов<br>
          🚀 Загружено на Minecraft сервер по SFTP: <b>${data.uploadedToSftp}</b> файлов<br>
          🗑️ Удалено старых версий с сервера: <b>${data.deletedOldOnSftp}</b> файлов
        `;
      }

      showSftpStep('sftp-step-done');
      await loadModpack();
    } else {
      alert(data.error || 'Ошибка установки модов по SFTP');
      showSftpStep('sftp-step-confirm');
    }
  } catch (err) {
    alert('Ошибка соединения: ' + err.message);
    showSftpStep('sftp-step-confirm');
  } finally {
    if (sftpSessionConfig) sftpSessionConfig.password = '';
  }
}

// ----------------------------------------------------
// 14. МОДАЛЬНОЕ ОКНО РЕДАКТИРОВАНИЯ МОДА
// ----------------------------------------------------
function openEditModModal(modId) {
  const mod = state.currentModpack.find(m => Number(m.id) === Number(modId));
  if (!mod) return;

  document.getElementById('edit-mod-id').value = mod.id;
  document.getElementById('edit-mod-name').value = mod.mod_name || '';
  document.getElementById('edit-mod-group').value = mod.group_name || 'Общие';

  let displayUsers = mod.allowed_users || 'ALL';
  try {
    const parsed = JSON.parse(displayUsers);
    if (Array.isArray(parsed)) displayUsers = parsed.join(', ');
  } catch (_) {}
  document.getElementById('edit-mod-users').value = displayUsers;
  document.getElementById('edit-mod-icon').value = mod.icon_url || '';
  document.getElementById('edit-mod-desc').value = mod.mod_description || '';
  document.getElementById('edit-mod-optional').checked = mod.is_optional === 1;

  document.getElementById('modal-edit-mod').classList.remove('hidden');
}

function setupEditModModal() {
  const modal = document.getElementById('modal-edit-mod');
  const form = document.getElementById('form-edit-mod');
  const btnClose = document.getElementById('btn-close-edit-mod');
  const btnCancel = document.getElementById('btn-cancel-edit-mod');

  const closeModal = () => modal?.classList.add('hidden');
  btnClose?.addEventListener('click', closeModal);
  btnCancel?.addEventListener('click', closeModal);

  form?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = document.getElementById('edit-mod-id').value;
    const name = document.getElementById('edit-mod-name').value.trim();
    const group = document.getElementById('edit-mod-group').value.trim() || 'Общие';
    const rawUsers = document.getElementById('edit-mod-users').value.trim();
    const iconUrl = document.getElementById('edit-mod-icon').value.trim();
    const desc = document.getElementById('edit-mod-desc').value.trim();
    const isOpt = document.getElementById('edit-mod-optional').checked;

    let usersPayload = 'ALL';
    if (rawUsers && rawUsers.toUpperCase() !== 'ALL' && rawUsers !== '*') {
      usersPayload = rawUsers.split(',').map(u => u.trim()).filter(Boolean);
    }

    try {
      const res = await fetch(`${API_BASE}/api/v1/admin/modpack/${id}/details`, {
        method: 'PATCH',
        headers: getAuthHeaders(),
        body: JSON.stringify({
          mod_name: name,
          mod_description: desc,
          group_name: group,
          allowed_users: usersPayload,
          icon_url: iconUrl,
          is_optional: isOpt
        })
      });

      if (res.ok) {
        closeModal();
        await loadModpack();
      } else {
        const errData = await res.json();
        alert(errData.error || 'Ошибка сохранения параметров мода');
      }
    } catch (err) {
      alert('Ошибка соединения: ' + err.message);
    }
  });
}

// ----------------------------------------------------
// 14.1. МОДАЛЬНОЕ ОКНО МАССОВОЙ НАСТРОЙКИ МОДОВ
// ----------------------------------------------------
function setupBulkEditGroupModal() {
  const modal = document.getElementById('modal-bulk-edit-group');
  const form = document.getElementById('form-bulk-edit-group');
  const btnOpen = document.getElementById('btn-bulk-edit-group');
  const btnClose = document.getElementById('btn-close-bulk-edit-group');
  const btnCancel = document.getElementById('btn-cancel-bulk-edit-group');
  const countLabel = document.getElementById('bulk-mods-count-label');

  const closeModal = () => modal?.classList.add('hidden');
  btnClose?.addEventListener('click', closeModal);
  btnCancel?.addEventListener('click', closeModal);

  btnOpen?.addEventListener('click', () => {
    const selectedCount = state.selectedModIds.size;
    if (selectedCount === 0) {
      alert('Пожалуйста, выберите хотя бы один мод из списка (установите галочки в таблице).');
      return;
    }
    if (countLabel) countLabel.textContent = `${selectedCount} шт.`;
    form?.reset();
    modal?.classList.remove('hidden');
  });

  form?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const ids = Array.from(state.selectedModIds);
    if (ids.length === 0) {
      alert('Нет выбранных модов.');
      return;
    }

    const group = document.getElementById('bulk-mod-group').value.trim();
    const rawUsers = document.getElementById('bulk-mod-users').value.trim();
    const optChoice = document.getElementById('bulk-mod-optional').value;

    let usersPayload = undefined;
    if (rawUsers) {
      if (rawUsers.toUpperCase() === 'ALL' || rawUsers === '*') {
        usersPayload = 'ALL';
      } else {
        usersPayload = rawUsers.split(',').map(u => u.trim()).filter(Boolean);
      }
    }

    let isOptPayload = undefined;
    if (optChoice === '1') isOptPayload = 1;
    else if (optChoice === '0') isOptPayload = 0;

    const payload = {
      ids,
      group_name: group || undefined,
      allowed_users: usersPayload,
      is_optional: isOptPayload
    };

    try {
      const res = await fetch(`${API_BASE}/api/v1/admin/modpack/bulk-edit-details`, {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify(payload)
      });

      const data = await res.json();
      if (res.ok && data.success) {
        closeModal();
        state.selectedModIds.clear();
        await loadModpack();
      } else {
        alert(data.error || 'Ошибка группового изменения параметров');
      }
    } catch (err) {
      alert('Ошибка соединения: ' + err.message);
    }
  });
}

// ----------------------------------------------------
// 14.5. ЦЕНТР УПРАВЛЕНИЯ ГРУППАМИ МОДОВ (GROUPS HUB)
// ----------------------------------------------------
let groupsHubState = {
  activeGroupName: 'Общие',
  whitelistUsers: [],
  cachedUsers: [],
  selectedModsToAdd: new Set()
};

function setupGroupsHubControls() {
  const btnOpen = document.getElementById('btn-open-all-groups');
  const modalAll = document.getElementById('modal-all-groups');
  const btnCloseAll = document.getElementById('btn-close-all-groups');
  const searchGroups = document.getElementById('search-groups-input');
  const btnCreateGroup = document.getElementById('btn-create-new-group');
  const btnRenameGroup = document.getElementById('btn-group-rename');
  const btnDisbandGroup = document.getElementById('btn-group-disband');
  const btnAccessAll = document.getElementById('btn-access-all');
  const btnAccessWhite = document.getElementById('btn-access-whitelist');
  const btnAddPlayerChip = document.getElementById('btn-add-player-chip');
  const btnAddAllAdmins = document.getElementById('btn-add-all-admins');
  const btnAddAllPlayers = document.getElementById('btn-add-all-players');
  const btnClearMembers = document.getElementById('btn-clear-members');
  const btnSaveAccess = document.getElementById('btn-save-group-access');
  const btnSetAllOpt = document.getElementById('btn-group-set-all-opt');
  const btnSetAllReq = document.getElementById('btn-group-set-all-req');
  const searchGroupMods = document.getElementById('search-group-mods-input');
  const groupFilterSelect = document.getElementById('filter-group-select');

  // Добавление модов в группу (дочерняя модалка)
  const btnOpenAddMods = document.getElementById('btn-group-add-mods-open');
  const modalAddMods = document.getElementById('modal-group-add-mods');
  const btnCloseAddMods = document.getElementById('btn-close-group-add-mods');
  const btnCancelAddMods = document.getElementById('btn-cancel-group-add-mods');
  const searchAddMods = document.getElementById('group-add-mods-search');
  const filterAddSource = document.getElementById('group-add-mods-source-filter');
  const chkAddAll = document.getElementById('chk-group-add-all');
  const btnSelectAllAdd = document.getElementById('btn-group-add-select-all');
  const btnConfirmAddMods = document.getElementById('btn-confirm-group-add-mods');

  // Фильтр групп в основной таблице модов
  if (groupFilterSelect) {
    groupFilterSelect.addEventListener('change', () => {
      applyModpackFilters();
    });
  }

  // Открытие главного окна управления группами
  if (btnOpen) {
    btnOpen.addEventListener('click', () => {
      openAllGroupsModal();
    });
  }

  if (btnCloseAll) {
    btnCloseAll.addEventListener('click', () => {
      modalAll?.classList.add('hidden');
    });
  }

  if (searchGroups) {
    searchGroups.addEventListener('input', (e) => {
      renderGroupsNavList(e.target.value);
    });
  }

  // Создание новой группы
  if (btnCreateGroup) {
    btnCreateGroup.addEventListener('click', () => {
      const name = prompt('Введите название новой группы модов:');
      if (name && name.trim()) {
        groupsHubState.activeGroupName = name.trim();
        renderGroupsNavList();
        selectActiveGroup(groupsHubState.activeGroupName);
        openGroupAddModsModal();
      }
    });
  }

  // Переименование активной группы
  if (btnRenameGroup) {
    btnRenameGroup.addEventListener('click', async () => {
      const currentName = groupsHubState.activeGroupName;
      if (currentName === 'Общие') return;
      const newName = prompt('Новое название группы:', currentName);
      if (newName && newName.trim() && newName.trim() !== currentName) {
        try {
          const res = await fetch(`${API_BASE}/api/v1/admin/modpack/group-manager`, {
            method: 'POST',
            headers: getAuthHeaders(),
            body: JSON.stringify({
              serverId: state.currentServerId,
              action: 'rename-group',
              groupName: currentName,
              newGroupName: newName.trim()
            })
          });
          const data = await res.json();
          if (data.success) {
            groupsHubState.activeGroupName = newName.trim();
            await loadModpack();
            renderGroupsNavList();
            selectActiveGroup(groupsHubState.activeGroupName);
          } else {
            alert(data.error || 'Ошибка переименования группы');
          }
        } catch (err) {
          alert('Ошибка соединения: ' + err.message);
        }
      }
    });
  }

  // Расформирование активной группы в 'Общие'
  if (btnDisbandGroup) {
    btnDisbandGroup.addEventListener('click', async () => {
      const currentName = groupsHubState.activeGroupName;
      if (currentName === 'Общие') return;
      if (confirm(`Расформировать группу «${currentName}»? Все моды группы перейдут в категорию «Общие», а доступ станет публичным.`)) {
        try {
          const res = await fetch(`${API_BASE}/api/v1/admin/modpack/group-manager`, {
            method: 'POST',
            headers: getAuthHeaders(),
            body: JSON.stringify({
              serverId: state.currentServerId,
              action: 'delete-group',
              groupName: currentName
            })
          });
          const data = await res.json();
          if (data.success) {
            groupsHubState.activeGroupName = 'Общие';
            await loadModpack();
            renderGroupsNavList();
            selectActiveGroup('Общие');
          } else {
            alert(data.error || 'Ошибка расформирования группы');
          }
        } catch (err) {
          alert('Ошибка соединения: ' + err.message);
        }
      }
    });
  }

  // Переключение режима доступа (Публичная / Вайтлист)
  if (btnAccessAll) {
    btnAccessAll.addEventListener('click', () => {
      setGroupAccessMode(false);
    });
  }

  if (btnAccessWhite) {
    btnAccessWhite.addEventListener('click', () => {
      setGroupAccessMode(true);
    });
  }

  // Добавление участника в чипсы
  if (btnAddPlayerChip) {
    btnAddPlayerChip.addEventListener('click', () => {
      const sel = document.getElementById('select-add-player-dropdown');
      const customInput = document.getElementById('input-custom-player-nick');
      const selectedVal = sel?.value?.trim();
      const typedVal = customInput?.value?.trim();
      const nick = selectedVal || typedVal;
      if (nick) {
        if (!groupsHubState.whitelistUsers.some(u => u.toLowerCase() === nick.toLowerCase())) {
          groupsHubState.whitelistUsers.push(nick);
          renderGroupMembersChips();
        }
        if (sel) sel.value = '';
        if (customInput) customInput.value = '';
      }
    });
  }

  // Добавить всех админов
  if (btnAddAllAdmins) {
    btnAddAllAdmins.addEventListener('click', () => {
      const admins = groupsHubState.cachedUsers.filter(u => u.role === 'ADMIN').map(u => u.username);
      admins.forEach(adm => {
        if (!groupsHubState.whitelistUsers.some(u => u.toLowerCase() === adm.toLowerCase())) {
          groupsHubState.whitelistUsers.push(adm);
        }
      });
      renderGroupMembersChips();
    });
  }

  // Добавить всех зарегистрированных пользователей
  if (btnAddAllPlayers) {
    btnAddAllPlayers.addEventListener('click', () => {
      const all = groupsHubState.cachedUsers.map(u => u.username);
      all.forEach(p => {
        if (!groupsHubState.whitelistUsers.some(u => u.toLowerCase() === p.toLowerCase())) {
          groupsHubState.whitelistUsers.push(p);
        }
      });
      renderGroupMembersChips();
    });
  }

  // Очистить участников
  if (btnClearMembers) {
    btnClearMembers.addEventListener('click', () => {
      groupsHubState.whitelistUsers = [];
      renderGroupMembersChips();
    });
  }

  // Сохранить права доступа группы
  if (btnSaveAccess) {
    btnSaveAccess.addEventListener('click', async () => {
      const isWhitelist = !document.getElementById('group-whitelist-panel')?.classList.contains('hidden');
      const payloadUsers = isWhitelist ? groupsHubState.whitelistUsers : 'ALL';
      try {
        const res = await fetch(`${API_BASE}/api/v1/admin/modpack/group-manager`, {
          method: 'POST',
          headers: getAuthHeaders(),
          body: JSON.stringify({
            serverId: state.currentServerId,
            action: 'set-access',
            groupName: groupsHubState.activeGroupName,
            allowedUsers: payloadUsers
          })
        });
        const data = await res.json();
        if (data.success) {
          await loadModpack();
          renderGroupsNavList();
          selectActiveGroup(groupsHubState.activeGroupName);
          alert('✅ Права доступа группы успешно сохранены!');
        } else {
          alert(data.error || 'Ошибка сохранения прав доступа');
        }
      } catch (err) {
        alert('Ошибка соединения: ' + err.message);
      }
    });
  }

  // Массовая смена опциональности внутри группы
  if (btnSetAllOpt) {
    btnSetAllOpt.addEventListener('click', async () => {
      await fetch(`${API_BASE}/api/v1/admin/modpack/group-manager`, {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({
          serverId: state.currentServerId,
          action: 'set-optional',
          groupName: groupsHubState.activeGroupName,
          isOptional: 1
        })
      });
      await loadModpack();
      selectActiveGroup(groupsHubState.activeGroupName);
    });
  }

  if (btnSetAllReq) {
    btnSetAllReq.addEventListener('click', async () => {
      await fetch(`${API_BASE}/api/v1/admin/modpack/group-manager`, {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({
          serverId: state.currentServerId,
          action: 'set-optional',
          groupName: groupsHubState.activeGroupName,
          isOptional: 0
        })
      });
      await loadModpack();
      selectActiveGroup(groupsHubState.activeGroupName);
    });
  }

  // Поиск модов внутри группы
  if (searchGroupMods) {
    searchGroupMods.addEventListener('input', (e) => {
      const q = e.target.value.toLowerCase().trim();
      const mods = (state.currentModpack || []).filter(m => (m.group_name || 'Общие') === groupsHubState.activeGroupName);
      const filtered = mods.filter(m => 
        (m.mod_name && m.mod_name.toLowerCase().includes(q)) ||
        (m.filepath && m.filepath.toLowerCase().includes(q))
      );
      renderGroupModsTable(filtered);
    });
  }

  // Добавление модов в группу (Дочернее окно)
  if (btnOpenAddMods) {
    btnOpenAddMods.addEventListener('click', () => {
      openGroupAddModsModal();
    });
  }

  if (btnCloseAddMods) btnCloseAddMods.addEventListener('click', () => modalAddMods?.classList.add('hidden'));
  if (btnCancelAddMods) btnCancelAddMods.addEventListener('click', () => modalAddMods?.classList.add('hidden'));

  if (searchAddMods) {
    searchAddMods.addEventListener('input', () => {
      renderGroupAddModsTable();
    });
  }

  if (filterAddSource) {
    filterAddSource.addEventListener('change', () => {
      renderGroupAddModsTable();
    });
  }

  if (chkAddAll) {
    chkAddAll.addEventListener('change', (e) => {
      const isChecked = e.target.checked;
      document.querySelectorAll('.chk-add-mod-item').forEach(cb => {
        cb.checked = isChecked;
        const id = parseInt(cb.dataset.id, 10);
        if (isChecked) groupsHubState.selectedModsToAdd.add(id);
        else groupsHubState.selectedModsToAdd.delete(id);
      });
      if (btnConfirmAddMods) {
        btnConfirmAddMods.textContent = `➕ Добавить выбранные (${groupsHubState.selectedModsToAdd.size})`;
      }
    });
  }

  if (btnSelectAllAdd) {
    btnSelectAllAdd.addEventListener('click', () => {
      document.querySelectorAll('.chk-add-mod-item').forEach(cb => {
        cb.checked = true;
        const id = parseInt(cb.dataset.id, 10);
        groupsHubState.selectedModsToAdd.add(id);
      });
      if (btnConfirmAddMods) {
        btnConfirmAddMods.textContent = `➕ Добавить выбранные (${groupsHubState.selectedModsToAdd.size})`;
      }
    });
  }

  if (btnConfirmAddMods) {
    btnConfirmAddMods.addEventListener('click', async () => {
      const modIds = Array.from(groupsHubState.selectedModsToAdd);
      if (modIds.length === 0) return alert('Выберите хотя бы один мод для добавления в группу');

      try {
        const res = await fetch(`${API_BASE}/api/v1/admin/modpack/group-manager`, {
          method: 'POST',
          headers: getAuthHeaders(),
          body: JSON.stringify({
            serverId: state.currentServerId,
            action: 'add-mods',
            groupName: groupsHubState.activeGroupName,
            modIds
          })
        });
        const data = await res.json();
        if (data.success) {
          modalAddMods?.classList.add('hidden');
          await loadModpack();
          renderGroupsNavList();
          selectActiveGroup(groupsHubState.activeGroupName);
        } else {
          alert(data.error || 'Ошибка добавления модов');
        }
      } catch (err) {
        alert('Ошибка соединения: ' + err.message);
      }
    });
  }
}

async function openAllGroupsModal() {
  const modal = document.getElementById('modal-all-groups');
  if (!modal) return;

  const serverName = state.servers.find(s => s.id === state.currentServerId)?.name || `Сервер #${state.currentServerId}`;
  const badgeEl = document.getElementById('groups-modal-server-badge');
  if (badgeEl) badgeEl.textContent = `Сервер: ${serverName}`;

  if (groupsHubState.cachedUsers.length === 0) {
    try {
      const res = await fetch(`${API_BASE}/api/v1/admin/admins`, { headers: getAuthHeaders() });
      const data = await res.json();
      groupsHubState.cachedUsers = data.admins || [];
    } catch (_) {}
  }

  const userSelect = document.getElementById('select-add-player-dropdown');
  if (userSelect) {
    userSelect.innerHTML = '<option value="">➕ Выбрать зарегистрированного игрока...</option>';
    groupsHubState.cachedUsers.forEach(u => {
      const opt = document.createElement('option');
      opt.value = u.username;
      const roleIcon = u.role === 'ADMIN' ? '👑' : (u.role === 'MODERATOR' ? '🛡️' : '👤');
      opt.textContent = `${roleIcon} ${u.username} (${u.role})`;
      userSelect.appendChild(opt);
    });
  }

  const groups = getUniqueGroupsList();
  if (!groups.includes(groupsHubState.activeGroupName)) {
    groupsHubState.activeGroupName = groups[0] || 'Общие';
  }

  renderGroupsNavList();
  selectActiveGroup(groupsHubState.activeGroupName);

  modal.classList.remove('hidden');
}

function getUniqueGroupsList() {
  const set = new Set();
  (state.currentModpack || []).forEach(m => {
    set.add(m.group_name || 'Общие');
  });
  if (set.size === 0) set.add('Общие');
  return Array.from(set).sort();
}

function renderGroupsNavList(filterQuery = '') {
  const container = document.getElementById('groups-nav-list');
  if (!container) return;

  const groups = getUniqueGroupsList();
  container.innerHTML = '';

  const q = filterQuery.toLowerCase().trim();
  const filtered = groups.filter(g => !q || g.toLowerCase().includes(q));

  if (filtered.length === 0) {
    container.innerHTML = '<div style="color: var(--text-muted); font-size: 12px; text-align: center; padding: 20px;">Группы не найдены</div>';
    return;
  }

  filtered.forEach(groupName => {
    const modsInGroup = (state.currentModpack || []).filter(m => (m.group_name || 'Общие') === groupName);
    const count = modsInGroup.length;

    let isPrivate = false;
    let allowedCount = 0;
    for (const m of modsInGroup) {
      if (m.allowed_users && m.allowed_users !== 'ALL' && m.allowed_users !== '["ALL"]' && m.allowed_users.trim() !== '') {
        isPrivate = true;
        try {
          const parsed = JSON.parse(m.allowed_users);
          if (Array.isArray(parsed)) allowedCount = Math.max(allowedCount, parsed.length);
        } catch (_) {
          allowedCount = Math.max(allowedCount, m.allowed_users.split(',').length);
        }
      }
    }

    const item = document.createElement('div');
    item.className = `group-nav-item ${groupName === groupsHubState.activeGroupName ? 'active' : ''}`;
    
    const icon = isPrivate ? '🔒' : (groupName === 'Общие' ? '📦' : '📁');
    const badgePrivacy = isPrivate 
      ? `<span style="font-size: 10px; padding: 2px 6px; border-radius: 8px; background: rgba(245, 158, 11, 0.2); color: #fbbf24;">🔒 ${allowedCount} игрок.</span>`
      : `<span style="font-size: 10px; padding: 2px 6px; border-radius: 8px; background: rgba(16, 185, 129, 0.2); color: #34d399;">🌍 Всем</span>`;

    item.innerHTML = `
      <div class="group-nav-item-title">
        <span>${icon}</span>
        <span style="max-width: 140px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${groupName}</span>
      </div>
      <div class="group-nav-item-meta">
        ${badgePrivacy}
        <span style="font-size: 11px; font-weight: 700; color: #94a3b8; background: rgba(255,255,255,0.06); padding: 2px 6px; border-radius: 6px;">${count}</span>
      </div>
    `;

    item.addEventListener('click', () => {
      selectActiveGroup(groupName);
    });

    container.appendChild(item);
  });
}

function selectActiveGroup(groupName) {
  groupsHubState.activeGroupName = groupName;

  document.querySelectorAll('.group-nav-item').forEach(el => {
    const title = el.querySelector('.group-nav-item-title span:last-child')?.textContent;
    if (title === groupName) el.classList.add('active');
    else el.classList.remove('active');
  });

  const modsInGroup = (state.currentModpack || []).filter(m => (m.group_name || 'Общие') === groupName);

  const titleEl = document.getElementById('active-group-title');
  const countBadge = document.getElementById('active-group-badge-count');
  const subtitleEl = document.getElementById('active-group-subtitle');
  if (titleEl) titleEl.textContent = groupName;
  if (countBadge) countBadge.textContent = `${modsInGroup.length} модов`;
  
  const totalSizeBytes = modsInGroup.reduce((sum, m) => sum + (m.size_bytes || 0), 0);
  const totalMb = (totalSizeBytes / (1024 * 1024)).toFixed(1);
  if (subtitleEl) subtitleEl.textContent = `Общий вес: ${totalMb} МБ • Настройка прав доступа и состава файлов`;

  const btnDisband = document.getElementById('btn-group-disband');
  const btnRename = document.getElementById('btn-group-rename');
  if (btnDisband) btnDisband.style.display = groupName === 'Общие' ? 'none' : 'inline-block';
  if (btnRename) btnRename.style.display = groupName === 'Общие' ? 'none' : 'inline-block';

  let parsedUsers = [];
  let isPrivate = false;
  for (const m of modsInGroup) {
    if (m.allowed_users && m.allowed_users !== 'ALL' && m.allowed_users !== '["ALL"]' && m.allowed_users.trim() !== '') {
      isPrivate = true;
      try {
        const p = JSON.parse(m.allowed_users);
        if (Array.isArray(p)) parsedUsers = Array.from(new Set([...parsedUsers, ...p]));
      } catch (_) {
        m.allowed_users.split(',').forEach(u => { if (u.trim()) parsedUsers.push(u.trim()); });
      }
    }
  }

  groupsHubState.whitelistUsers = Array.from(new Set(parsedUsers));

  setGroupAccessMode(isPrivate);
  renderGroupModsTable(modsInGroup);
}

function setGroupAccessMode(isWhitelist) {
  const label = document.getElementById('group-access-type-label');
  const panel = document.getElementById('group-whitelist-panel');
  const btnAll = document.getElementById('btn-access-all');
  const btnWhite = document.getElementById('btn-access-whitelist');

  if (isWhitelist) {
    if (label) {
      label.textContent = '🔒 Приватная (Вайтлист)';
      label.style.background = 'rgba(245, 158, 11, 0.2)';
      label.style.color = '#fbbf24';
    }
    if (panel) panel.classList.remove('hidden');
    if (btnAll) {
      btnAll.style.background = 'rgba(255, 255, 255, 0.05)';
      btnAll.style.color = '#94a3b8';
    }
    if (btnWhite) {
      btnWhite.style.background = 'linear-gradient(135deg, #f59e0b, #d97706)';
      btnWhite.style.color = '#fff';
    }
    renderGroupMembersChips();
  } else {
    if (label) {
      label.textContent = '🌍 Публичная (Все игроки)';
      label.style.background = 'rgba(16, 185, 129, 0.15)';
      label.style.color = '#34d399';
    }
    if (panel) panel.classList.add('hidden');
    if (btnAll) {
      btnAll.style.background = 'linear-gradient(135deg, #10b981, #059669)';
      btnAll.style.color = '#fff';
    }
    if (btnWhite) {
      btnWhite.style.background = 'rgba(255, 255, 255, 0.05)';
      btnWhite.style.color = '#94a3b8';
    }
  }
}

function renderGroupMembersChips() {
  const container = document.getElementById('group-members-chips');
  if (!container) return;

  container.innerHTML = '';
  if (groupsHubState.whitelistUsers.length === 0) {
    container.innerHTML = '<span style="color: #94a3b8; font-size: 12px; font-style: italic;">Игроки не добавлены (выберите игрока из списка или введите ник)</span>';
    return;
  }

  groupsHubState.whitelistUsers.forEach(username => {
    const userObj = groupsHubState.cachedUsers.find(u => u.username.toLowerCase() === username.toLowerCase());
    const isAdmin = userObj && userObj.role === 'ADMIN';
    const isMod = userObj && userObj.role === 'MODERATOR';

    const chip = document.createElement('div');
    chip.className = `user-chip ${isAdmin ? 'user-chip-admin' : ''}`;
    
    const initial = username.charAt(0).toUpperCase();
    const roleTag = isAdmin ? ' 👑' : (isMod ? ' 🛡️' : '');

    chip.innerHTML = `
      <div class="user-chip-avatar">${initial}</div>
      <span>${username}${roleTag}</span>
      <button type="button" class="user-chip-remove" data-user="${username}" title="Удалить из группы">✕</button>
    `;

    chip.querySelector('.user-chip-remove')?.addEventListener('click', (e) => {
      e.stopPropagation();
      const u = e.currentTarget.dataset.user;
      groupsHubState.whitelistUsers = groupsHubState.whitelistUsers.filter(x => x.toLowerCase() !== u.toLowerCase());
      renderGroupMembersChips();
    });

    container.appendChild(chip);
  });
}

function renderGroupModsTable(mods) {
  const tbody = document.getElementById('group-mods-table-body');
  if (!tbody) return;

  tbody.innerHTML = '';
  if (!mods || mods.length === 0) {
    tbody.innerHTML = '<tr><td colspan="4" style="text-align: center; color: var(--text-muted); padding: 30px;">В этой группе пока нет модов. Нажмите «➕ Добавить мод», чтобы включить файлы в группу.</td></tr>';
    return;
  }

  const allGroups = getUniqueGroupsList();

  mods.forEach(mod => {
    const tr = document.createElement('tr');
    const sizeMb = (mod.size_bytes / (1024 * 1024)).toFixed(2);

    const iconHtml = mod.icon_url 
      ? `<img src="${mod.icon_url}" style="width: 28px; height: 28px; border-radius: 6px; object-fit: cover; flex-shrink: 0;" alt="logo" onerror="this.style.display='none'">`
      : `<div style="width: 28px; height: 28px; border-radius: 6px; display: flex; align-items: center; justify-content: center; background: rgba(255,107,0,0.15); color: #ff6b00; font-size: 14px; flex-shrink: 0;">🧩</div>`;

    let optionsHtml = `<option value="">📂 Переместить в...</option>`;
    allGroups.forEach(g => {
      if (g !== groupsHubState.activeGroupName) {
        optionsHtml += `<option value="${g}">${g}</option>`;
      }
    });

    tr.innerHTML = `
      <td>
        <div style="display: flex; align-items: center; gap: 8px;">
          ${iconHtml}
          <div style="overflow: hidden;">
            <div style="font-weight: 700; color: #f8fafc; font-size: 13px; max-width: 260px; text-overflow: ellipsis; overflow: hidden; white-space: nowrap;" title="${mod.mod_name || mod.filepath}">${mod.mod_name || mod.filepath}</div>
            <div style="font-size: 11px; color: #94a3b8; max-width: 260px; text-overflow: ellipsis; overflow: hidden; white-space: nowrap;">${mod.filepath}</div>
          </div>
        </div>
      </td>
      <td>${sizeMb} MB</td>
      <td>
        <span class="tag-badge ${mod.is_optional ? 'optional' : 'required'}" style="cursor: pointer;" title="Нажмите для переключения">
          ${mod.is_optional ? 'Опциональный' : 'Обязательный'}
        </span>
      </td>
      <td style="text-align: right;">
        <select class="styled-select group-move-select" data-id="${mod.id}" style="font-size: 11px; padding: 3px 6px; margin-right: 4px; max-width: 140px;">
          ${optionsHtml}
        </select>
        <button class="btn-icon btn-remove-mod-from-group" data-id="${mod.id}" title="Убрать из группы в 'Общие'" style="color: #f87171;">✕</button>
      </td>
    `;

    tr.querySelector('.tag-badge')?.addEventListener('click', async () => {
      await fetch(`${API_BASE}/api/v1/admin/modpack/${mod.id}/toggle-optional`, {
        method: 'PATCH',
        headers: getAuthHeaders()
      });
      await loadModpack();
      selectActiveGroup(groupsHubState.activeGroupName);
    });

    tr.querySelector('.group-move-select')?.addEventListener('change', async (e) => {
      const targetGroup = e.target.value;
      if (!targetGroup) return;
      await fetch(`${API_BASE}/api/v1/admin/modpack/group-manager`, {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({
          serverId: state.currentServerId,
          action: 'add-mods',
          groupName: targetGroup,
          modIds: [mod.id]
        })
      });
      await loadModpack();
      renderGroupsNavList();
      selectActiveGroup(groupsHubState.activeGroupName);
    });

    tr.querySelector('.btn-remove-mod-from-group')?.addEventListener('click', async () => {
      await fetch(`${API_BASE}/api/v1/admin/modpack/group-manager`, {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({
          serverId: state.currentServerId,
          action: 'remove-mods',
          modIds: [mod.id]
        })
      });
      await loadModpack();
      renderGroupsNavList();
      selectActiveGroup(groupsHubState.activeGroupName);
    });

    tbody.appendChild(tr);
  });
}

function openGroupAddModsModal() {
  const modal = document.getElementById('modal-group-add-mods');
  if (!modal) return;

  const titleEl = document.getElementById('group-add-mods-title');
  if (titleEl) titleEl.textContent = `➕ Добавить моды в группу «${groupsHubState.activeGroupName}»`;

  groupsHubState.selectedModsToAdd.clear();
  renderGroupAddModsTable();

  modal.classList.remove('hidden');
}

function renderGroupAddModsTable() {
  const tbody = document.getElementById('group-add-mods-table-body');
  const searchInput = document.getElementById('group-add-mods-search');
  const sourceFilter = document.getElementById('group-add-mods-source-filter');
  const confirmBtn = document.getElementById('btn-confirm-group-add-mods');
  if (!tbody) return;

  const q = searchInput ? searchInput.value.toLowerCase().trim() : '';
  const filterType = sourceFilter ? sourceFilter.value : 'unassigned';

  let mods = state.currentModpack || [];

  mods = mods.filter(m => (m.group_name || 'Общие') !== groupsHubState.activeGroupName);

  if (filterType === 'unassigned') {
    mods = mods.filter(m => (m.group_name || 'Общие') === 'Общие');
  } else if (filterType === 'other') {
    mods = mods.filter(m => (m.group_name || 'Общие') !== 'Общие');
  }

  if (q) {
    mods = mods.filter(m => 
      (m.mod_name && m.mod_name.toLowerCase().includes(q)) ||
      (m.filepath && m.filepath.toLowerCase().includes(q)) ||
      (m.group_name && m.group_name.toLowerCase().includes(q))
    );
  }

  if (confirmBtn) {
    confirmBtn.textContent = `➕ Добавить выбранные (${groupsHubState.selectedModsToAdd.size})`;
  }

  tbody.innerHTML = '';
  if (mods.length === 0) {
    tbody.innerHTML = '<tr><td colspan="4" style="text-align: center; color: var(--text-muted); padding: 24px;">Нет доступных модов по выбранному фильтру</td></tr>';
    return;
  }

  mods.forEach(mod => {
    const tr = document.createElement('tr');
    const isChecked = groupsHubState.selectedModsToAdd.has(mod.id);
    const sizeMb = (mod.size_bytes / (1024 * 1024)).toFixed(2);

    tr.innerHTML = `
      <td style="text-align: center;">
        <input type="checkbox" class="styled-checkbox chk-add-mod-item" data-id="${mod.id}" ${isChecked ? 'checked' : ''}>
      </td>
      <td>
        <div style="font-weight: 700; color: #f8fafc; font-size: 13px;">${mod.mod_name || mod.filepath}</div>
        <div style="font-size: 11px; color: #94a3b8;">${mod.filepath}</div>
      </td>
      <td>
        <span style="font-size: 11px; padding: 2px 8px; border-radius: 8px; background: rgba(255,255,255,0.06); color: #94a3b8;">
          ${mod.group_name || 'Общие'}
        </span>
      </td>
      <td>${sizeMb} MB</td>
    `;

    tr.querySelector('.chk-add-mod-item')?.addEventListener('change', (e) => {
      const id = parseInt(e.target.dataset.id, 10);
      if (e.target.checked) groupsHubState.selectedModsToAdd.add(id);
      else groupsHubState.selectedModsToAdd.delete(id);
      if (confirmBtn) confirmBtn.textContent = `➕ Добавить выбранные (${groupsHubState.selectedModsToAdd.size})`;
    });

    tbody.appendChild(tr);
  });
}

// ----------------------------------------------------
// 15. УПРАВЛЕНИЕ РЕСУРСПАКАМИ (RESOURCE PACKS)
// ----------------------------------------------------
let currentResourcePacks = [];

async function loadResourcePacks() {
  try {
    syncServerDropdownValues();
    const res = await fetch(`${API_BASE}/api/v1/admin/resourcepacks?serverId=${state.currentServerId}`, {
      headers: getAuthHeaders()
    });
    const data = await res.json();
    currentResourcePacks = data.resourcePacks || [];
    renderResourcePacksTable(currentResourcePacks);
  } catch (err) {
    console.error('Ошибка загрузки ресурспаков:', err);
  }
}

function renderResourcePacksTable(packs) {
  const tbody = document.getElementById('resourcepacks-table-body');
  const badge = document.getElementById('rps-count-badge');
  if (!tbody) return;

  if (badge) badge.textContent = `Всего ресурспаков: ${packs.length}`;
  tbody.innerHTML = '';

  if (packs.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" style="text-align: center; color: var(--text-muted); padding: 30px;">Для этого сервера пока нет ресурспаков. Нажмите «Загрузить .ZIP» или найдите в Modrinth.</td></tr>';
    return;
  }

  packs.forEach(pack => {
    const tr = document.createElement('tr');
    const sizeMb = (pack.size_bytes / (1024 * 1024)).toFixed(2);

    const iconHtml = pack.icon_url
      ? `<img src="${pack.icon_url}" style="width: 32px; height: 32px; border-radius: 6px; object-fit: cover; flex-shrink: 0; background: rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.1);" alt="logo">`
      : `<div style="width: 32px; height: 32px; border-radius: 6px; display: flex; align-items: center; justify-content: center; background: rgba(59,130,246,0.1); color: #60a5fa; font-size: 16px; flex-shrink: 0;">🎨</div>`;

    const isAllUsers = !pack.allowed_users || pack.allowed_users === 'ALL' || pack.allowed_users === '["ALL"]' || pack.allowed_users.trim() === '';
    let userBadgeHtml = `<span style="font-size: 11px; padding: 2px 8px; border-radius: 10px; background: rgba(34, 197, 94, 0.15); color: #4ade80; font-weight: 600;">Всем</span>`;
    if (!isAllUsers) {
      let displayUsers = pack.allowed_users;
      try {
        const parsed = JSON.parse(pack.allowed_users);
        if (Array.isArray(parsed)) displayUsers = parsed.join(', ');
      } catch (_) {}
      userBadgeHtml = `<span style="font-size: 11px; padding: 2px 8px; border-radius: 10px; background: rgba(245, 158, 11, 0.15); color: #fbbf24; font-weight: 600; max-width: 140px; display: inline-block; text-overflow: ellipsis; overflow: hidden; white-space: nowrap;" title="${displayUsers}">🔒 ${displayUsers}</span>`;
    }

    tr.innerHTML = `
      <td>
        <div style="display: flex; align-items: center; gap: 10px;">
          ${iconHtml}
          <div>
            <div style="font-weight: 600; font-size: 14px; color: #fff;">${pack.name}</div>
            <div style="font-size: 11px; color: var(--text-muted);">${pack.description || ''}</div>
          </div>
        </div>
      </td>
      <td><code style="font-size: 12px;">${pack.filename}</code></td>
      <td>
        <span style="font-size: 11px; padding: 3px 8px; border-radius: 12px; background: rgba(59, 130, 246, 0.15); color: #60a5fa; border: 1px solid rgba(59, 130, 246, 0.3); font-weight: 600;">
          ${pack.group_name || 'Текстуры'}
        </span>
      </td>
      <td>${userBadgeHtml}</td>
      <td>${sizeMb} MB</td>
      <td>
        <span class="tag-badge ${pack.is_optional ? 'optional' : 'required'}">
          ${pack.is_optional ? 'Опциональный' : 'Обязательный'}
        </span>
      </td>
      <td>
        <button class="btn-icon btn-edit-rp" data-id="${pack.id}" title="Редактировать" style="background: rgba(59, 130, 246, 0.2); color: #60a5fa; margin-right: 4px;">⚙️</button>
        <button class="btn-icon btn-delete-rp" data-id="${pack.id}" title="Удалить ресурспак">🗑️</button>
      </td>
    `;

    tbody.appendChild(tr);
  });

  document.querySelectorAll('.btn-edit-rp').forEach(b => {
    b.addEventListener('click', (e) => {
      const id = parseInt(e.currentTarget.dataset.id, 10);
      openEditRpModal(id);
    });
  });

  document.querySelectorAll('.btn-delete-rp').forEach(b => {
    b.addEventListener('click', async (e) => {
      const id = e.currentTarget.dataset.id;
      if (confirm('Удалить этот ресурспак?')) {
        await fetch(`${API_BASE}/api/v1/admin/resourcepacks/${id}`, {
          method: 'DELETE',
          headers: getAuthHeaders()
        });
        loadResourcePacks();
      }
    });
  });
}

function openEditRpModal(packId) {
  const pack = currentResourcePacks.find(p => p.id === packId);
  if (!pack) return;

  document.getElementById('edit-rp-id').value = pack.id;
  document.getElementById('edit-rp-name').value = pack.name || '';
  document.getElementById('edit-rp-group').value = pack.group_name || 'Текстуры';

  let displayUsers = pack.allowed_users || 'ALL';
  try {
    const parsed = JSON.parse(displayUsers);
    if (Array.isArray(parsed)) displayUsers = parsed.join(', ');
  } catch (_) {}
  document.getElementById('edit-rp-users').value = displayUsers;
  document.getElementById('edit-rp-icon').value = pack.icon_url || '';
  document.getElementById('edit-rp-desc').value = pack.description || '';
  document.getElementById('edit-rp-optional').checked = pack.is_optional === 1;

  document.getElementById('modal-edit-rp').classList.remove('hidden');
}

function setupResourcePacksControls() {
  const searchInput = document.getElementById('search-local-rps');
  searchInput?.addEventListener('input', (e) => {
    const q = e.target.value.toLowerCase().trim();
    if (!q) {
      renderResourcePacksTable(currentResourcePacks);
      return;
    }
    const filtered = currentResourcePacks.filter(p => 
      (p.name && p.name.toLowerCase().includes(q)) || 
      (p.filename && p.filename.toLowerCase().includes(q)) ||
      (p.group_name && p.group_name.toLowerCase().includes(q))
    );
    renderResourcePacksTable(filtered);
  });

  // Загрузка .ZIP модалка
  const btnOpenUpload = document.getElementById('btn-open-upload-rp');
  const modalUpload = document.getElementById('modal-upload-rp');
  const formUpload = document.getElementById('form-upload-rp');
  const btnCloseUpload = document.getElementById('btn-close-upload-rp');
  const btnCancelUpload = document.getElementById('btn-cancel-upload-rp');

  btnOpenUpload?.addEventListener('click', () => modalUpload?.classList.remove('hidden'));
  btnCloseUpload?.addEventListener('click', () => modalUpload?.classList.add('hidden'));
  btnCancelUpload?.addEventListener('click', () => modalUpload?.classList.add('hidden'));

  formUpload?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fileInput = document.getElementById('input-rp-file');
    const file = fileInput.files[0];
    if (!file) return;

    const name = document.getElementById('input-rp-name').value.trim() || file.name.replace(/\.zip$/i, '');
    const group = document.getElementById('input-rp-group').value.trim() || 'Текстуры';
    const rawUsers = document.getElementById('input-rp-users').value.trim();
    const icon = document.getElementById('input-rp-icon').value.trim();
    const desc = document.getElementById('input-rp-desc').value.trim();
    const isOpt = document.getElementById('input-rp-optional').checked;

    let usersPayload = 'ALL';
    if (rawUsers && rawUsers.toUpperCase() !== 'ALL') {
      usersPayload = rawUsers.split(',').map(u => u.trim()).filter(Boolean);
    }

    const reader = new FileReader();
    reader.onload = async () => {
      const base64Data = reader.result.split(',')[1];
      try {
        const res = await fetch(`${API_BASE}/api/v1/admin/resourcepacks/upload`, {
          method: 'POST',
          headers: getAuthHeaders(),
          body: JSON.stringify({
            serverId: state.currentServerId,
            filename: file.name,
            base64Data,
            name,
            description: desc,
            isOptional: isOpt,
            isRequired: !isOpt,
            groupName: group,
            allowedUsers: usersPayload,
            iconUrl: icon
          })
        });

        if (res.ok) {
          modalUpload?.classList.add('hidden');
          formUpload.reset();
          loadResourcePacks();
        } else {
          const errData = await res.json();
          alert(errData.error || 'Ошибка загрузки ресурспака');
        }
      } catch (err) {
        alert('Ошибка отправки: ' + err.message);
      }
    };
    reader.readAsDataURL(file);
  });

  // Редактирование ресурспака
  const modalEditRp = document.getElementById('modal-edit-rp');
  const formEditRp = document.getElementById('form-edit-rp');
  const btnCloseEditRp = document.getElementById('btn-close-edit-rp');
  const btnCancelEditRp = document.getElementById('btn-cancel-edit-rp');

  btnCloseEditRp?.addEventListener('click', () => modalEditRp?.classList.add('hidden'));
  btnCancelEditRp?.addEventListener('click', () => modalEditRp?.classList.add('hidden'));

  formEditRp?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = document.getElementById('edit-rp-id').value;
    const name = document.getElementById('edit-rp-name').value.trim();
    const group = document.getElementById('edit-rp-group').value.trim() || 'Текстуры';
    const rawUsers = document.getElementById('edit-rp-users').value.trim();
    const icon = document.getElementById('edit-rp-icon').value.trim();
    const desc = document.getElementById('edit-rp-desc').value.trim();
    const isOpt = document.getElementById('edit-rp-optional').checked;

    let usersPayload = 'ALL';
    if (rawUsers && rawUsers.toUpperCase() !== 'ALL') {
      usersPayload = rawUsers.split(',').map(u => u.trim()).filter(Boolean);
    }

    try {
      const res = await fetch(`${API_BASE}/api/v1/admin/resourcepacks/${id}/details`, {
        method: 'PATCH',
        headers: getAuthHeaders(),
        body: JSON.stringify({
          name,
          description: desc,
          group_name: group,
          allowed_users: usersPayload,
          icon_url: icon,
          is_optional: isOpt,
          is_required: !isOpt
        })
      });

      if (res.ok) {
        modalEditRp?.classList.add('hidden');
        loadResourcePacks();
      } else {
        const err = await res.json();
        alert(err.error || 'Ошибка обновления ресурспака');
      }
    } catch (err) {
      alert('Ошибка соединения: ' + err.message);
    }
  });

  // Modrinth ресурспаки
  const btnOpenModrinthRp = document.getElementById('btn-open-modrinth-rp');
  const modalModrinthRp = document.getElementById('modal-modrinth-rp');
  const btnCloseModrinthRp = document.getElementById('btn-close-modrinth-rp');
  const btnSearchRp = document.getElementById('btn-search-modrinth-rp');
  const rpQueryInput = document.getElementById('modrinth-rp-query');

  btnOpenModrinthRp?.addEventListener('click', () => modalModrinthRp?.classList.remove('hidden'));
  btnCloseModrinthRp?.addEventListener('click', () => modalModrinthRp?.classList.add('hidden'));

  const doSearchRp = async () => {
    const q = rpQueryInput?.value.trim() || '';
    const container = document.getElementById('modrinth-rp-results-container');
    if (!container) return;
    container.innerHTML = '<div class="spinner" style="margin: 30px auto;"></div>';

    try {
      const res = await fetch(`${API_BASE}/api/v1/admin/modrinth/search?q=${encodeURIComponent(q)}&projectType=resourcepack`, {
        headers: getAuthHeaders()
      });
      const data = await res.json();
      const hits = data.hits || [];

      if (hits.length === 0) {
        container.innerHTML = '<div class="empty-state">Ресурспаки не найдены</div>';
        return;
      }

      container.innerHTML = '';
      hits.forEach(item => {
        const card = document.createElement('div');
        card.className = 'modrinth-card glass-panel';
        const iconSrc = item.icon_url || '';

        card.innerHTML = `
          <div style="display: flex; gap: 12px; align-items: center; margin-bottom: 8px;">
            ${iconSrc ? `<img src="${iconSrc}" style="width: 44px; height: 44px; border-radius: 8px; object-fit: cover;">` : `<div style="width: 44px; height: 44px; border-radius: 8px; background: rgba(59,130,246,0.1); color: #60a5fa; font-size: 22px; display: flex; align-items: center; justify-content: center;">🎨</div>`}
            <div>
              <h4 style="color: #fff; font-size: 15px; margin: 0;">${item.title}</h4>
              <span style="font-size: 11px; color: var(--text-muted);">${item.author} • ${(item.downloads || 0).toLocaleString()} скачиваний</span>
            </div>
          </div>
          <p style="font-size: 12px; color: #94a3b8; line-height: 1.4; margin-bottom: 12px; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;">${item.description || ''}</p>
          <button class="btn-primary btn-sm btn-install-modrinth-rp" data-project-id="${item.project_id}" style="width: 100%; background: linear-gradient(135deg, #10b981, #059669);">➕ Установить в сборку</button>
        `;

        card.querySelector('.btn-install-modrinth-rp').addEventListener('click', async (e) => {
          const btn = e.currentTarget;
          const pId = btn.dataset.projectId;
          btn.disabled = true;
          btn.textContent = '⏳ Получение версий...';

          try {
            const vRes = await fetch(`${API_BASE}/api/v1/admin/modrinth/versions?projectId=${pId}&projectType=resourcepack`, {
              headers: getAuthHeaders()
            });
            const versions = await vRes.json();
            if (!versions || versions.length === 0) {
              alert('Не найдено версий ресурспака для Minecraft 1.21.1');
              btn.disabled = false;
              btn.textContent = '➕ Установить в сборку';
              return;
            }

            const latestVer = versions[0];
            btn.textContent = '📥 Установка...';

            const addRes = await fetch(`${API_BASE}/api/v1/admin/resourcepacks/add-modrinth`, {
              method: 'POST',
              headers: getAuthHeaders(),
              body: JSON.stringify({
                serverId: state.currentServerId,
                projectId: pId,
                versionId: latestVer.id,
                isOptional: true,
                groupName: 'Текстуры и Анимации'
              })
            });

            if (addRes.ok) {
              btn.textContent = '✅ Установлено!';
              modalModrinthRp?.classList.add('hidden');
              loadResourcePacks();
            } else {
              const err = await addRes.json();
              alert(err.error || 'Ошибка установки ресурспака');
              btn.disabled = false;
              btn.textContent = '➕ Установить в сборку';
            }
          } catch (verErr) {
            alert('Ошибка: ' + verErr.message);
            btn.disabled = false;
            btn.textContent = '➕ Установить в сборку';
          }
        });

        container.appendChild(card);
      });
    } catch (err) {
      container.innerHTML = '<div class="empty-state">Ошибка поиска: ' + err.message + '</div>';
    }
  };

  btnSearchRp?.addEventListener('click', doSearchRp);
  rpQueryInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') doSearchRp();
  });
}

// ----------------------------------------------------
// 16. КЛИЕНТСКИЕ СЕРВЕРЫ (SERVERS.DAT)
// ----------------------------------------------------
let currentClientServers = [];

async function loadClientServers() {
  try {
    syncServerDropdownValues();
    const res = await fetch(`${API_BASE}/api/v1/admin/client-servers?serverId=${state.currentServerId}`, {
      headers: getAuthHeaders()
    });
    const data = await res.json();
    currentClientServers = data.servers || [];
    renderClientServersTable(currentClientServers);
  } catch (err) {
    console.error('Ошибка загрузки клиентских серверов:', err);
  }
}

function renderClientServersTable(servers) {
  const tbody = document.getElementById('client-servers-table-body');
  if (!tbody) return;
  tbody.innerHTML = '';

  if (servers.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" style="text-align: center; color: var(--text-muted); padding: 30px;">Нет настроенных серверов для servers.dat. Нажмите «Добавить сервер».</td></tr>';
    return;
  }

  servers.forEach((s, idx) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><strong style="color: #fff;">${s.name}</strong></td>
      <td><code style="color: #38bdf8; font-size: 13px;">${s.address}</code></td>
      <td>
        <span class="tag-badge ${s.is_active ? 'optional' : 'required'}" style="${s.is_active ? 'background:rgba(34,197,94,0.15);color:#4ade80;' : ''}">
          ${s.is_active ? 'Включен в servers.dat' : 'Отключен'}
        </span>
      </td>
      <td>${s.sort_order || (idx + 1)}</td>
      <td>
        <button class="btn-icon btn-edit-cs" data-id="${s.id}" title="Редактировать" style="background: rgba(59, 130, 246, 0.2); color: #60a5fa; margin-right: 4px;">✏️</button>
        <button class="btn-icon btn-delete-cs" data-id="${s.id}" title="Удалить">🗑️</button>
      </td>
    `;
    tbody.appendChild(tr);
  });

  document.querySelectorAll('.btn-edit-cs').forEach(b => {
    b.addEventListener('click', (e) => {
      const id = parseInt(e.currentTarget.dataset.id, 10);
      const server = currentClientServers.find(s => s.id === id);
      if (!server) return;

      document.getElementById('client-server-id').value = server.id;
      document.getElementById('cs-name').value = server.name;
      document.getElementById('cs-address').value = server.address;
      document.getElementById('cs-active').checked = server.is_active === 1;
      document.getElementById('client-server-modal-title').textContent = '✏️ Редактировать сервер servers.dat';
      document.getElementById('modal-client-server').classList.remove('hidden');
    });
  });

  document.querySelectorAll('.btn-delete-cs').forEach(b => {
    b.addEventListener('click', async (e) => {
      const id = e.currentTarget.dataset.id;
      if (confirm('Удалить этот сервер из списка servers.dat?')) {
        await fetch(`${API_BASE}/api/v1/admin/client-servers/${id}`, {
          method: 'DELETE',
          headers: getAuthHeaders()
        });
        loadClientServers();
      }
    });
  });
}

function setupClientServersControls() {
  const modal = document.getElementById('modal-client-server');
  const form = document.getElementById('form-client-server');
  const btnOpen = document.getElementById('btn-open-add-client-server');
  const btnClose = document.getElementById('btn-close-client-server');
  const btnCancel = document.getElementById('btn-cancel-client-server');

  btnOpen?.addEventListener('click', () => {
    document.getElementById('client-server-id').value = '';
    form.reset();
    document.getElementById('cs-active').checked = true;
    document.getElementById('client-server-modal-title').textContent = '➕ Добавить сервер в servers.dat';
    modal?.classList.remove('hidden');
  });

  const closeModal = () => modal?.classList.add('hidden');
  btnClose?.addEventListener('click', closeModal);
  btnCancel?.addEventListener('click', closeModal);

  form?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = document.getElementById('client-server-id').value;
    const name = document.getElementById('cs-name').value.trim();
    const address = document.getElementById('cs-address').value.trim();
    const isActive = document.getElementById('cs-active').checked;

    try {
      let res;
      if (id) {
        res = await fetch(`${API_BASE}/api/v1/admin/client-servers/${id}`, {
          method: 'PUT',
          headers: getAuthHeaders(),
          body: JSON.stringify({ name, address, is_active: isActive })
        });
      } else {
        res = await fetch(`${API_BASE}/api/v1/admin/client-servers`, {
          method: 'POST',
          headers: getAuthHeaders(),
          body: JSON.stringify({ server_id: state.currentServerId, name, address, is_active: isActive })
        });
      }

      if (res.ok) {
        closeModal();
        loadClientServers();
      } else {
        const err = await res.json();
        alert(err.error || 'Ошибка сохранения сервера');
      }
    } catch (err) {
      alert('Ошибка соединения: ' + err.message);
    }
  });
}
