// VozduCraft Client Engine v8.0 (Failover Mirrors, Window Drag, Screenshots Lightbox, Custom JVM & Carousel)
const DEFAULT_PRIMARY_MIRROR = 'http://185.221.213.43:3000/api/v1';

let KNOWN_MIRRORS = [DEFAULT_PRIMARY_MIRROR];

let CURRENT_API_BASE = DEFAULT_PRIMARY_MIRROR;
const savedMirror = localStorage.getItem('vozducraft_active_mirror');
if (savedMirror && !savedMirror.includes('localhost') && !savedMirror.includes('89.248.236.145')) {
  CURRENT_API_BASE = savedMirror;
} else {
  CURRENT_API_BASE = DEFAULT_PRIMARY_MIRROR;
  localStorage.setItem('vozducraft_active_mirror', DEFAULT_PRIMARY_MIRROR);
}

let ipcRenderer = null;
if (window.require) {
  try {
    ipcRenderer = window.require('electron').ipcRenderer;
  } catch (e) {}
}

const appState = {
  token: localStorage.getItem('vozducraft_token') || null,
  username: localStorage.getItem('vozducraft_username') || null,
  sessionExpiry: parseInt(localStorage.getItem('vozducraft_session_expiry'), 10) || 0,
  ramGb: parseInt(localStorage.getItem('vozducraft_ram')) || 6,
  disableJvmFlags: localStorage.getItem('vozducraft_disable_jvm') === 'true',
  playerCustomJvm: localStorage.getItem('vozducraft_player_custom_jvm') || '',
  enableDiscordRpc: localStorage.getItem('vozducraft_rpc') !== 'false',
  customBg: localStorage.getItem('vozducraft_custom_bg') || '',
  optionalMods: [],
  selectedOptionalMods: JSON.parse(localStorage.getItem('vozducraft_selected_opt_mods') || '[]'),
  servers: [],
  currentServerIndex: 0
};

let isGameLaunching = false;
let activeLaunchingServerId = null;
let currentScreenshots = [];
let currentLightboxIndex = 0;

// ----------------------------------------------------
// 0. ОТКАЗОУСТОЙЧИВЫЙ FETCH С ЗЕРКАЛАМИ (FAILOVER)
// ----------------------------------------------------
async function apiFetch(endpoint, options = {}) {
  const tryMirrors = [CURRENT_API_BASE, ...KNOWN_MIRRORS.filter(m => m !== CURRENT_API_BASE)];
  
  let lastNetworkError = null;
  for (const mirrorUrl of tryMirrors) {
    try {
      const fullUrl = `${mirrorUrl}${endpoint}`;
      let data = null;
      let networkFailed = false;

      // Если лаунчер запущен в нативном C++/WebKit приложении, используем прямой libcurl
      if (window.nativeApiFetch) {
        const payload = JSON.stringify({
          url: fullUrl,
          method: options.method || 'GET',
          headers: options.headers || { 'Content-Type': 'application/json' },
          body: typeof options.body === 'string' ? options.body : (options.body ? JSON.stringify(options.body) : '')
        });
        const resData = await window.nativeApiFetch(payload);
        data = (typeof resData === 'string') ? JSON.parse(resData) : resData;
        
        if (data && data.__curl_error) {
          networkFailed = true;
          lastNetworkError = new Error(data.__curl_error);
        }
      } else {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 4000);
        const res = await fetch(fullUrl, { ...options, signal: controller.signal });
        clearTimeout(timeoutId);

        data = await res.json().catch(() => ({}));
      }

      if (!networkFailed && data) {
        if (CURRENT_API_BASE !== mirrorUrl) {
          CURRENT_API_BASE = mirrorUrl;
          localStorage.setItem('vozducraft_active_mirror', CURRENT_API_BASE);
          console.log(`[FAILOVER] Переключено на активное зеркало: ${CURRENT_API_BASE}`);
        }
        if (data.mirrors && Array.isArray(data.mirrors)) {
          updateKnownMirrors(data.mirrors);
        }
        return data;
      }
    } catch (e) {
      lastNetworkError = e;
      console.warn(`[FAILOVER] Узел ${mirrorUrl} недоступен, пробуем следующее зеркало...`, e);
    }
  }

  throw new Error('Все зеркала API недоступны: ' + (lastNetworkError ? lastNetworkError.message : 'Сбой сети'));
}

function updateKnownMirrors(mirrorsList) {
  const urls = mirrorsList.map(m => m.url).filter(u => u && !u.includes('localhost'));
  KNOWN_MIRRORS = Array.from(new Set([...urls, ...KNOWN_MIRRORS]));
  localStorage.setItem('vozducraft_known_mirrors', JSON.stringify(KNOWN_MIRRORS));

  const primary = mirrorsList.find(m => m.is_primary);
  if (primary && primary.url && !primary.url.includes('localhost') && primary.url !== CURRENT_API_BASE) {
    CURRENT_API_BASE = primary.url;
    localStorage.setItem('vozducraft_active_mirror', CURRENT_API_BASE);
    console.log(`[MIGRATION] Получен новый мастер-узел проекта: ${CURRENT_API_BASE}`);
  }
}

// ----------------------------------------------------
// 0. СКРЫТАЯ ТЕЛЕМЕТРИЯ И ДЕБАГ (Отправка на мастер-сервер)
// ----------------------------------------------------
async function sendTelemetry(eventType, message, details = {}) {
  try {
    const username = (typeof appState !== 'undefined' && appState.username) ? appState.username : (localStorage.getItem('vozducraft_username') || localStorage.getItem('vozducraft_last_user') || 'Anonymous');
    const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
    const isWin = navigator.platform.toUpperCase().indexOf('WIN') >= 0;
    const os = isMac ? 'macOS' : (isWin ? 'Windows' : 'Linux');
    
    const payload = {
      username: username,
      os: os,
      launcher_version: typeof LAUNCHER_CURRENT_VERSION !== 'undefined' ? LAUNCHER_CURRENT_VERSION : '3.0.2',
      event_type: eventType,
      log_content: `[${new Date().toISOString()}] [${eventType}] ${message}\n` + 
                   `Player: ${username} | OS: ${os} | Launcher: v${typeof LAUNCHER_CURRENT_VERSION !== 'undefined' ? LAUNCHER_CURRENT_VERSION : '3.0.2'}\n` +
                   (Object.keys(details).length ? `Details:\n${JSON.stringify(details, null, 2)}\n` : '')
    };

    const targetUrl = `${CURRENT_API_BASE}/launcher/debug-log`;

    if (window.nativeApiFetch) {
      window.nativeApiFetch(JSON.stringify({
        url: targetUrl,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      }));
    } else {
      fetch(targetUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      }).catch(() => {});
    }
  } catch (_) {}
}

