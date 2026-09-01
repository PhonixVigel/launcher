// VozduCraft Web Admin Panel Controller
const API_BASE = window.location.origin;

const state = {
  token: localStorage.getItem('vozducraft_admin_token') || '',
  adminUser: localStorage.getItem('vozducraft_admin_user') || 'VozduHAN',
  servers: [],
  currentServerId: 1,
  currentModpack: [],
  bans: [],
  releases: [],
  stats: {}
};

// ----------------------------------------------------
// 1. ИНИЦИАЛИЗАЦИЯ И НАВИГАЦИЯ
// ----------------------------------------------------
document.addEventListener('DOMContentLoaded', () => {
  setupNavigation();
  setupAuth();
  setupServerControls();
  setupModpackControls();
  setupCopyModsModal();
  setupModrinthControls();
  setupReleasesControls();
  setupBansControls();
  setupMirrorsControls();
  setupDiscordBotTab();
  setupBypassesControls();
  setupDebugLogsControls();
  setupCrashReportsControls();
  setupLogViewerModal();
  setupChangePasswordModal();
  startClock();

  if (state.token) {
    showScreen('screen-admin');
    loadDashboardData();
  } else {
    showScreen('screen-auth');
  }
});

function showScreen(screenId) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const target = document.getElementById(screenId);
  if (target) target.classList.add('active');
}

function startClock() {
  const clockEl = document.getElementById('server-time-display');
  setInterval(() => {
    if (clockEl) {
      const now = new Date();
      clockEl.textContent = now.toLocaleTimeString('ru-RU');
    }
  }, 1000);
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
      if (btn.dataset.tab === 'releases') loadReleases();
      if (btn.dataset.tab === 'bans') loadBans();
      if (btn.dataset.tab === 'mirrors') loadMirrors();
      if (btn.dataset.tab === 'discord') loadDiscordBotStatus();
      if (btn.dataset.tab === 'bypasses') loadBypasses();
      if (btn.dataset.tab === 'debug-logs') loadDebugLogs();
      if (btn.dataset.tab === 'crash-reports') loadCrashReports();
      if (btn.dataset.tab === 'analytics') loadAnalytics();
    });
  });

  const logoutBtn = document.getElementById('btn-logout');
  if (logoutBtn) {
    logoutBtn.addEventListener('click', () => {
      localStorage.removeItem('vozducraft_admin_token');
      localStorage.removeItem('vozducraft_admin_user');
      state.token = '';
      showScreen('screen-auth');
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

    alertEl.className = 'auth-alert hidden';

    try {
      const res = await fetch(`${API_BASE}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username,
          password,
          hwid: 'WEB-ADMIN-CONSOLE'
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
        alertEl.className = 'auth-alert error';
        alertEl.textContent = data.error || 'Неверный логин или пароль администратора';
      }
    } catch (err) {
      alertEl.className = 'auth-alert error';
      alertEl.textContent = 'Ошибка подключения к серверу авторизации';
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
  const selects = [
    document.getElementById('select-modpack-server'),
    document.getElementById('select-modrinth-server')
  ];

  selects.forEach(sel => {
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
      updateCurrentServerBadge();
      loadModpack();
    };
  });

  updateCurrentServerBadge();
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
function setupModpackControls() {
  const dropzone = document.getElementById('mod-dropzone');
  const fileInput = document.getElementById('file-input-mod');
  const browseBtn = document.getElementById('btn-browse-files');
  const searchInput = document.getElementById('search-local-mods');

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
}

async function loadModpack() {
  try {
    const res = await fetch(`${API_BASE}/api/v1/admin/modpack?serverId=${state.currentServerId}`, {
      headers: getAuthHeaders()
    });
    const data = await res.json();
    state.currentModpack = data.files || [];
    renderModpackTable(state.currentModpack);
  } catch (err) {
    console.error('Ошибка загрузки модов:', err);
  }
}

function renderModpackTable(files) {
  const tbody = document.getElementById('modpack-table-body');
  const badge = document.getElementById('mods-count-badge');
  if (!tbody) return;

  if (badge) badge.textContent = `Всего модов: ${files.length}`;
  tbody.innerHTML = '';

  if (files.length === 0) {
    tbody.innerHTML = '<tr><td colspan="4" style="text-align: center; color: var(--text-muted); padding: 30px;">В сборке этого сервера пока нет модов. Перетащите файлы сюда или добавьте из Modrinth.</td></tr>';
    return;
  }

  files.forEach(file => {
    const tr = document.createElement('tr');
    const sizeMb = (file.size_bytes / (1024 * 1024)).toFixed(2);
    tr.innerHTML = `
      <td>
        <div class="mod-title-cell">${file.mod_name || file.filepath}</div>
        <div class="mod-path-sub">${file.filepath}</div>
      </td>
      <td>${sizeMb} MB</td>
      <td>
        <span class="tag-badge ${file.is_optional ? 'optional' : 'required'}">
          ${file.is_optional ? 'Опциональный' : 'Обязательный'}
        </span>
      </td>
      <td>
        <button class="btn-icon btn-toggle-opt" data-id="${file.id}" title="Переключить тип">${file.is_optional ? '🔒 Сделать обязательным' : '⚙️ Сделать опциональным'}</button>
        <button class="btn-icon btn-delete-mod" data-id="${file.id}" title="Удалить из сборки">🗑️</button>
      </td>
    `;
    tbody.appendChild(tr);
  });

  document.querySelectorAll('.btn-toggle-opt').forEach(b => {
    b.addEventListener('click', async (e) => {
      const id = e.target.dataset.id;
      await fetch(`${API_BASE}/api/v1/admin/modpack/${id}/toggle-optional`, {
        method: 'PATCH',
        headers: getAuthHeaders()
      });
      loadModpack();
    });
  });

  document.querySelectorAll('.btn-delete-mod').forEach(b => {
    b.addEventListener('click', async (e) => {
      const id = e.target.dataset.id;
      if (confirm('Удалить этот мод из сборки сервера?')) {
        await fetch(`${API_BASE}/api/v1/admin/modpack/${id}`, {
          method: 'DELETE',
          headers: getAuthHeaders()
        });
        loadModpack();
      }
    });
  });
}

function filterLocalMods(query) {
  if (!query) {
    renderModpackTable(state.currentModpack);
    return;
  }
  const filtered = state.currentModpack.filter(f => 
    (f.mod_name && f.mod_name.toLowerCase().includes(query)) ||
    (f.filepath && f.filepath.toLowerCase().includes(query))
  );
  renderModpackTable(filtered);
}

async function handleFilesUpload(files) {
  if (!files || files.length === 0) return;

  const dropzone = document.getElementById('mod-dropzone');
  const oldText = dropzone.querySelector('.dropzone-text').innerHTML;
  dropzone.querySelector('.dropzone-text').innerHTML = '⏳ Загрузка и подсчет SHA-256 хешей...';

  for (const file of Array.from(files)) {
    if (!file.name.endsWith('.jar') && !file.name.endsWith('.zip')) continue;

    try {
      const base64Data = await readFileAsBase64(file);
      await fetch(`${API_BASE}/api/v1/admin/modpack/upload`, {
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
    } catch (err) {
      console.error('Ошибка загрузки файла:', file.name, err);
    }
  }

  dropzone.querySelector('.dropzone-text').innerHTML = oldText;
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
