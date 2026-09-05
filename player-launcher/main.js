const { app, BrowserWindow, ipcMain, shell, clipboard, nativeImage } = require('electron');
const { spawn, exec } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const os = require('os');

const isWin = process.platform === 'win32';
const isMac = process.platform === 'darwin';
const isArm64 = process.arch === 'arm64' || process.arch === 'aarch64';

let mainWindow;

function generateValidUuid(username) {
  const md5 = crypto.createHash('md5').update(`OfflinePlayer:${username}`).digest('hex');
  return `${md5.substr(0, 8)}-${md5.substr(8, 4)}-${md5.substr(12, 4)}-${md5.substr(16, 4)}-${md5.substr(20, 12)}`;
}

function logToDisk(message) {
  const gamePath = path.join(app.getPath('home'), '.vozducraft');
  if (!fs.existsSync(gamePath)) fs.mkdirSync(gamePath, { recursive: true });

  const logFile = path.join(gamePath, 'launcher.log');
  const timestamp = new Date().toISOString();
  const formattedMsg = `[${timestamp}] ${message}\n`;

  console.log(formattedMsg.trim());
  fs.appendFileSync(logFile, formattedMsg);
}

function downloadFile(url, dest, onProgress, maxRedirects = 5) {
  return new Promise((resolve, reject) => {
    if (maxRedirects <= 0) {
      return reject(new Error(`Too many redirects for ${url}`));
    }

    try {
      if (fs.existsSync(dest)) {
        try { fs.unlinkSync(dest); } catch (_) {}
      }
      const dir = path.dirname(dest);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

      const file = fs.createWriteStream(dest);
      let isClosed = false;
      const safeClose = (cb) => {
        if (!isClosed) {
          isClosed = true;
          file.close(cb);
        } else if (cb) cb();
      };

      file.on('error', (err) => {
        safeClose(() => {
          try { if (fs.existsSync(dest)) fs.unlinkSync(dest); } catch (_) {}
          reject(err);
        });
      });

      const client = url.startsWith('https') ? https : http;
      const parsedUrl = new URL(url);
      const reqOptions = {
        protocol: parsedUrl.protocol,
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
        path: parsedUrl.pathname + parsedUrl.search,
        rejectUnauthorized: false,
        headers: {
          'User-Agent': 'VozduCraft-Launcher/3.4.0 (Windows; x64; Adoptium Java Installer)'
        }
      };

      let timer = null;
      const resetInactivityTimer = (timeoutMs = 30000) => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          req.destroy(new Error(`Download stalled (no data for ${Math.round(timeoutMs/1000)}s): ${url}`));
        }, timeoutMs);
      };

      resetInactivityTimer(30000);

      const req = client.get(reqOptions, (response) => {
        resetInactivityTimer(30000);

        if (response.statusCode === 301 || response.statusCode === 302 || response.statusCode === 303 || response.statusCode === 307 || response.statusCode === 308) {
          if (timer) clearTimeout(timer);
          safeClose(() => {
            const redirectUrl = new URL(response.headers.location, url).toString();
            downloadFile(redirectUrl, dest, onProgress, maxRedirects - 1).then(resolve).catch(reject);
          });
          return;
        }

        if (response.statusCode !== 200 && response.statusCode !== 206) {
          if (timer) clearTimeout(timer);
          safeClose(() => {
            try { if (fs.existsSync(dest)) fs.unlinkSync(dest); } catch (_) {}
            reject(new Error(`HTTP ${response.statusCode} downloading ${url}`));
          });
          return;
        }

        const totalBytes = parseInt(response.headers['content-length'] || '0', 10);
        let downloadedBytes = 0;

        response.on('data', (chunk) => {
          downloadedBytes += chunk.length;
          resetInactivityTimer(30000);
          if (totalBytes > 0 && onProgress) {
            onProgress(downloadedBytes, totalBytes);
          }
        });

        response.on('error', (err) => {
          if (timer) clearTimeout(timer);
          req.destroy(err);
        });

        response.pipe(file);

        file.on('finish', () => {
          if (timer) clearTimeout(timer);
          safeClose(() => resolve(dest));
        });
      });

      req.on('error', (err) => {
        if (timer) clearTimeout(timer);
        safeClose(() => {
          try { if (fs.existsSync(dest)) fs.unlinkSync(dest); } catch (_) {}
          reject(err);
        });
      });
    } catch (e) {
      reject(e);
    }
  });
}

function ensureDesktopShortcut() {
  if (!isWin) return;
  try {
    const desktopDir = app.getPath('desktop') || path.join(app.getPath('home'), 'Desktop');
    const shortcutPath = path.join(desktopDir, 'VozduCraft.lnk');
    const exePath = process.execPath;

    if (fs.existsSync(desktopDir) && exePath.toLowerCase().endsWith('.exe')) {
      const psScript = `
$ws = New-Object -ComObject WScript.Shell
$s = $ws.CreateShortcut('${shortcutPath.replace(/'/g, "''")}')
$s.TargetPath = '${exePath.replace(/'/g, "''")}'
$s.WorkingDirectory = '${path.dirname(exePath).replace(/'/g, "''")}'
$s.IconLocation = '${exePath.replace(/'/g, "''")},0'
$s.Description = 'VozduCraft Launcher'
$s.Save()
`;
      const b64 = Buffer.from(psScript, 'utf16le').toString('base64');
      const { exec } = require('child_process');
      exec(`powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${b64}`, (err) => {
        if (!err) {
          logToDisk(`✨ Ярлык VozduCraft создан/обновлен на Рабочем столе: ${shortcutPath}`);
        } else {
          logToDisk(`[Shortcut Error] ${err.message}`);
        }
      });
    }
  } catch (err) {
    logToDisk(`[Shortcut Warning] ${err.message}`);
  }
}

// Бинарный NBT генератор/записыватель servers.dat для Minecraft Java
function writeServersDat(serversList, targetPath) {
  if (!Array.isArray(serversList) || serversList.length === 0) return;
  const buffers = [];

  function writeByte(val) {
    const b = Buffer.alloc(1);
    b.writeUInt8(val, 0);
    buffers.push(b);
  }

  function writeShort(val) {
    const b = Buffer.alloc(2);
    b.writeUInt16BE(val, 0);
    buffers.push(b);
  }

  function writeInt(val) {
    const b = Buffer.alloc(4);
    b.writeInt32BE(val, 0);
    buffers.push(b);
  }

  function writeString(str) {
    const strBuf = Buffer.from(str || '', 'utf8');
    writeShort(strBuf.length);
    buffers.push(strBuf);
  }

  function writeNamedTag(tagType, name) {
    writeByte(tagType);
    writeString(name);
  }

  // Root Compound (Tag ID 10, empty name "")
  writeByte(0x0A);
  writeShort(0x00);

  // TAG_List (Tag ID 9), name "servers"
  writeNamedTag(0x09, 'servers');
  writeByte(0x0A); // Tag ID of items inside list: TAG_Compound (10)
  writeInt(serversList.length);

  for (const s of serversList) {
    const sName = s.name || 'VozduCraft Server';
    const sIp = s.address || s.ip || '89.248.236.145:27123';

    // String "name"
    writeNamedTag(0x08, 'name');
    writeString(sName);

    // String "ip"
    writeNamedTag(0x08, 'ip');
    writeString(sIp);

    // Optional Base64 icon
    if (s.icon_base64 || s.icon) {
      writeNamedTag(0x08, 'icon');
      writeString(s.icon_base64 || s.icon);
    }

    // Byte "acceptTextures" = 1 (Enabled)
    writeNamedTag(0x01, 'acceptTextures');
    writeByte(0x01);

    // TAG_End (0) for this server Compound
    writeByte(0x00);
  }

  // TAG_End (0) for Root Compound
  writeByte(0x00);

  const finalBuf = Buffer.concat(buffers);
  fs.writeFileSync(targetPath, finalBuf);
}