// ----------------------------------------------------
// 1. ГЛОБАЛЬНЫЕ КОЛБЭКИ C++ ДВИЖКА
// ----------------------------------------------------
window.__VOZDUCRAFT_ON_STATUS = function(percent, text) {
  const progressContainer = document.getElementById('progress-container');
  const fill = document.getElementById('progress-fill');
  const percentText = document.getElementById('progress-percent');
  const statusText = document.getElementById('progress-text');

  if (progressContainer) progressContainer.classList.remove('hidden');
  if (fill) fill.style.width = percent + '%';
  if (percentText) percentText.textContent = percent + '%';
  if (statusText) statusText.textContent = text;

  if (percent >= 100) {
    updateLaunchButtonState(true);
  }
};

window.__VOZDUCRAFT_ON_GAME_CLOSED = function(exitCode) {
  console.log('[GAME CLOSED] Exit code:', exitCode);
  const lastServer = activeLaunchingServerId;
  isGameLaunching = false;
  activeLaunchingServerId = null;

  sendTelemetry(
    exitCode === 0 ? 'GAME_EXIT' : 'CRASH',
    exitCode === 0 ? 'Игра завершилась штатно' : `Игра завершилась с кодом ошибки: ${exitCode}`,
    { exitCode, serverId: lastServer }
  );

  const progressContainer = document.getElementById('progress-container');
  if (progressContainer) progressContainer.classList.add('hidden');

  updateLaunchButtonState(false);
};

window.__VOZDUCRAFT_ON_LOG = function(logLine) {
  console.log('[NATIVE LOG]', logLine);
};

function updateLaunchButtonState(isRunning) {
  document.querySelectorAll('.btn-launch-server').forEach(btn => {
    const sId = parseInt(btn.dataset.serverId, 10);
    if (isRunning && sId === activeLaunchingServerId) {
      btn.disabled = true;
      btn.style.opacity = '0.85';
      btn.style.background = 'linear-gradient(135deg, #10b981, #059669)';
      btn.style.boxShadow = '0 8px 30px rgba(16, 185, 129, 0.4)';
      btn.innerHTML = '<span class="launch-icon">🎮</span><span class="launch-text">ИГРА ЗАПУЩЕНА</span>';
    } else {
      btn.disabled = isRunning;
      btn.style.opacity = isRunning ? '0.5' : '1';
      btn.style.background = '';
      btn.style.boxShadow = '';
      btn.innerHTML = '<span class="launch-icon">🌪️</span><span class="launch-text">Испортить атмосферу VozduCraft</span><span class="launch-icon">🌪️</span>';
    }
  });
}

function showToast(msg) {
  const existing = document.getElementById('app-toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.id = 'app-toast';
  toast.style.cssText = `
    position: fixed;
    bottom: 24px;
    right: 24px;
    background: rgba(18, 22, 36, 0.95);
    color: #fff;
    border: 1px solid #fb923c;
    box-shadow: 0 10px 30px rgba(0,0,0,0.6);
    padding: 12px 20px;
    border-radius: 8px;
    font-size: 14px;
    font-weight: 600;
    z-index: 9999;
    backdrop-filter: blur(10px);
    transition: opacity 0.3s ease;
  `;
  toast.textContent = msg;
  document.body.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    setTimeout(() => toast.remove(), 300);
  }, 2500);
}

// ----------------------------------------------------
// 2. ИНИЦИАЛИЗАЦИЯ ПРИЛОЖЕНИЯ
// ----------------------------------------------------
const LAUNCHER_CURRENT_VERSION = '3.2.8';

document.addEventListener('DOMContentLoaded', () => {
  initCustomBackground();
  setupWindowControls();
  setupGlobalShortcuts();
  setupNavigation();
  setupAuthEvents();
  setupSettingsEvents();
  setupQuickFoldersDropdown();
  setupDownloadListener();
  setupLightboxEvents();
  loadServerCarousel();
  checkForLauncherUpdates();

  setInterval(() => {
    if (appState.servers.length > 0) {
      appState.servers.forEach(s => pingServerCard(s));
    }
  }, 5000);

  if (appState.token && appState.username && appState.sessionExpiry && Date.now() < appState.sessionExpiry) {
    showDashboard();
  } else {
    localStorage.removeItem('vozducraft_token');
    localStorage.removeItem('vozducraft_session_expiry');
    appState.token = null;
    showAuth();
  }
});

// Проверка и показ окна обновления лаунчера
async function checkForLauncherUpdates() {
  try {
    const data = await apiFetch('/launcher/check-update');
    if (!data || !data.latestVersion) return;

    if (data.latestVersion !== LAUNCHER_CURRENT_VERSION && isNewerVersion(data.latestVersion, LAUNCHER_CURRENT_VERSION)) {
      showUpdateModal(data);
    }
  } catch (err) {
    console.warn('Update check failed:', err);
  }
}

function isNewerVersion(remote, local) {
  const r = remote.split('.').map(n => parseInt(n, 10) || 0);
  const l = local.split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(r.length, l.length); i++) {
    const rv = r[i] || 0;
    const lv = l[i] || 0;
    if (rv > lv) return true;
    if (rv < lv) return false;
  }
  return false;
}

function showUpdateModal(data) {
  const modal = document.getElementById('modal-update-launcher');
  const badge = document.getElementById('update-version-badge');
  const notes = document.getElementById('update-release-notes');
  const btnDownload = document.getElementById('btn-download-update');
  const btnClose = document.getElementById('btn-close-update-modal');
  const buttonsZone = document.getElementById('update-buttons-zone');
  const progressZone = document.getElementById('update-progress-zone');
  const progressBar = document.getElementById('update-progress-bar');
  const percentText = document.getElementById('update-percent-text');
  const statusText = document.getElementById('update-status-text');
  const detailsText = document.getElementById('update-details-text');

  if (!modal) return;

  if (badge) badge.textContent = `Новая версия: v${data.latestVersion} (текущая: v${LAUNCHER_CURRENT_VERSION})`;
  if (notes) notes.textContent = data.releaseNotes || 'Улучшена стабильность и добавлены обновления безопасности.';

  const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
  const downloadUrl = isMac ? (data.macDownloadUrl || data.downloadUrl) : data.downloadUrl;

  if (btnDownload) {
    btnDownload.onclick = (e) => {
      e.preventDefault();
      
      // Переключаем в режим прогресса
      if (buttonsZone) buttonsZone.classList.add('hidden');
      if (progressZone) progressZone.classList.remove('hidden');
      if (statusText) statusText.textContent = 'Скачивание обновления...';

      const logDebug = (msg) => {
        console.log('[UpdaterDebug]', msg);
        if (detailsText) detailsText.textContent = msg;
        if (window.nativeLog) {
          try { window.nativeLog('[UpdaterDebug] ' + (typeof msg === 'object' ? JSON.stringify(msg) : String(msg))); } catch (_) {}
        }
      };

      logDebug(`[1/3] URL: ${downloadUrl}`);
      sendTelemetry('UPDATE_CLICK', 'Игрок нажал кнопку обновления', {
        downloadUrl,
        hasNativeAutoUpdate: typeof window.nativeAutoUpdateLauncher === 'function',
        hasNativeOpenUrl: typeof window.nativeOpenUrl === 'function'
      });

      // Обработчик живого прогресса от нативного движка
      window.onLauncherUpdateProgress = (pct, mbNow, mbTotal) => {
        if (progressBar) progressBar.style.width = `${pct}%`;
        if (percentText) percentText.textContent = `${pct}%`;
        logDebug(`[Загрузка] ${pct}% (${mbNow.toFixed(1)} / ${mbTotal.toFixed(1)} МБ)`);
      };

      // Обработчик завершения
      window.onLauncherUpdateComplete = () => {
        if (progressBar) progressBar.style.width = '100%';
        if (percentText) percentText.textContent = '100%';
        if (statusText) statusText.textContent = '✅ Запуск новой версии...';
        logDebug('✅ Установка завершена, открываем установщик...');
      };

      // Обработчик ошибки
      window.onLauncherUpdateError = (errMsg) => {
        if (statusText) statusText.textContent = '❌ Ошибка загрузки';
        logDebug(`Ошибка: ${errMsg}. Открываем системный загрузчик...`);
        if (window.nativeOpenUrl) {
          window.nativeOpenUrl(downloadUrl);
        } else {
          window.open(downloadUrl, '_blank');
        }
      };

      const currentNick = (typeof appState !== 'undefined' && appState.username) ? appState.username : (localStorage.getItem('vozducraft_username') || 'Anonymous');

      sendTelemetry('UPDATE_CLICK', 'Игрок нажал кнопку обновления', {
        downloadUrl,
        hasNativeAutoUpdate: typeof window.nativeAutoUpdateLauncher === 'function',
        hasElectron: !!window.require
      });

      // 1. Для нативного C++ macOS движка
      if (typeof window.nativeAutoUpdateLauncher === 'function') {
        logDebug('[2/2] Запуск нативного C++ загрузчика...');
        try {
          window.nativeAutoUpdateLauncher(JSON.stringify({ url: downloadUrl, username: currentNick }));
        } catch (err) {
          logDebug(`Ошибка нативного загрузчика: ${err.message}. Открываем в браузере...`);
          if (window.nativeOpenUrl) window.nativeOpenUrl(downloadUrl);
          else window.open(downloadUrl, '_blank');
        }
      } 
      // 2. Для Electron на Windows / macOS (Скоростной микро-патч ASAR 4.4 МБ)
      else if (window.require) {
        try {
          const electron = window.require('electron');
          const asarUrl = data.asarDownloadUrl || data.patchUrl || 'http://185.221.213.43:3000/files/launchers/app.asar';

          logDebug(`⚡ Запуск микро-обновления лаунчера (размер ~4 МБ): ${asarUrl}`);
          if (statusText) statusText.textContent = '⚡ Скачивание микро-обновления (~4 МБ)...';

          electron.ipcRenderer.on('update-progress', (evt, prog) => {
            const pct = prog.percent || 0;
            const mbNow = ((prog.downloaded || 0) / (1024 * 1024)).toFixed(1);
            const mbTotal = ((prog.total || 0) / (1024 * 1024)).toFixed(1);
            if (progressBar) progressBar.style.width = `${pct}%`;
            if (percentText) percentText.textContent = `${pct}%`;
            if (detailsText) detailsText.textContent = `Скачано: ${mbNow} МБ из ${mbTotal} МБ (${pct}%)`;
          });

          electron.ipcRenderer.invoke('apply-micro-update', { asarUrl }).then(() => {
            if (progressBar) progressBar.style.width = '100%';
            if (percentText) percentText.textContent = '100%';
            if (statusText) statusText.textContent = '✅ Патч применен! Перезапуск...';
            if (detailsText) detailsText.textContent = 'Лаунчер обновлен и сейчас откроется...';
          }).catch((err) => {
            logDebug(`Микро-обновление не удалось (${err.message}). Переход на полный установщик...`);
            electron.shell.openExternal(downloadUrl);
          });
        } catch (e) {
          logDebug('Electron micro-updater error: ' + e.message);
          if (window.nativeOpenUrl) window.nativeOpenUrl(downloadUrl);
          else window.open(downloadUrl, '_blank');
        }
      } 
      // 3. Fallback браузер
      else if (typeof window.nativeOpenUrl === 'function') {
        logDebug('[2/2] Запуск загрузки через системный браузер...');
        window.nativeOpenUrl(downloadUrl);
      } else {
        logDebug('[2/2] Открытие прямой ссылки...');
        window.open(downloadUrl, '_blank');
      }
    };
  }

  if (btnClose) {
    if (data.isMandatory) {
      btnClose.style.display = 'none';
    } else {
      btnClose.style.display = 'inline-block';
      btnClose.onclick = () => modal.classList.add('hidden');
    }
  }

  const btnCancelDownload = document.getElementById('btn-cancel-update-download');
  if (btnCancelDownload) {
    btnCancelDownload.onclick = () => {
      sendTelemetry('UPDATE_CANCELLED', 'Игрок отменил загрузку обновления лаунчера', {
        currentProgress: progressBar ? progressBar.style.width : '0%',
        status: statusText ? statusText.textContent : '',
        details: detailsText ? detailsText.textContent : '',
        downloadUrl: downloadUrl,
        latestVersion: data.latestVersion
      });

      if (progressZone) progressZone.classList.add('hidden');
      if (buttonsZone) buttonsZone.classList.remove('hidden');
      if (progressBar) progressBar.style.width = '0%';
      if (percentText) percentText.textContent = '0%';
    };
  }

  modal.classList.remove('hidden');
}