function createWindow() {
  ensureDesktopShortcut();

  mainWindow = new BrowserWindow({
    width: 1050,
    height: 700,
    frame: false,
    resizable: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  ipcMain.on('window-close', () => { app.quit(); });
  ipcMain.on('window-minimize', () => { if (mainWindow) mainWindow.minimize(); });

  // Автономный микро-агент обновления (ASAR Hot-Patching)
  ipcMain.handle('apply-micro-update', async (event, { asarUrl }) => {
    logToDisk(`⚡ Запуск микро-обновления app.asar: ${asarUrl}`);
    try {
      const resourcesDir = process.resourcesPath || path.join(path.dirname(process.execPath), 'resources');
      const currentAsar = path.join(resourcesDir, 'app.asar');
      const tempAsar = path.join(os.tmpdir(), 'vozducraft_app.asar.update');
      const gamePath = path.join(app.getPath('home'), '.vozducraft');
      if (!fs.existsSync(gamePath)) fs.mkdirSync(gamePath, { recursive: true });

      if (!fs.existsSync(resourcesDir)) {
        throw new Error(`Директория resources не найдена: ${resourcesDir}`);
      }

      // 1. Скачивание пакета обновления (~4.4 МБ) в безопасный временный каталог
      await downloadFile(asarUrl, tempAsar, (downloaded, total) => {
        const pct = total > 0 ? Math.round((downloaded / total) * 100) : 50;
        if (mainWindow) mainWindow.webContents.send('update-progress', { percent: pct, downloaded, total });
      });

      const asarStats = fs.statSync(tempAsar);
      if (asarStats.size < 500000) {
        throw new Error(`Файл обновления поврежден или пуст (${asarStats.size} байт)`);
      }

      logToDisk(`Пакет app.asar скачан (${asarStats.size} байт). Запуск автономного агента обновления...`);

      // 2. Генерация и запуск выделенного агента обновления
      if (isWin) {
        const agentScript = path.join(os.tmpdir(), 'vozducraft_update_agent.ps1');
        const updateLog = path.join(gamePath, 'update.log');
        
        // Надежный PowerShell скрипт с поддержкой UTF-8, кириллических путей и цикла замены
        const psScript = `
Start-Sleep -Milliseconds 600

# 1. Завершаем работу старого процесса лаунчера
try {
    Stop-Process -Id ${process.pid} -Force -ErrorAction SilentlyContinue
} catch {}

$source = '${tempAsar.replace(/'/g, "''")}'
$dest = '${currentAsar.replace(/'/g, "''")}'
$exe = '${process.execPath.replace(/'/g, "''")}'
$log = '${updateLog.replace(/'/g, "''")}'

Add-Content -Path $log -Value "=== VOZDUCRAFT AUTO-UPDATER START ===" -Encoding UTF8 -ErrorAction SilentlyContinue
$retries = 0
$success = $false

while ($retries -lt 40) {
    $retries++
    Start-Sleep -Milliseconds 500
    try {
        Copy-Item -Path $source -Destination $dest -Force -ErrorAction Stop
        $success = $true
        Add-Content -Path $log -Value "[Попытка $retries] Успешно перезаписан app.asar" -Encoding UTF8 -ErrorAction SilentlyContinue
        break
    } catch {
        Add-Content -Path $log -Value "[Попытка $retries] Ожидание освобождения файла: $_" -Encoding UTF8 -ErrorAction SilentlyContinue
    }
}

if ($success) {
    Remove-Item -Path $source -Force -ErrorAction SilentlyContinue
    Add-Content -Path $log -Value "[СТАРТ] Запуск обновленного лаунчера: $exe" -Encoding UTF8 -ErrorAction SilentlyContinue
    Start-Process -FilePath $exe
} else {
    Add-Content -Path $log -Value "[ОШИБКА] Превышено количество попыток замены app.asar" -Encoding UTF8 -ErrorAction SilentlyContinue
}

# Самоудаление скрипта обновления
Remove-Item -Path $MyInvocation.MyCommand.Path -Force -ErrorAction SilentlyContinue
`;
        // Записываем с UTF-8 BOM для безупречной работы PowerShell со всеми языками
        fs.writeFileSync(agentScript, '\uFEFF' + psScript, 'utf8');

        // Запуск PowerShell скрипта в скрытом режиме без мерцания окон
        const child = spawn('powershell.exe', [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy', 'Bypass',
          '-WindowStyle', 'Hidden',
          '-File', agentScript
        ], {
          detached: true,
          stdio: 'ignore',
          windowsHide: true
        });
        child.unref();

        setTimeout(() => {
          app.exit(0);
        }, 300);

        return { success: true };
      } else {
        const agentScript = path.join(os.tmpdir(), 'vozducraft_update_agent.sh');
        const scriptContent = `#!/bin/bash
sleep 1
kill -9 ${process.pid} 2>/dev/null
for i in {1..20}; do
  if cp -f "${newAsar}" "${currentAsar}"; then
    break
  fi
  sleep 0.5
done
rm -f "${newAsar}"
open "${process.execPath.split('/Contents/MacOS')[0]}"
rm -f "$0"
`;
        fs.writeFileSync(agentScript, scriptContent, { mode: 0o755 });

        const child = spawn('/bin/bash', [agentScript], {
          detached: true,
          stdio: 'ignore'
        });
        child.unref();

        setTimeout(() => {
          app.exit(0);
        }, 300);

        return { success: true };
      }
    } catch (err) {
      logToDisk(`[Ошибка микро-обновления] ${err.message}`);
      throw err;
    }
  });

  // 100% СТАБИЛЬНЫЙ ДВИЖОК BOOTSTRAPLAUNCHER 1.21.1
  ipcMain.on('execute-launch', async (event, launchData) => {
    logToDisk('=== СТАРТ ПРОЦЕССА ПОДГОТОВКИ И ЗАПУСКА VOZDUCRAFT BOOTSTRAPLAUNCHER ULTIMATE ===');
    
    // Dynamic OS Paths
    const homeDir = app.getPath('home');
    const gamePath = path.join(homeDir, '.vozducraft');
    const libsDir = path.join(gamePath, 'libraries');
    const modsPath = path.join(gamePath, 'mods');
    const javaDir = path.join(gamePath, 'java');
    const gameLogFile = path.join(gamePath, 'game_output.log');

    if (!fs.existsSync(gamePath)) fs.mkdirSync(gamePath, { recursive: true });
    if (!fs.existsSync(libsDir)) fs.mkdirSync(libsDir, { recursive: true });
    if (!fs.existsSync(modsPath)) fs.mkdirSync(modsPath, { recursive: true });

    const sendStatus = (percent, text) => {
      logToDisk(`PROG [${percent}%]: ${text}`);
      if (mainWindow) mainWindow.webContents.send('mc-download-status', { percent, text });
    };

    const sendClosed = (code) => {
      logToDisk(`Игровой процесс закрыт с кодом ${code}. Возврат кнопки в базовый режим.`);
      if (mainWindow) mainWindow.webContents.send('mc-status', { type: 'closed', code });
    };

    try {
      sendStatus(5, 'Подготовка автономного запуска VozduCraft...');
      const targetNeoForgeVer = '21.1.248';
      const targetMcVer = '1.21.1';

      // 1. Поиск или подгрузка Eclipse Adoptium Temurin 21
      let javaBinaryPath = null;

      function findExecutableRecursively(dir, names) {
        if (!fs.existsSync(dir)) return null;
        try {
          const entries = fs.readdirSync(dir, { withFileTypes: true });
          for (const entry of entries) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
              const found = findExecutableRecursively(full, names);
              if (found) return found;
            } else if (names.includes(entry.name.toLowerCase())) {
              return full;
            }
          }
        } catch (_) {}
        return null;
      }

      function findAdoptiumJava21() {
        // 1. Проверяем локальную директорию лаунчера ~/.vozducraft/java
        if (fs.existsSync(javaDir)) {
          const localBin = findExecutableRecursively(javaDir, isWin ? ['javaw.exe', 'java.exe'] : ['java']);
          if (localBin) return localBin;
        }

        // 2. Системные директории Windows с обязательной фильтрацией по версии 21
        if (isWin) {
          const searchRoots = [
            path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Eclipse Adoptium'),
            path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Eclipse Adoptium'),
            path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Java'),
            path.join(process.env.ProgramFiles || 'C:\\Program Files', 'BellSoft'),
            path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Zulu'),
            path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Eclipse Adoptium'),
            path.join(process.env.ProgramFiles || 'C:\\Program Files', 'AdoptOpenJDK')
          ];

          for (const base of searchRoots) {
            if (!fs.existsSync(base)) continue;
            try {
              const entries = fs.readdirSync(base);
              for (const entry of entries) {
                // Строго требуем наличие "21" в названии папки (например jdk-21, jre-21, 21.0.x)
                if (!entry.includes('21')) continue;
                const fullDir = path.join(base, entry);
                try {
                  const stat = fs.statSync(fullDir);
                  if (stat.isDirectory()) {
                    const javaw = path.join(fullDir, 'bin', 'javaw.exe');
                    const java = path.join(fullDir, 'bin', 'java.exe');
                    if (fs.existsSync(javaw)) return javaw;
                    if (fs.existsSync(java)) return java;
                  }
                } catch (_) {}
              }
            } catch (_) {}
          }

          if (process.env.JAVA_HOME && process.env.JAVA_HOME.includes('21')) {
            const javaw = path.join(process.env.JAVA_HOME, 'bin', 'javaw.exe');
            const java = path.join(process.env.JAVA_HOME, 'bin', 'java.exe');
            if (fs.existsSync(javaw)) return javaw;
            if (fs.existsSync(java)) return java;
          }
        } else if (isMac) {
          const knownPaths = [
            '/Library/Java/JavaVirtualMachines/temurin-21.jre/Contents/Home/bin/java',
            '/Library/Java/JavaVirtualMachines/temurin-21.jdk/Contents/Home/bin/java',
            '/Library/Java/JavaVirtualMachines/zulu-21.jdk/Contents/Home/bin/java',
            '/Library/Java/JavaVirtualMachines/liberica-jdk-21.jdk/Contents/Home/bin/java',
            '/opt/homebrew/opt/openjdk@21/bin/java',
            '/usr/local/opt/openjdk@21/bin/java'
          ];
          for (const p of knownPaths) {
            if (fs.existsSync(p)) return p;
          }
          try {
            const { execSync } = require('child_process');
            const jh = execSync('/usr/libexec/java_home -v 21 2>/dev/null', { encoding: 'utf-8' }).trim();
            if (jh && fs.existsSync(path.join(jh, 'bin', 'java'))) {
              return path.join(jh, 'bin', 'java');
            }
          } catch (_) {}
        }
        return null;
      }

      const foundJava = findAdoptiumJava21();
      if (foundJava) {
        javaBinaryPath = foundJava;
        logToDisk(`✅ Обнаружена среда исполнения Eclipse Adoptium 21: ${javaBinaryPath}`);
      } else {
        logToDisk('Среда Java 21 не найдена на устройстве. Загрузка официального пакета Temurin 21 JDK...');
        const javaUrl = isMac
          ? 'https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.2%2B13/OpenJDK21U-jdk_aarch64_mac_hotspot_21.0.2_13.tar.gz'
          : 'https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.2%2B13/OpenJDK21U-jdk_x64_windows_hotspot_21.0.2_13.zip';
        const tempDest = path.join(os.tmpdir(), isMac ? 'temurin21.tar.gz' : 'temurin21.zip');
        
        sendStatus(10, 'Загрузка Eclipse Adoptium Temurin 21 JDK (~190 МБ)...');
        await downloadFile(javaUrl, tempDest, (loaded, total) => {
          sendStatus(Math.floor((loaded / total) * 10) + 10, `[Загрузка Java 21] ${(loaded / 1024 / 1024).toFixed(1)} МБ`);
        });

        sendStatus(20, 'Распаковка Java 21 JDK...');
        fs.mkdirSync(javaDir, { recursive: true });
        const { execSync } = require('child_process');
        if (isMac) {
          execSync(`tar -xzf "${tempDest}" -C "${javaDir}"`);
          try { fs.unlinkSync(tempDest); } catch (_) {}
        } else if (isWin) {
          try {
            const psCmd = `Expand-Archive -Force -Path '${tempDest.replace(/'/g, "''")}' -DestinationPath '${javaDir.replace(/'/g, "''")}'`;
            const b64 = Buffer.from(psCmd, 'utf16le').toString('base64');
            execSync(`powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${b64}`);
          } catch (_) {
            execSync(`tar -xf "${tempDest}" -C "${javaDir}"`);
          }
          try { fs.unlinkSync(tempDest); } catch (_) {}
        }

        const freshJava = findAdoptiumJava21() || findExecutableRecursively(javaDir, isWin ? ['javaw.exe', 'java.exe'] : ['java']);
        if (freshJava) {
          javaBinaryPath = freshJava;
          logToDisk(`✅ Установлена и готова к работе Eclipse Adoptium 21: ${javaBinaryPath}`);
        } else {
          javaBinaryPath = isWin ? 'javaw.exe' : 'java';
        }
      }

      // 2. Чтение метаданных
      sendStatus(25, 'Анализ библиотек NeoForge и Minecraft...');
      const metaDir = path.join(__dirname, 'meta');
      const mcMeta = JSON.parse(fs.readFileSync(path.join(metaDir, 'minecraft.json'), 'utf-8'));
      const nfMeta = JSON.parse(fs.readFileSync(path.join(metaDir, 'neoforge.json'), 'utf-8'));
      const lwjglMeta = JSON.parse(fs.readFileSync(path.join(metaDir, 'lwjgl.json'), 'utf-8'));

      const allLibsToDownload = [];
      
      const processLib = (lib) => {
        if (!lib.downloads || !lib.downloads.artifact) return;
        
        if (lib.rules) {
            let allowed = false;
            for (const rule of lib.rules) {
                if (rule.action === 'allow' && rule.os && rule.os.name === 'osx') allowed = true;
            }
            if (!allowed && isMac && lib.rules.some(r => r.os && r.os.name)) return;
        }

        const url = lib.downloads.artifact.url;
        let relativePath = lib.downloads.artifact.path;
        if (!relativePath) {
            const parts = lib.name.split(':');
            const group = parts[0].replace(/\./g, '/');
            const artifact = parts[1];
            const version = parts[2];
            let classifier = parts[3] ? `-${parts[3]}` : '';
            if (isMac && classifier.includes('natives')) {
                 if (isArm64 && classifier.includes('arm64')) classifier = '-natives-macos-arm64';
                 else classifier = '-natives-macos';
            }
            relativePath = `${group}/${artifact}/${version}/${artifact}-${version}${classifier}.jar`;
        }

        allLibsToDownload.push({ url, dest: path.join(libsDir, relativePath) });
      };

      if (mcMeta.libraries) mcMeta.libraries.forEach(processLib);
      if (nfMeta.libraries) nfMeta.libraries.forEach(processLib);
      if (nfMeta.mavenFiles) nfMeta.mavenFiles.forEach(processLib);
      if (lwjglMeta.libraries) lwjglMeta.libraries.forEach(processLib);

      // 3. Быстрая параллельная загрузка библиотек с пулом воркеров
      sendStatus(30, 'Синхронизация библиотек...');
      let downloaded = 0;
      const concurrency = 16;
      const queue = [...allLibsToDownload];

      async function downloadWorker() {
        while (queue.length > 0) {
          const lib = queue.shift();
          if (!lib) break;
          try {
            if (!fs.existsSync(lib.dest) || fs.statSync(lib.dest).size < 100) {
              fs.mkdirSync(path.dirname(lib.dest), { recursive: true });
              await downloadFile(lib.url, lib.dest, null).catch(e => {
                logToDisk(`[Lib Warning] ${lib.url}: ${e.message}`);
              });
            }
          } catch (err) {
            logToDisk(`[Lib Warning] ${lib.url}: ${err.message}`);
          }
          downloaded++;
          if (downloaded % 5 === 0 || downloaded === allLibsToDownload.length) {
            const pct = 30 + Math.floor((downloaded / allLibsToDownload.length) * 45);
            sendStatus(pct, `[Библиотеки] ${downloaded}/${allLibsToDownload.length}`);
          }
        }
      }

      const workers = [];
      const numWorkers = Math.min(concurrency, allLibsToDownload.length);
      for (let i = 0; i < numWorkers; i++) {
        workers.push(downloadWorker());
      }
      await Promise.all(workers);

      // Скачивание клиента Minecraft
      const mcJarPath = path.join(libsDir, 'net', 'minecraft', 'client', '1.21.1', 'minecraft-1.21.1-client.jar');
      if (!fs.existsSync(mcJarPath) || fs.statSync(mcJarPath).size < 1000000) {
        fs.mkdirSync(path.dirname(mcJarPath), { recursive: true });
        sendStatus(75, 'Загрузка клиента Minecraft 1.21.1...');
        await downloadFile('https://piston-data.mojang.com/v1/objects/30c73b1c5da787909b2f73340419fdf13b9def88/client.jar', mcJarPath, (loaded, total) => {
          sendStatus(Math.floor((loaded / total) * 10) + 75, `[Загрузка Minecraft] ${(loaded/1024/1024).toFixed(1)} МБ`);
        });
      }

      // Скачивание клиента NeoForge (для Classpath)
      const neoForgeClientJarPath = path.join(gamePath, `neoforge-${targetNeoForgeVer}-client.jar`);
      if (!fs.existsSync(neoForgeClientJarPath)) {
        sendStatus(85, `Загрузка NeoForge Client...`);
        await downloadFile(`https://maven.neoforged.net/releases/net/neoforged/neoforge/${targetNeoForgeVer}/neoforge-${targetNeoForgeVer}-client.jar`, neoForgeClientJarPath, null).catch(async () => {
          await downloadFile(`http://185.221.213.43:3000/files/launchers/neoforge-${targetNeoForgeVer}-client.jar`, neoForgeClientJarPath, null).catch(() => {});
        });
      }

      // Скачивание ForgeWrapper
      const fwJar = path.join(libsDir, 'io', 'github', 'zekerzhayard', 'ForgeWrapper', 'prism-2026-08-01', 'ForgeWrapper-prism-2026-08-01.jar');
      if (!fs.existsSync(fwJar) || fs.statSync(fwJar).size < 1000) {
        fs.mkdirSync(path.dirname(fwJar), { recursive: true });
        await downloadFile('https://files.prismlauncher.org/maven/io/github/zekerzhayard/ForgeWrapper/prism-2026-08-01/ForgeWrapper-prism-2026-08-01.jar', fwJar, null).catch(async () => {
          await downloadFile('http://185.221.213.43:3000/files/launchers/ForgeWrapper-prism-2026-08-01.jar', fwJar, null).catch(() => {});
        });
      }

      // Скачивание NeoForge Installer
      const forgewrapperInstallerJar = path.join(libsDir, 'net', 'neoforged', 'neoforge', targetNeoForgeVer, `neoforge-${targetNeoForgeVer}-installer.jar`);
      if (!fs.existsSync(forgewrapperInstallerJar) || fs.statSync(forgewrapperInstallerJar).size < 1000) {
        fs.mkdirSync(path.dirname(forgewrapperInstallerJar), { recursive: true });
        await downloadFile(`https://maven.neoforged.net/releases/net/neoforged/neoforge/${targetNeoForgeVer}/neoforge-${targetNeoForgeVer}-installer.jar`, forgewrapperInstallerJar, null).catch(async () => {
          await downloadFile(`http://185.221.213.43:3000/files/launchers/neoforge-${targetNeoForgeVer}-installer.jar`, forgewrapperInstallerJar, null).catch(() => {});
        });
      }

      // 3.4. Скачивание и синхронизация ассетов (языковые пакеты ru_ru, панорама главного меню, звуки, шрифты)
      const assetsDir = path.join(gamePath, 'assets');
      const indexesDir = path.join(assetsDir, 'indexes');
      const objectsDir = path.join(assetsDir, 'objects');
      const index17File = path.join(indexesDir, '17.json');

      fs.mkdirSync(indexesDir, { recursive: true });
      fs.mkdirSync(objectsDir, { recursive: true });

      if (!fs.existsSync(index17File) || fs.statSync(index17File).size < 10000) {
        sendStatus(76, 'Загрузка манифеста ресурсов Minecraft 1.21.1 (17.json)...');
        const assetIndexUrl = mcMeta?.assetIndex?.url || 'https://piston-meta.mojang.com/v1/packages/84fb63f8ed4091fab26fb68b32f79dfecfae31d9/17.json';
        await downloadFile(assetIndexUrl, index17File, null).catch(e => {
          logToDisk(`[AssetIndex Warning] ${e.message}`);
        });
      }

      if (fs.existsSync(index17File)) {
        try {
          const indexData = JSON.parse(fs.readFileSync(index17File, 'utf8'));
          const assetObjects = indexData.objects || {};
          const allAssetKeys = Object.keys(assetObjects);

          // Список приоритетных ассетов (русский и другие языки, фон меню panorama_*.png, иконки, шрифты)
          const assetsToDownload = [];
          for (const key of allAssetKeys) {
            const info = assetObjects[key];
            if (!info || !info.hash) continue;
            const sub = info.hash.slice(0, 2);
            const targetDest = path.join(objectsDir, sub, info.hash);

            if (!fs.existsSync(targetDest) || fs.statSync(targetDest).size !== info.size) {
              const isEssential = key.startsWith('minecraft/lang/') || 
                                  key.includes('title/background') || 
                                  key.includes('font') ||
                                  key.startsWith('icons/') ||
                                  key === 'pack.mcmeta';
              assetsToDownload.push({
                key,
                url: `https://resources.download.minecraft.net/${sub}/${info.hash}`,
                dest: targetDest,
                size: info.size,
                isEssential
              });
            }
          }

          if (assetsToDownload.length > 0) {
            logToDisk(`📦 Синхронизация ассетов (языки, текстуры меню): ${assetsToDownload.length} файлов`);
            assetsToDownload.sort((a, b) => (b.isEssential ? 1 : 0) - (a.isEssential ? 1 : 0));

            let downloadedAssets = 0;
            const assetQueue = [...assetsToDownload];
            const assetConcurrency = 24;

            async function assetWorker() {
              while (assetQueue.length > 0) {
                const item = assetQueue.shift();
                if (!item) break;
                try {
                  fs.mkdirSync(path.dirname(item.dest), { recursive: true });
                  await downloadFile(item.url, item.dest, null);
                } catch (e) {
                  // Игнорируем единичные сетевые сбои неосновных звуков
                }
                downloadedAssets++;
                if (downloadedAssets % 50 === 0 || downloadedAssets === assetsToDownload.length) {
                  sendStatus(80, `[Ресурсы и Языки] ${downloadedAssets}/${assetsToDownload.length}`);
                }
              }
            }

            const assetWorkers = [];
            const activeWorkers = Math.min(assetConcurrency, assetsToDownload.length);
            for (let i = 0; i < activeWorkers; i++) {
              assetWorkers.push(assetWorker());
            }
            await Promise.all(assetWorkers);
            logToDisk(`✨ Все ассеты и языки Minecraft успешно синхронизированы!`);
          }
        } catch (err) {
          logToDisk(`[Asset Sync Error] ${err.message}`);
        }
      }

      // 3.5. Синхронизация файлов модпака, серверов и ресурспаков с сервера
      sendStatus(86, 'Синхронизация сборки, серверов и текстур...');
      const serverId = launchData?.serverId || 1;
      const currentUsername = launchData?.username || '';
      const apiBase = launchData?.apiBaseUrl || 'http://185.221.213.43:3000/api/v1';
      const manifestUrl = `${apiBase.replace(/\/+$/, '')}/manifest?serverId=${serverId}&username=${encodeURIComponent(currentUsername)}`;
      
      try {
        const manifestData = await new Promise((resolve) => {
          const u = new URL(manifestUrl);
          const httpLib = u.protocol === 'https:' ? require('https') : require('http');
          httpLib.get(manifestUrl, (res) => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => {
              try { resolve(JSON.parse(body)); } catch (_) { resolve(null); }
            });
          }).on('error', () => resolve(null));
        });

        if (manifestData) {
          // 3.5.1. Автоматическая запись/обновление servers.dat для списка серверов
          if (manifestData.clientServers && Array.isArray(manifestData.clientServers) && manifestData.clientServers.length > 0) {
            try {
              const serversDatPath = path.join(gamePath, 'servers.dat');
              writeServersDat(manifestData.clientServers, serversDatPath);
              logToDisk(`[Servers.dat] Успешно записан servers.dat (${manifestData.clientServers.length} серверов)`);
            } catch (sDatErr) {
              logToDisk(`[Servers.dat Warning] ${sDatErr.message}`);
            }
          }

          // 3.5.2. Синхронизация модов
          const selectedOpts = launchData?.selectedOptionalMods || launchData?.optionalMods || [];
          const filesToSync = [];

          if (Array.isArray(manifestData.files)) {
            manifestData.files.forEach(f => filesToSync.push({ ...f, isOpt: false }));
          }
          if (Array.isArray(manifestData.optionalFiles)) {
            manifestData.optionalFiles.forEach(f => {
              if (selectedOpts.includes(f.filepath)) {
                filesToSync.push({ ...f, isOpt: true });
              } else {
                const targetPath = path.join(gamePath, f.filepath);
                if (fs.existsSync(targetPath)) {
                  try { fs.unlinkSync(targetPath); } catch (_) {}
                }
              }
            });
          }

          logToDisk(`К синхронизации: ${filesToSync.length} файлов сборки`);
          const allowedModFiles = new Set();
          let syncedCount = 0;
          const modQueue = [...filesToSync];
          const modConcurrency = 12;

          const masterHost = apiBase.replace(/\/api\/v1\/?$/, '');

          async function modWorker() {
            while (modQueue.length > 0) {
              const fileItem = modQueue.shift();
              if (!fileItem) break;
              
              const relPath = fileItem.filepath;
              const targetPath = path.join(gamePath, relPath);
              allowedModFiles.add(path.basename(relPath).toLowerCase());

              let downloadUrl = fileItem.download_url || '';
              if (!downloadUrl) {
                downloadUrl = `${masterHost}/files/${relPath.replace(/^\/+/, '')}`;
              } else if (downloadUrl.includes('localhost:3000') || downloadUrl.includes('127.0.0.1:3000')) {
                downloadUrl = downloadUrl.replace(/https?:\/\/(localhost|127\.0\.0\.1):3000/, masterHost);
              } else if (downloadUrl.startsWith('/')) {
                downloadUrl = `${masterHost}${downloadUrl}`;
              }

              if (downloadUrl) {
                try {
                  let needDownload = true;
                  if (fs.existsSync(targetPath)) {
                    const localSize = fs.statSync(targetPath).size;
                    if (fileItem.size_bytes && localSize === fileItem.size_bytes && localSize > 0) {
                      needDownload = false;
                    }
                  }

                  if (needDownload) {
                    logToDisk(`[Скачивание мода] ${relPath} (${fileItem.size_bytes || 0} B) с ${downloadUrl}...`);
                    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
                    await downloadFile(downloadUrl, targetPath, null).catch(e => {
                      logToDisk(`[Mod Sync Error] ${fileItem.filepath}: ${e.message}`);
                    });
                    if (fs.existsSync(targetPath)) {
                      logToDisk(`[Мод успешно скачан] ${relPath} (${fs.statSync(targetPath).size} B)`);
                    }
                  }
                } catch (e) {
                  logToDisk(`[Mod Sync Warning] ${fileItem.filepath}: ${e.message}`);
                }
              }

              syncedCount++;
              if (syncedCount % 5 === 0 || syncedCount === filesToSync.length) {
                const pct = 86 + Math.floor((syncedCount / Math.max(1, filesToSync.length)) * 3);
                sendStatus(pct, `[Синхронизация модов] ${syncedCount}/${filesToSync.length}`);
              }
            }
          }

          const modWorkers = [];
          for (let i = 0; i < Math.min(modConcurrency, filesToSync.length); i++) {
            modWorkers.push(modWorker());
          }
          await Promise.all(modWorkers);

          // 🛡️ Античит: очистка папки mods от посторонних .jar
          if (fs.existsSync(modsPath)) {
            const localMods = fs.readdirSync(modsPath);
            for (const file of localMods) {
              if (file.endsWith('.jar') && !allowedModFiles.has(file.toLowerCase())) {
                logToDisk(`🛡️ Удален посторонний файл из mods: ${file}`);
                try { fs.unlinkSync(path.join(modsPath, file)); } catch (_) {}
              }
            }
          }

          // 3.5.3. Синхронизация Ресурспаков (Resource Packs)
          const resourcepacksDir = path.join(gamePath, 'resourcepacks');
          if (!fs.existsSync(resourcepacksDir)) {
            fs.mkdirSync(resourcepacksDir, { recursive: true });
          }

          const selectedOptPacks = launchData?.selectedOptionalResourcePacks || launchData?.selectedResourcePacks || [];
          const rpToSync = [];
          if (Array.isArray(manifestData.resourcePacks)) {
            manifestData.resourcePacks.forEach(rp => rpToSync.push({ ...rp, isOpt: false }));
          }
          if (Array.isArray(manifestData.optionalResourcePacks)) {
            manifestData.optionalResourcePacks.forEach(rp => {
              if (selectedOptPacks.includes(rp.filepath) || selectedOptPacks.includes(rp.filename)) {
                rpToSync.push({ ...rp, isOpt: true });
              } else {
                const targetRpPath = path.join(gamePath, rp.filepath || `resourcepacks/${rp.filename}`);
                if (fs.existsSync(targetRpPath)) {
                  try { fs.unlinkSync(targetRpPath); } catch (_) {}
                }
              }
            });
          }

          const allowedRpFiles = new Set();
          for (const rp of rpToSync) {
            const relPath = rp.filepath || `resourcepacks/${rp.filename}`;
            const targetRpPath = path.join(gamePath, relPath);
            allowedRpFiles.add(path.basename(relPath).toLowerCase());

            let downloadUrl = rp.download_url || '';
            if (!downloadUrl) {
              downloadUrl = `${masterHost}/files/${relPath.replace(/^\/+/, '')}`;
            } else if (downloadUrl.includes('localhost:3000') || downloadUrl.includes('127.0.0.1:3000')) {
              downloadUrl = downloadUrl.replace(/https?:\/\/(localhost|127\.0\.0\.1):3000/, masterHost);
            } else if (downloadUrl.startsWith('/')) {
              downloadUrl = `${masterHost}${downloadUrl}`;
            }

            if (downloadUrl) {
              try {
                let needDownload = true;
                if (fs.existsSync(targetRpPath)) {
                  const localSize = fs.statSync(targetRpPath).size;
                  if (rp.size_bytes && localSize === rp.size_bytes && localSize > 0) {
                    needDownload = false;
                  }
                }
                if (needDownload) {
                  logToDisk(`[Скачивание ресурспака] ${relPath} с ${downloadUrl}...`);
                  fs.mkdirSync(path.dirname(targetRpPath), { recursive: true });
                  await downloadFile(downloadUrl, targetRpPath, null).catch(e => {
                    logToDisk(`[RP Sync Error] ${relPath}: ${e.message}`);
                  });
                }
              } catch (rpErr) {
                logToDisk(`[RP Warning] ${rpErr.message}`);
              }
            }
          }

          // 🛡️ Античит: очистка resourcepacks от посторонних .zip файлов (блокировка читерских X-Ray паков)
          try {
            if (fs.existsSync(resourcepacksDir)) {
              const localRps = fs.readdirSync(resourcepacksDir);
              for (const file of localRps) {
                if (file.endsWith('.zip') && !allowedRpFiles.has(file.toLowerCase())) {
                  logToDisk(`🛡️ Удален неразрешенный ресурспак: ${file}`);
                  try { fs.unlinkSync(path.join(resourcepacksDir, file)); } catch (_) {}
                }
              }
            }
          } catch (_) {}
        }
      } catch (err) {
        logToDisk(`[Modpack Sync Error] ${err.message}`);
      }

      // 4. Формирование Classpath
      sendStatus(90, 'Построение путей и запуск FML...');
      const modulePathEntries = [];
      const jvmCpEntries = [];

      for (const lib of allLibsToDownload) {
        const p = lib.dest;
        if (!fs.existsSync(p)) continue;
        const pLower = p.toLowerCase().replace(/\\/g, '/');
        if (
          pLower.includes('universal') ||
          pLower.includes('installer') ||
          pLower.includes('net/neoforged/neoforge/') ||
          pLower.includes('net/minecraft/client/') ||
          pLower.includes('binarypatcher') || 
          pLower.includes('autorenamingtool') || 
          pLower.includes('installertools') || 
          pLower.includes('jarsplitter') || 
          pLower.includes('cli-utils') || 
          pLower.includes('specialsource') || 
          pLower.includes('srgutils') || 
          pLower.includes('neoform') ||
          pLower.includes('gson-2.8.9')
        ) continue;
        
        if (
          pLower.includes('cpw/mods/bootstraplauncher') || 
          pLower.includes('cpw/mods/securejarhandler') || 
          pLower.includes('org/ow2/asm') || 
          pLower.includes('jarjarfilesystem')
        ) {
          modulePathEntries.push(p);
        } else {
          jvmCpEntries.push(p);
        }
      }

      if (fs.existsSync(fwJar)) {
        jvmCpEntries.push(fwJar);
      }
      
      const pathSeparator = isWin ? ';' : ':';
      
      // Удаление дубликатов из путей
      const uniqueModulePathEntries = [...new Set(modulePathEntries)];
      const uniqueJvmCpEntries = [...new Set(jvmCpEntries)];

      const modulePath = uniqueModulePathEntries.join(pathSeparator);
      const classpath = uniqueJvmCpEntries.join(pathSeparator);
      const finalLegacyCpString = uniqueJvmCpEntries.join(pathSeparator);
      
      if (!fs.existsSync(assetsDir)) {
          fs.mkdirSync(assetsDir, { recursive: true });
      }

      // 5. Запуск процесса Java
      sendStatus(95, `Запуск ForgeWrapper...`);
      const username = launchData?.username || 'PhonixVogel';
      const ram = launchData?.ram || 6;
      const validUuid = generateValidUuid(username);
      const macFlags = isMac ? ['-XstartOnFirstThread'] : [];
      const mainClass = 'io.github.zekerzhayard.forgewrapper.installer.Main';
      const mergeString = `jna-5.14.0.jar,jna-platform-5.14.0.jar;minecraft-1.21.1-client.jar,neoforge-${targetNeoForgeVer}-client.jar`;

      const jvmArgs = [
        `-Dforgewrapper.minecraft=${mcJarPath}`,
        `-Dforgewrapper.librariesDir=${libsDir}`,
        `-DlegacyClassPath=${finalLegacyCpString}`,
        `-DlibraryDirectory=${libsDir}`,
        `-Dforgewrapper.installer=${forgewrapperInstallerJar}`,
        `-DmergeModules=${mergeString}`,
        ...macFlags,
        `-Xms4G`,
        `-Xmx${ram}G`,
        `--module-path`, modulePath,
        `--add-modules`, `ALL-SYSTEM`,
        `--add-modules`, `ALL-MODULE-PATH`,
        `--add-modules`, `jdk.naming.dns`,
        `--add-opens`, `java.base/java.lang=cpw.mods.securejarhandler,ALL-UNNAMED`,
        `--add-opens`, `java.base/java.lang.invoke=cpw.mods.securejarhandler,ALL-UNNAMED`,
        `--add-opens`, `java.base/java.util=ALL-UNNAMED`,
        `--add-opens`, `java.base/java.util.jar=ALL-UNNAMED`,
        `--add-opens`, `java.base/java.io=ALL-UNNAMED`,
        `--add-opens`, `java.base/java.nio.channels=ALL-UNNAMED`,
        `--add-opens`, `java.base/sun.net.www.protocol.jar=ALL-UNNAMED`,
        `-Dnet.neoforged.mappedNaming=official`,
        `-DignoreList=bootstraplauncher,securejarhandler`,
        `-Dneoforge.stage=client`,
        `-Dneoforge.version=${targetNeoForgeVer}`,
        `-Dneoforge.modsDir=${modsPath}`,
        `-Dneoforge.earlyWindow=false`,
        `-Dfml.earlyWindow=false`,
        `-Dneoforge.earlydisplay=false`,
        `-Dfml.earlydisplay=false`,
        `-Dneoforge.earlyWindow.enabled=false`,
        `-Dfml.earlyWindow.enabled=false`,
        `-Dneoforge.display.enabled=false`,
        `-cp`,
        classpath
      ];

      const gameArgs = [
        `--username`, username,
        `--version`, `1.21.1`,
        `--gameDir`, gamePath,
        `--assetsDir`, path.join(gamePath, 'assets'),
        `--assetIndex`, `17`,
        `--uuid`, validUuid,
        `--accessToken`, `VOZDUCRAFT-TOKEN-${Date.now()}`,
        `--userType`, `offline`,
        `--versionType`, `release`,
        `--neoForgeVersion`, targetNeoForgeVer,
        `--fml.neoForgeVersion`, targetNeoForgeVer,
        `--fmlVersion`, `4.0.43`,
        `--fml.fmlVersion`, `4.0.43`,
        `--mcVersion`, `1.21.1`,
        `--fml.mcVersion`, `1.21.1`,
        `--neoFormVersion`, `20240808.144430`,
        `--fml.neoFormVersion`, `20240808.144430`,
        `--fml.earlyWindow=false`,
        `--launchTarget`, `forgeclient`
      ];

      // Формирование файла аргументов JVM для обхода лимита длины строки Windows (ENAMETOOLONG)
      function formatArgForJava(arg) {
        if (!arg) return '';
        if (arg.includes(' ')) {
          return `"${arg.replace(/\\/g, '\\\\')}"`;
        }
        return arg;
      }

      const jvmArgsFormatted = [];
      for (let i = 0; i < jvmArgs.length; i++) {
        const item = jvmArgs[i];
        if (item === '-cp' || item === '--module-path' || item === '--add-modules' || item === '--add-opens') {
          jvmArgsFormatted.push(item);
          i++;
          if (i < jvmArgs.length) {
            jvmArgsFormatted.push(formatArgForJava(jvmArgs[i]));
          }
        } else if (item.startsWith('-D') && item.includes('=')) {
          const eqIndex = item.indexOf('=');
          const k = item.slice(0, eqIndex + 1);
          const v = item.slice(eqIndex + 1);
          jvmArgsFormatted.push(v.includes(' ') ? `${k}"${v.replace(/\\/g, '\\\\')}"` : item);
        } else {
          jvmArgsFormatted.push(formatArgForJava(item));
        }
      }

      const argFilePath = path.join(gamePath, 'jvm_args.txt');
      try {
        fs.writeFileSync(argFilePath, jvmArgsFormatted.join('\n'), 'utf8');
      } catch (_) {}

      const finalArgs = isWin 
        ? [`@${argFilePath}`, mainClass, ...gameArgs]
        : [...jvmArgs, mainClass, ...gameArgs];

      logToDisk(`ЗАПУСК ИГРЫ (${isWin ? 'Windows ArgFile' : 'Unix Direct'}): ${javaBinaryPath} ${finalArgs.join(' ')}`);

      try {
        fs.writeFileSync(path.join(gamePath, 'java_cmd.log'), `=== JVM ARGS ===\n${jvmArgsFormatted.join('\n')}\n\n=== MAIN CLASS ===\n${mainClass}\n\n=== GAME ARGS ===\n${gameArgs.join('\n')}`);
      } catch (_) {}
      try {
        fs.writeFileSync(gameLogFile, `=== СТАРТ ИГРОВОГО ЛОГА [${new Date().toISOString()}] ===\n`);
      } catch (_) {}

      function reportCrashToServer(code, errDetail) {
        try {
          const crashReportsDir = path.join(gamePath, 'crash-reports');
          let latestCrashContent = '';
          let latestCrashFilename = '';

          if (fs.existsSync(crashReportsDir)) {
            try {
              const files = fs.readdirSync(crashReportsDir).filter(f => f.startsWith('crash-') && f.endsWith('.txt'));
              if (files.length > 0) {
                files.sort((a, b) => {
                  return fs.statSync(path.join(crashReportsDir, b)).mtimeMs - fs.statSync(path.join(crashReportsDir, a)).mtimeMs;
                });
                latestCrashFilename = files[0];
                const crashPath = path.join(crashReportsDir, latestCrashFilename);
                latestCrashContent = fs.readFileSync(crashPath, 'utf8');
              }
            } catch (_) {}
          }

          // Если внутри crash-reports не было файла, формируем отчет из вывода консоли игры
          if (!latestCrashContent) {
            latestCrashFilename = `crash-exit-code-${code}-${Date.now()}.txt`;
            let generatedLog = `=== VOZDUCRAFT MINECRAFT CRASH/EXIT REPORT ===\n`;
            generatedLog += `Username: ${username}\n`;
            generatedLog += `Exit Code: ${code}\n`;
            generatedLog += `Detail: ${errDetail || 'Game exited unexpectedly'}\n`;
            generatedLog += `Java Binary: ${javaBinaryPath}\n`;
            generatedLog += `Time: ${new Date().toISOString()}\n\n`;
            if (fs.existsSync(gameLogFile)) {
              generatedLog += `=== GAME CONSOLE OUTPUT ===\n` + fs.readFileSync(gameLogFile, 'utf8');
            }
            latestCrashContent = generatedLog;
          }

          // Всегда отправляем структурированный отчет в /api/v1/launcher/crash-report
          const crashPayload = JSON.stringify({
            username: username,
            os: isWin ? 'Windows' : 'macOS',
            server_id: launchData?.serverId || 1,
            crash_filename: latestCrashFilename,
            report_content: latestCrashContent
          });

          const crashReq = http.request({
            hostname: '185.221.213.43',
            port: 3000,
            path: '/api/v1/launcher/crash-report',
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(crashPayload, 'utf8')
            }
          }, () => {});
          crashReq.on('error', () => {});
          crashReq.write(crashPayload, 'utf8');
          crashReq.end();

          let logContent = `Exit Code: ${code}\nDetail: ${errDetail || 'None'}\nJava Path: ${javaBinaryPath}\n`;
          if (latestCrashFilename) {
            logContent += `\n--- CRASH REPORT: ${latestCrashFilename} ---\n` + latestCrashContent.slice(0, 15000) + '\n';
          }
          try {
            if (fs.existsSync(gameLogFile)) {
              logContent += '\n--- GAME LOG (LAST 8KB) ---\n' + fs.readFileSync(gameLogFile, 'utf8').slice(-8000);
            }
          } catch (_) {}
          try {
            const launcherLog = path.join(gamePath, 'launcher.log');
            if (fs.existsSync(launcherLog)) {
              logContent += '\n--- LAUNCHER LOG (LAST 4KB) ---\n' + fs.readFileSync(launcherLog, 'utf8').slice(-4000);
            }
          } catch (_) {}

          const payload = JSON.stringify({
            username: username,
            os: isWin ? 'Windows' : 'macOS',
            launcher_version: app.getVersion() || '3.1.9',
            event_type: 'CRASH',
            log_content: logContent
          });

          const postReq = http.request({
            hostname: '185.221.213.43',
            port: 3000,
            path: '/api/v1/launcher/debug-log',
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(payload)
            }
          }, () => {});
          postReq.on('error', () => {});
          postReq.write(payload);
          postReq.end();
        } catch (_) {}
      }

      // Создание защищенного билета сессии на мастер-сервере VozduCraft Security
      try {
        const ticketPayload = JSON.stringify({ username: username });
        const ticketReq = http.request({
          hostname: '185.221.213.43',
          port: 3000,
          path: '/api/v1/launcher/session-ticket',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(ticketPayload)
          }
        }, (ticketRes) => {
          logToDisk(`[SECURITY TICKET] Ответ сервера безопасности: HTTP ${ticketRes.statusCode}`);
        });
        ticketReq.on('error', (err) => {
          logToDisk(`[SECURITY TICKET] Ошибка запроса билета: ${err.message}`);
        });
        ticketReq.write(ticketPayload);
        ticketReq.end();
      } catch (err) {
        logToDisk(`[SECURITY TICKET] Исключение: ${err.message}`);
      }

      const mcProcess = require('child_process').spawn(javaBinaryPath, finalArgs, { cwd: gamePath, shell: false, env: process.env });
      mcProcess.stdout?.on('data', (data) => {
        const str = data.toString();
        logToDisk(`[GAME OUT] ${str.trim()}`);
        try { fs.appendFileSync(gameLogFile, str); } catch (_) {}
      });
      mcProcess.stderr?.on('data', (data) => {
        const str = data.toString();
        logToDisk(`[GAME ERR] ${str.trim()}`);
        try { fs.appendFileSync(gameLogFile, str); } catch (_) {}
      });
      mcProcess.on('error', (err) => {
        logToDisk(`[FATAL PROCESS ERROR] ${err.message}`);
        reportCrashToServer(-1, err.message);
        if (mainWindow) mainWindow.webContents.send('mc-error', { error: err.message });
        sendClosed(-1);
      });
      mcProcess.on('close', (code) => {
        logToDisk(`Игровой процесс завершился с кодом: ${code}`);
        if (code !== 0) reportCrashToServer(code);
        sendClosed(code);
      });
      sendStatus(100, 'Minecraft успешно запущен!');
    } catch (err) {
      logToDisk(`[CRITICAL ERROR] ${err.message}`);
      try {
        const payload = JSON.stringify({
          username: launchData?.username || 'Player',
          os: isWin ? 'Windows' : 'macOS',
          launcher_version: app.getVersion() || '3.1.2',
          event_type: 'CRASH',
          log_content: `Launcher Exception: ${err.message}\nStack: ${err.stack}`
        });
        const postReq = http.request({
          hostname: '185.221.213.43',
          port: 3000,
          path: '/api/v1/launcher/debug-log',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload)
          }
        }, () => {});
        postReq.on('error', () => {});
        postReq.write(payload);
        postReq.end();
      } catch (_) {}
      sendStatus(0, 'Ошибка: ' + err.message);
      sendClosed(-1);
    }
  });

  ipcMain.on('open-folder', (event, folderType) => {
    const homeDir = app.getPath('home');
    let targetPath = path.join(homeDir, '.vozducraft');

    if (folderType === 'screenshots') targetPath = path.join(targetPath, 'screenshots');
    if (folderType === 'config') targetPath = path.join(targetPath, 'config');
    if (folderType === 'logs') targetPath = path.join(targetPath, 'logs');

    if (!fs.existsSync(targetPath)) fs.mkdirSync(targetPath, { recursive: true });
    shell.openPath(targetPath);
  });

  // Получение списка скриншотов из .vozducraft/screenshots и связанных директорий
  ipcMain.handle('get-screenshots', async () => {
    try {
      const homeDir = app.getPath('home');
      const searchDirs = [
        path.join(homeDir, '.vozducraft', 'screenshots'),
        path.join(homeDir, '.vozducraft', 'instances', 'VozduCraft Season #2', 'screenshots'),
        path.join(homeDir, '.minecraft', 'screenshots'),
        path.join(homeDir, 'AppData', 'Roaming', '.minecraft', 'screenshots'),
        path.join(homeDir, 'AppData', 'Roaming', '.vozducraft', 'screenshots'),
        path.join(homeDir, 'Library', 'Application Support', 'minecraft', 'screenshots')
      ];

      const foundFiles = [];
      const seenNames = new Set();

      for (const dir of searchDirs) {
        if (!fs.existsSync(dir)) continue;
        try {
          const files = fs.readdirSync(dir).filter(f => {
            const lower = f.toLowerCase();
            return lower.endsWith('.png') || lower.endsWith('.jpg') || lower.endsWith('.jpeg');
          });

          for (const f of files) {
            const fullPath = path.join(dir, f);
            try {
              const stat = fs.statSync(fullPath);
              if (stat.isFile() && !seenNames.has(f.toLowerCase())) {
                seenNames.add(f.toLowerCase());
                foundFiles.push({
                  filename: f,
                  path: fullPath,
                  mtimeMs: stat.mtimeMs
                });
              }
            } catch (_) {}
          }
        } catch (_) {}
      }

      foundFiles.sort((a, b) => b.mtimeMs - a.mtimeMs);

      const list = [];
      for (const item of foundFiles.slice(0, 80)) {
        try {
          const ext = path.extname(item.filename).slice(1).toLowerCase() || 'png';
          const dataBuf = fs.readFileSync(item.path);
          const base64 = dataBuf.toString('base64');
          list.push({
            filename: item.filename,
            path: item.path,
            data: `data:image/${ext === 'jpg' ? 'jpeg' : ext};base64,${base64}`
          });
        } catch (_) {}
      }
      return list;
    } catch (err) {
      logToDisk(`[SCREENSHOTS ERROR] ${err.message}`);
      return [];
    }
  });

  // Копирование изображения в системный буфер обмена
  ipcMain.handle('copy-image-to-clipboard', async (event, filePath) => {
    try {
      if (filePath && fs.existsSync(filePath)) {
        const img = nativeImage.createFromPath(filePath);
        clipboard.writeImage(img);
        return { success: true };
      }
      return { success: false, error: 'File not found' };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