// ----------------------------------------------------
// 3. ГЛОБАЛЬНЫЕ ГОРЯЧИЕ КЛАВИШИ (macOS & Windows)
// ----------------------------------------------------
function setupGlobalShortcuts() {
  window.addEventListener('keydown', (e) => {
    const isCmdOrCtrl = e.metaKey || e.ctrlKey;

    // Cmd+Q / Ctrl+Q -> Завершить работу приложения
    if (isCmdOrCtrl && e.key.toLowerCase() === 'q') {
      e.preventDefault();
      if (window.nativeCloseWindow) {
        window.nativeCloseWindow();
      } else {
        window.close();
      }
      return;
    }

    // Cmd+W / Ctrl+W -> Закрыть окно
    if (isCmdOrCtrl && e.key.toLowerCase() === 'w') {
      e.preventDefault();
      if (window.nativeCloseWindow) {
        window.nativeCloseWindow();
      }
      return;
    }

    // Cmd+M / Ctrl+M -> Свернуть окно
    if (isCmdOrCtrl && e.key.toLowerCase() === 'm') {
      e.preventDefault();
      if (window.nativeMinimizeWindow) {
        window.nativeMinimizeWindow();
      }
      return;
    }

    // Cmd+H / Ctrl+H -> Скрыть окно (Свернуть)
    if (isCmdOrCtrl && e.key.toLowerCase() === 'h') {
      e.preventDefault();
      if (window.nativeMinimizeWindow) {
        window.nativeMinimizeWindow();
      }
      return;
    }

    // Escape -> Закрыть активные модалки (если не обязательное обновление)
    if (e.key === 'Escape') {
      const updateModal = document.getElementById('modal-update-launcher');
      const isMandatory = document.getElementById('btn-close-update-modal')?.style.display === 'none';
      
      document.querySelectorAll('.modal-overlay:not(.hidden)').forEach(modal => {
        if (modal === updateModal && isMandatory) return;
        modal.classList.add('hidden');
      });
    }
  });
}

// ----------------------------------------------------
// 3. УПРАВЛЕНИЕ ОКНОМ И ПЕРЕТАСКИВАНИЕ (DRAG)
// ----------------------------------------------------
function setupWindowControls() {
  const closeBtn = document.getElementById('btn-close');
  const minBtn = document.getElementById('btn-minimize');
  const titlebar = document.getElementById('app-titlebar');

  if (titlebar) {
    titlebar.addEventListener('mousedown', (e) => {
      if (e.target.closest('.window-controls') || e.target.closest('button')) return;
      if (window.nativeDragWindow) {
        window.nativeDragWindow();
      }
    });
  }

  if (closeBtn) {
    closeBtn.addEventListener('click', () => {
      if (window.nativeCloseWindow) {
        window.nativeCloseWindow();
      } else if (ipcRenderer) {
        ipcRenderer.send('window-close');
      } else {
        window.close();
      }
    });
  }

  if (minBtn) {
    minBtn.addEventListener('click', () => {
      if (window.nativeMinimizeWindow) {
        window.nativeMinimizeWindow();
      } else if (ipcRenderer) {
        ipcRenderer.send('window-minimize');
      }
    });
  }
}

// ----------------------------------------------------
// 4. КАСТОМНЫЙ ФОН (PNG / JPG)
// ----------------------------------------------------
function initCustomBackground() {
  if (appState.customBg) {
    applyCustomBackground(appState.customBg);
  }

  const fileInput = document.getElementById('input-custom-bg');
  const btnUpload = document.getElementById('btn-upload-bg');
  const btnReset = document.getElementById('btn-reset-bg');

  if (btnUpload && fileInput) {
    btnUpload.addEventListener('click', () => fileInput.click());

    fileInput.addEventListener('change', (e) => {
      const file = e.target.files?.[0];
      if (!file) return;

      const reader = new FileReader();
      reader.onload = (event) => {
        const base64Bg = event.target.result;
        appState.customBg = base64Bg;
        localStorage.setItem('vozducraft_custom_bg', base64Bg);
        applyCustomBackground(base64Bg);
        showToast('🎨 Новый кастомный фон установлен!');
      };
      reader.readAsDataURL(file);
    });
  }

  if (btnReset) {
    btnReset.addEventListener('click', () => {
      appState.customBg = '';
      localStorage.removeItem('vozducraft_custom_bg');
      document.body.style.backgroundImage = '';
      document.body.classList.remove('has-custom-bg');
      showToast('🔄 Фоновое изображение сброшено');
    });
  }
}

function applyCustomBackground(url) {
  document.body.style.backgroundImage = `url("${url}")`;
  document.body.classList.add('has-custom-bg');
}

// ----------------------------------------------------
// 5. КАРУСЕЛЬ КАРТОЧЕК СЕРВЕРОВ
// ----------------------------------------------------
async function loadServerCarousel() {
  try {
    const data = await apiFetch('/manifest/servers');
    appState.servers = data.servers || [];

    if (appState.servers.length === 0) {
      appState.servers = [
        {
          id: 1,
          name: 'VozduCraft Season #2',
          server_ip: '89.248.236.145',
          server_port: 27123,
          minecraft_version: '1.21.1',
          modloader: 'neoforge',
          modloader_version: '21.1.248',
          java_version: 21,
          description: 'Официальный сервер выживания VozduCraft Season #2 (170+ модов)'
        },
        {
          id: 2,
          name: 'VozduCraft Tech & Create',
          server_ip: '185.221.213.43',
          server_port: 25566,
          minecraft_version: '1.21.1',
          modloader: 'neoforge',
          modloader_version: '21.1.248',
          java_version: 21,
          description: 'Индустриальный сервер с механизмами Create, авиацией и поездами'
        }
      ];
    }

    renderCarousel();
    appState.servers.forEach(s => pingServerCard(s));
  } catch (err) {
    console.error('Ошибка загрузки списка серверов:', err);
    if (!appState.servers || appState.servers.length === 0) {
      appState.servers = [
        {
          id: 1,
          name: 'VozduCraft Season #2',
          server_ip: '89.248.236.145',
          server_port: 27123,
          minecraft_version: '1.21.1',
          modloader: 'neoforge',
          modloader_version: '21.1.248',
          java_version: 21,
          description: 'Официальный сервер выживания VozduCraft Season #2 (170+ модов)'
        },
        {
          id: 2,
          name: 'VozduCraft Tech & Create',
          server_ip: '185.221.213.43',
          server_port: 25566,
          minecraft_version: '1.21.1',
          modloader: 'neoforge',
          modloader_version: '21.1.248',
          java_version: 21,
          description: 'Индустриальный сервер с механизмами Create, авиацией и поездами'
        }
      ];
      renderCarousel();
      appState.servers.forEach(s => pingServerCard(s));
    }
  }
}

function renderCarousel() {
  const container = document.getElementById('server-cards-container');
  const dotsContainer = document.getElementById('carousel-dots-container');
  const prevBtn = document.getElementById('carousel-prev-btn');
  const nextBtn = document.getElementById('carousel-next-btn');

  if (!container || !dotsContainer) return;

  container.innerHTML = '';
  dotsContainer.innerHTML = '';

  appState.servers.forEach((server, index) => {
    const card = document.createElement('div');
    card.className = 'server-carousel-card glass-panel';
    card.dataset.serverId = server.id;

    const loaderName = (server.modloader || 'NeoForge').toUpperCase();
    const loaderVer = server.modloader_version || server.neoforge_version || '21.1.248';

    card.innerHTML = `
      <div class="server-card-top">
        <div class="server-header">
          <div class="server-badge online" id="server-badge-${server.id}">
            <span class="ping-dot"></span>
            <span id="server-badge-text-${server.id}">ONLINE</span>
          </div>
          <h2 class="server-title">${server.name}</h2>
        </div>

        <div class="server-address-chip">🎯 ${server.server_ip}:${server.server_port}</div>
        <p class="server-desc">${server.description || 'Официальный игровой сервер VozduCraft'}</p>

        <div class="server-stats">
          <div class="stat-item">
            <span class="stat-label">Игроков онлайн</span>
            <span class="stat-value" id="online-count-${server.id}">0 / 100</span>
          </div>
          <div class="stat-item">
            <span class="stat-label">Пинг</span>
            <span class="stat-value" id="ping-val-${server.id}">—</span>
          </div>
          <div class="stat-item">
            <span class="stat-label">Модлоадер</span>
            <span class="stat-value">${loaderName} ${loaderVer}</span>
          </div>
          <div class="stat-item">
            <span class="stat-label">Версия MC</span>
            <span class="stat-value">${server.minecraft_version}</span>
          </div>
        </div>
      </div>

      <div class="server-card-bottom">
        <button class="btn-launch btn-launch-server" data-server-id="${server.id}">
          <span class="launch-icon">🌪️</span>
          <span class="launch-text">Испортить атмосферу VozduCraft</span>
          <span class="launch-icon">🌪️</span>
        </button>
      </div>
    `;

    container.appendChild(card);

    const dot = document.createElement('div');
    dot.className = `carousel-dot ${index === 0 ? 'active' : ''}`;
    dot.dataset.index = index;
    dot.addEventListener('click', () => scrollToServer(index));
    dotsContainer.appendChild(dot);
  });

  document.querySelectorAll('.btn-launch-server').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const sId = parseInt(btn.dataset.serverId, 10);
      const targetServer = appState.servers.find(x => x.id === sId) || appState.servers[0];
      launchSelectedServer(targetServer);
    });
  });

  if (prevBtn && nextBtn) {
    prevBtn.addEventListener('click', () => {
      if (appState.currentServerIndex > 0) {
        scrollToServer(appState.currentServerIndex - 1);
      }
    });

    nextBtn.addEventListener('click', () => {
      if (appState.currentServerIndex < appState.servers.length - 1) {
        scrollToServer(appState.currentServerIndex + 1);
      }
    });
  }

  scrollToServer(0);
}

function scrollToServer(index) {
  const container = document.getElementById('server-cards-container');
  const prevBtn = document.getElementById('carousel-prev-btn');
  const nextBtn = document.getElementById('carousel-next-btn');
  const dots = document.querySelectorAll('.carousel-dot');

  if (!container || appState.servers.length === 0) return;

  appState.currentServerIndex = Math.max(0, Math.min(index, appState.servers.length - 1));

  const cardWidth = container.clientWidth;
  container.scrollTo({
    left: appState.currentServerIndex * cardWidth,
    behavior: 'smooth'
  });

  dots.forEach((d, i) => {
    if (i === appState.currentServerIndex) d.classList.add('active');
    else d.classList.remove('active');
  });

  if (prevBtn) prevBtn.disabled = appState.currentServerIndex === 0;
  if (nextBtn) nextBtn.disabled = appState.currentServerIndex === appState.servers.length - 1;

  const activeServer = appState.servers[appState.currentServerIndex];
  if (activeServer) fetchOptionalModsFor(activeServer.id);
}

async function pingServerCard(server) {
  const badge = document.getElementById(`server-badge-${server.id}`);
  const badgeTxt = document.getElementById(`server-badge-text-${server.id}`);
  const onlineCount = document.getElementById(`online-count-${server.id}`);
  const pingVal = document.getElementById(`ping-val-${server.id}`);

  try {
    const data = await apiFetch(`/admin/servers/${server.id}/ping`);

    if (data.online) {
      if (badge) badge.className = 'server-badge online';
      if (badgeTxt) badgeTxt.textContent = 'ONLINE';
      if (onlineCount) onlineCount.textContent = `${data.players?.online || 0} / ${data.players?.max || 100}`;
      if (pingVal) pingVal.textContent = `${data.ping_ms || 24} ms`;
    } else {
      if (badge) badge.className = 'server-badge offline';
      if (badgeTxt) badgeTxt.textContent = 'OFFLINE';
      if (onlineCount) onlineCount.textContent = '0 / 0';
      if (pingVal) pingVal.textContent = '—';
    }
  } catch (err) {
    if (badge) badge.className = 'server-badge offline';
    if (onlineCount) onlineCount.textContent = '—';
    if (pingVal) pingVal.textContent = '—';
  }
}

// ----------------------------------------------------
// 6. ЗАПУСК ИГРЫ С УЧЕТОМ JVM-ФЛАГОВ
// ----------------------------------------------------
function launchSelectedServer(server) {
  if (isGameLaunching) return;
  isGameLaunching = true;
  activeLaunchingServerId = server.id;

  updateLaunchButtonState(true);

  const progressContainer = document.getElementById('progress-container');
  if (progressContainer) progressContainer.classList.remove('hidden');

  let finalJvmFlags = server.jvm_flags || '';
  if (appState.disableJvmFlags) {
    finalJvmFlags = appState.playerCustomJvm || '';
  }

  const launchPayload = {
    username: appState.username || 'VozduHAN',
    ram: Math.max(appState.ramGb || 6, server.min_ram_gb || 4),
    token: appState.token || 'LOCAL-TOKEN',
    disableJvmFlags: appState.disableJvmFlags,
    selectedOptionalMods: appState.selectedOptionalMods,
    serverId: server.id,
    serverIp: server.server_ip,
    serverPort: server.server_port,
    modloader: server.modloader || 'neoforge',
    neoForgeVersion: server.modloader_version || server.neoforge_version || '21.1.248',
    minecraftVersion: server.minecraft_version || '1.21.1',
    customJvmFlags: finalJvmFlags,
    gameArgs: server.game_args || '',
    autoJoinServer: server.auto_join_server !== undefined ? server.auto_join_server : 1,
    apiBaseUrl: CURRENT_API_BASE
  };

  // Регистрация активного билета входа на мастер-сервере VozduCraft Security
  try {
    const nick = appState.username || 'PhonixVogel';
    fetch(`${CURRENT_API_BASE}/launcher/session-ticket`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: nick })
    }).catch(() => {});
  } catch (_) {}

  if (window.nativeLaunchGame) {
    try {
      window.nativeLaunchGame(launchPayload);
    } catch (err) {
      console.error('C++ nativeLaunchGame error:', err);
    }
  } else if (ipcRenderer) {
    ipcRenderer.send('execute-launch', launchPayload);
  } else {
    window.__VOZDUCRAFT_ON_STATUS(100, 'Запуск в браузере (симуляция)');
  }
}

// ----------------------------------------------------
// 7. СКРИНШОТЫ И ПОЛНОЭКРАННЫЙ ПРОСМОТР (LIGHTBOX)
// ----------------------------------------------------
async function loadScreenshots() {
  const container = document.getElementById('screenshots-grid');
  if (!container) return;
  container.innerHTML = '<div class="gallery-empty">Загрузка скриншотов...</div>';

  try {
    let shots = [];
    if (ipcRenderer) {
      shots = await ipcRenderer.invoke('get-screenshots');
    } else if (window.nativeGetScreenshots) {
      const res = await window.nativeGetScreenshots();
      shots = typeof res === 'string' ? JSON.parse(res) : res;
    }

    currentScreenshots = Array.isArray(shots) ? shots : [];
    container.innerHTML = '';

    if (currentScreenshots.length === 0) {
      container.innerHTML = '<div class="gallery-empty" style="grid-column: 1 / -1; padding: 40px; text-align: center; color: var(--text-muted);">📷 У вас пока нет внутриигровых скриншотов.<br>Нажмите <b>F2</b> в игре, чтобы сделать снимок!</div>';
      return;
    }

    currentScreenshots.forEach((shot, index) => {
      const card = document.createElement('div');
      card.className = 'screenshot-card';
      card.innerHTML = `
        <div class="screenshot-thumb-wrap">
          <img src="${shot.data}" alt="${shot.filename}">
          <button class="btn-copy-screenshot" data-index="${index}" title="Скопировать изображение">📋 Скопировать</button>
        </div>
        <div class="screenshot-meta">
          <span class="screenshot-name">${shot.filename}</span>
        </div>
      `;

      card.addEventListener('click', (e) => {
        if (e.target.closest('.btn-copy-screenshot')) return;
        openLightbox(index);
      });

      card.querySelector('.btn-copy-screenshot').addEventListener('click', (e) => {
        e.stopPropagation();
        copyScreenshot(shot);
      });

      container.appendChild(card);
    });
  } catch (err) {
    console.error('Ошибка загрузки скриншотов:', err);
    container.innerHTML = '<div class="gallery-empty">Не удалось загрузить скриншоты</div>';
  }
}

async function copyScreenshot(shot) {
  if (ipcRenderer && shot.path) {
    try {
      const res = await ipcRenderer.invoke('copy-image-to-clipboard', shot.path);
      if (res && res.success) {
        showToast('📋 Скриншот скопирован в буфер обмена!');
        return;
      }
    } catch (_) {}
  }

  if (window.nativeCopyImageToClipboard) {
    window.nativeCopyImageToClipboard({ path: shot.path });
    showToast('📋 Скриншот скопирован в буфер обмена!');
  } else {
    navigator.clipboard.writeText(shot.filename);
    showToast('📋 Имя файла скопировано');
  }
}

function openLightbox(index) {
  currentLightboxIndex = index;
  const overlay = document.getElementById('screenshots-lightbox');
  const img = document.getElementById('lightbox-img');
  const caption = document.getElementById('lightbox-caption');

  if (!overlay || !img || !currentScreenshots[index]) return;

  img.src = currentScreenshots[index].data;
  if (caption) caption.textContent = `${currentScreenshots[index].filename} (${index + 1} из ${currentScreenshots.length})`;

  overlay.classList.remove('hidden');
}

function setupLightboxEvents() {
  const overlay = document.getElementById('screenshots-lightbox');
  const prevBtn = document.getElementById('lightbox-prev-btn');
  const nextBtn = document.getElementById('lightbox-next-btn');

  if (overlay) {
    overlay.addEventListener('click', (e) => {
      if (e.target.closest('.lightbox-nav-btn')) return;
      overlay.classList.add('hidden');
    });
  }

  if (prevBtn) {
    prevBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (currentScreenshots.length === 0) return;
      currentLightboxIndex = (currentLightboxIndex - 1 + currentScreenshots.length) % currentScreenshots.length;
      openLightbox(currentLightboxIndex);
    });
  }

  if (nextBtn) {
    nextBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (currentScreenshots.length === 0) return;
      currentLightboxIndex = (currentLightboxIndex + 1) % currentScreenshots.length;
      openLightbox(currentLightboxIndex);
    });
  }

  document.getElementById('btn-refresh-screenshots')?.addEventListener('click', loadScreenshots);
}

// ----------------------------------------------------
// 8. ОПЦИОНАЛЬНЫЕ МОДЫ
// ----------------------------------------------------
async function fetchOptionalModsFor(serverId) {
  try {
    const data = await apiFetch(`/manifest?serverId=${serverId}`);

    const container = document.getElementById('optional-mods-container');
    if (!container) return;
    container.innerHTML = '';

    if (!data.optionalFiles || data.optionalFiles.length === 0) {
      container.innerHTML = '<div class="gallery-empty">Для этого сервера нет опциональных модов</div>';
      return;
    }

    data.optionalFiles.forEach(mod => {
      const card = document.createElement('div');
      card.className = 'mod-card';
      const isChecked = appState.selectedOptionalMods.includes(mod.filepath);

      card.innerHTML = `
        <div class="mod-info">
          <span class="mod-title">${mod.mod_name || mod.filepath}</span>
          <span class="mod-desc">${mod.mod_description || 'Опциональный мод'}</span>
        </div>
        <label class="switch">
          <input type="checkbox" data-filepath="${mod.filepath}" ${isChecked ? 'checked' : ''}>
          <span class="slider round"></span>
        </label>
      `;

      card.querySelector('input').addEventListener('change', (e) => {
        const path = e.target.dataset.filepath;
        if (e.target.checked) {
          if (!appState.selectedOptionalMods.includes(path)) appState.selectedOptionalMods.push(path);
        } else {
          appState.selectedOptionalMods = appState.selectedOptionalMods.filter(p => p !== path);
        }
        localStorage.setItem('vozducraft_selected_opt_mods', JSON.stringify(appState.selectedOptionalMods));
      });

      container.appendChild(card);
    });
  } catch (err) {
    console.error('Ошибка загрузки опциональных модов:', err);
  }
}

// ----------------------------------------------------
// 9. НАВИГАЦИЯ И СОБЫТИЯ
// ----------------------------------------------------
function setupNavigation() {
  const navItems = document.querySelectorAll('.nav-item');
  const tabs = document.querySelectorAll('.dashboard-tab');

  navItems.forEach(item => {
    item.addEventListener('click', () => {
      const targetTabId = 'tab-' + item.dataset.tab;
      navItems.forEach(n => n.classList.remove('active'));
      tabs.forEach(t => t.classList.remove('active'));

      item.classList.add('active');
      const targetTab = document.getElementById(targetTabId);
      if (targetTab) targetTab.classList.add('active');

      if (item.dataset.tab === 'screenshots') {
        loadScreenshots();
      } else if (item.dataset.tab === 'mods') {
        const activeServer = appState.servers[appState.currentServerIndex] || appState.servers[0];
        if (activeServer) fetchOptionalModsFor(activeServer.id);
      }
    });
  });

  const logoutBtn = document.getElementById('btn-logout');
  if (logoutBtn) {
    logoutBtn.addEventListener('click', () => {
      localStorage.removeItem('vozducraft_token');
      localStorage.removeItem('vozducraft_username');
      localStorage.removeItem('vozducraft_session_expiry');
      appState.token = null;
      appState.username = null;
      appState.sessionExpiry = 0;
      showAuth();
    });
  }
}

function showAuth() {
  document.getElementById('screen-auth')?.classList.add('active');
  document.getElementById('screen-dashboard')?.classList.remove('active');
  const waitingBox = document.getElementById('discord-waiting-box');
  const authForm = document.getElementById('auth-form');
  if (waitingBox) waitingBox.classList.add('hidden');
  if (authForm) authForm.style.display = 'block';
}

function showDashboard() {
  document.getElementById('screen-auth')?.classList.remove('active');
  document.getElementById('screen-dashboard')?.classList.add('active');
  const nameEl = document.getElementById('display-username');
  if (nameEl) nameEl.textContent = appState.username;
}

let discordPollInterval = null;
let discordTimerInterval = null;

function setupAuthEvents() {
  const authForm = document.getElementById('auth-form');
  const alertEl = document.getElementById('auth-alert');
  const waitingBox = document.getElementById('discord-waiting-box');
  const timerDisplay = document.getElementById('discord-timer-display');
  const btnCancel = document.getElementById('btn-cancel-discord-auth');
  const btnSubmit = document.getElementById('btn-auth-submit');

  const stopDiscordPolling = () => {
    if (discordPollInterval) clearInterval(discordPollInterval);
    if (discordTimerInterval) clearInterval(discordTimerInterval);
    discordPollInterval = null;
    discordTimerInterval = null;
    if (waitingBox) waitingBox.classList.add('hidden');
    if (authForm) authForm.style.display = 'block';
    if (btnSubmit) btnSubmit.disabled = false;
  };

  if (btnCancel) {
    btnCancel.addEventListener('click', () => {
      stopDiscordPolling();
      if (alertEl) {
        alertEl.className = 'auth-alert';
        alertEl.textContent = 'Вход отменен';
        setTimeout(() => alertEl.classList.add('hidden'), 2000);
      }
    });
  }

  if (authForm) {
    authForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const usernameInput = document.getElementById('input-username');
      const username = (usernameInput ? usernameInput.value.trim() : '');

      if (!username || username.length < 3) {
        if (alertEl) {
          alertEl.className = 'auth-alert error';
          alertEl.textContent = 'Введите корректный никнейм (от 3 символов)';
        }
        return;
      }

      if (alertEl) alertEl.className = 'auth-alert hidden';
      if (btnSubmit) btnSubmit.disabled = true;

      try {
        const data = await apiFetch('/auth/discord/request-login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username, hwid: 'LAUNCHER-CLIENT' })
        });

        if (!data || !data.success || !data.requestId) {
          if (alertEl) {
            alertEl.className = 'auth-alert error';
            alertEl.textContent = data.error || 'Ошибка отправки запроса в Discord';
          }
          if (btnSubmit) btnSubmit.disabled = false;
          return;
        }

        // Показываем блок ожидания подтверждения
        authForm.style.display = 'none';
        if (waitingBox) waitingBox.classList.remove('hidden');

        let remainingSeconds = data.expiresInSeconds || 120;
        if (timerDisplay) timerDisplay.textContent = `Осталось: ${remainingSeconds} сек`;

        discordTimerInterval = setInterval(() => {
          remainingSeconds--;
          if (timerDisplay) timerDisplay.textContent = `Осталось: ${remainingSeconds} сек`;
          if (remainingSeconds <= 0) {
            stopDiscordPolling();
            if (alertEl) {
              alertEl.className = 'auth-alert error';
              alertEl.textContent = 'Время ожидания подтверждения истекло';
            }
          }
        }, 1000);

        // Поллинг подтверждения
        discordPollInterval = setInterval(async () => {
          try {
            const statusData = await apiFetch(`/auth/discord/status/${data.requestId}`);

            if (statusData.status === 'APPROVED') {
              stopDiscordPolling();

              appState.username = statusData.username || username;
              appState.token = statusData.token;
              appState.sessionExpiry = statusData.sessionExpiry || (Date.now() + 24 * 60 * 60 * 1000);

              localStorage.setItem('vozducraft_token', appState.token);
              localStorage.setItem('vozducraft_username', appState.username);
              localStorage.setItem('vozducraft_session_expiry', appState.sessionExpiry.toString());

              showDashboard();
              showToast(`🎉 Вход подтвержден! Привет, ${appState.username}!`);

              const activeServer = appState.servers[appState.currentServerIndex] || appState.servers[0];
              if (activeServer) fetchOptionalModsFor(activeServer.id);
            } else if (statusData.status === 'REJECTED') {
              stopDiscordPolling();
              if (alertEl) {
                alertEl.className = 'auth-alert error';
                alertEl.textContent = '❌ Вход был отклонен в Discord';
              }
            } else if (statusData.status === 'EXPIRED') {
              stopDiscordPolling();
              if (alertEl) {
                alertEl.className = 'auth-alert error';
                alertEl.textContent = '⏱️ Время подтверждения истекло';
              }
            }
          } catch (err) {
            console.error('Ошибка проверки статуса:', err);
          }
        }, 1500);

      } catch (err) {
        if (alertEl) {
          alertEl.className = 'auth-alert error';
          alertEl.textContent = err.message || 'Ошибка связи с сервером';
        }
        if (btnSubmit) btnSubmit.disabled = false;
      }
    });
  }
}

function setupQuickFoldersDropdown() {
  const btn = document.getElementById('btn-quick-folders');
  const menu = document.getElementById('dropdown-menu-folders');

  if (btn && menu) {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      menu.classList.toggle('hidden');
    });

    document.addEventListener('click', () => menu.classList.add('hidden'));

    const triggerOpen = (folder) => {
      if (window.nativeOpenFolder) {
        window.nativeOpenFolder(folder);
      } else if (ipcRenderer) {
        ipcRenderer.send('open-folder', folder);
      }
    };

    document.getElementById('open-folder-screenshots')?.addEventListener('click', () => triggerOpen('screenshots'));
    document.getElementById('open-folder-config')?.addEventListener('click', () => triggerOpen('config'));
    document.getElementById('open-folder-logs')?.addEventListener('click', () => triggerOpen('logs'));
  }
}

function setupSettingsEvents() {
  const ramSlider = document.getElementById('ram-slider');
  const ramDisplay = document.getElementById('ram-value-display');
  const disableJvmCb = document.getElementById('disable-jvm-flags');
  const customJvmBox = document.getElementById('custom-jvm-box');
  const customJvmInput = document.getElementById('player-custom-jvm-flags');
  const btnSaveJvm = document.getElementById('btn-save-jvm-flags');
  const btnResetJvm = document.getElementById('btn-reset-jvm-flags');
  const enableRpcCb = document.getElementById('enable-discord-rpc');

  if (customJvmInput) {
    customJvmInput.value = localStorage.getItem('vozducraft_player_custom_jvm') || '';
  }

  if (disableJvmCb) {
    disableJvmCb.checked = appState.disableJvmFlags;
    if (customJvmBox) {
      if (disableJvmCb.checked) {
        customJvmBox.classList.remove('hidden');
        customJvmBox.style.display = 'block';
      } else {
        customJvmBox.classList.add('hidden');
        customJvmBox.style.display = 'none';
      }
    }

    disableJvmCb.addEventListener('change', (e) => {
      appState.disableJvmFlags = e.target.checked;
      localStorage.setItem('vozducraft_disable_jvm', e.target.checked);
      if (customJvmBox) {
        if (e.target.checked) {
          customJvmBox.classList.remove('hidden');
          customJvmBox.style.display = 'block';
        } else {
          customJvmBox.classList.add('hidden');
          customJvmBox.style.display = 'none';
        }
      }
    });
  }

  if (btnSaveJvm && customJvmInput) {
    btnSaveJvm.addEventListener('click', () => {
      let val = customJvmInput.value;
      if (/(-agentlib:jdwp|-Xdebug|-Xrunjdwp)/i.test(val)) {
        alert('⚠️ Флаги отладки Java (jdwp/Xdebug) запрещены политикой безопасности.');
        val = val.replace(/(-agentlib:jdwp[^\s]*|-Xdebug|-Xrunjdwp[^\s]*)/gi, '').trim();
        customJvmInput.value = val;
      }
      appState.playerCustomJvm = val;
      localStorage.setItem('vozducraft_player_custom_jvm', val);
      showToast('💾 Пользовательские JVM-флаги сохранены!');
    });
  }

  if (btnResetJvm && customJvmInput) {
    btnResetJvm.addEventListener('click', () => {
      customJvmInput.value = '';
      appState.playerCustomJvm = '';
      localStorage.removeItem('vozducraft_player_custom_jvm');
      showToast('🔄 Сброшено на стандартные параметры');
    });
  }

  if (ramSlider && ramDisplay) {
    ramSlider.value = appState.ramGb;
    ramDisplay.textContent = `${appState.ramGb} ГБ`;

    ramSlider.addEventListener('input', (e) => {
      appState.ramGb = e.target.value;
      ramDisplay.textContent = `${e.target.value} ГБ`;
      localStorage.setItem('vozducraft_ram', e.target.value);
    });
  }

  if (enableRpcCb) {
    enableRpcCb.checked = appState.enableDiscordRpc;
    enableRpcCb.addEventListener('change', (e) => {
      appState.enableDiscordRpc = e.target.checked;
      localStorage.setItem('vozducraft_rpc', e.target.checked);
    });
  }
}

function setupDownloadListener() {
  if (!ipcRenderer) return;

  ipcRenderer.on('mc-download-status', (event, data) => {
    window.__VOZDUCRAFT_ON_STATUS(data.percent, data.text);
  });

  ipcRenderer.on('mc-status', (event, data) => {
    if (data.type === 'closed') {
      window.__VOZDUCRAFT_ON_GAME_CLOSED(data.code);
    }
  });
}
