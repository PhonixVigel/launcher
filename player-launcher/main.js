const { app, BrowserWindow, ipcMain, shell } = require('electron');
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
        headers: {
          'User-Agent': 'VozduCraft-Launcher/3.0.6 (Windows; x64; Adoptium Java Installer)'
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

function createWindow() {
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
      const newAsar = path.join(resourcesDir, 'app.asar.update');

      if (!fs.existsSync(resourcesDir)) {
        throw new Error(`Директория resources не найдена: ${resourcesDir}`);
      }

      // 1. Скачивание пакета обновления (~4 МБ)
      await downloadFile(asarUrl, newAsar, (downloaded, total) => {
        const pct = total > 0 ? Math.round((downloaded / total) * 100) : 50;
        if (mainWindow) mainWindow.webContents.send('update-progress', { percent: pct, downloaded, total });
      });

      logToDisk(`Пакет app.asar.update скачан (${fs.statSync(newAsar).size} байт). Запуск отдельного агента обновления...`);

      // 2. Генерация и запуск выделенного агента обновления
      if (isWin) {
        const agentScript = path.join(os.tmpdir(), 'vozducraft_update_agent.bat');
        const vbsScript = path.join(os.tmpdir(), 'vozducraft_update_runner.vbs');
        const scriptContent = `@echo off
chcp 65001 >nul
timeout /t 1 /nobreak >nul
taskkill /F /PID ${process.pid} >nul 2>&1
timeout /t 1 /nobreak >nul
copy /Y "${newAsar}" "${currentAsar}" >nul 2>&1
del /F /Q "${newAsar}" >nul 2>&1
start "" "${process.execPath}"
del "%~f0"
`;
        fs.writeFileSync(agentScript, scriptContent, 'utf8');

        // Скрытый запуск через VBScript без мигания консоли
        const vbsContent = `Set WshShell = CreateObject("WScript.Shell")\nWshShell.Run chr(34) & "${agentScript.replace(/\\/g, '\\\\')}" & chr(34), 0, False\n`;
        fs.writeFileSync(vbsScript, vbsContent, 'utf8');

        const child = spawn('wscript.exe', [vbsScript], {
          detached: true,
          stdio: 'ignore'
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
cp -f "${newAsar}" "${currentAsar}"
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

      function findAdoptiumJava21() {
        if (isWin) {
          const searchRoots = [
            path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Eclipse Adoptium'),
            path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Eclipse Adoptium'),
            path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Eclipse Adoptium'),
            path.join(process.env.ProgramFiles || 'C:\\Program Files', 'AdoptOpenJDK'),
            path.join(gamePath, 'java')
          ];

          for (const base of searchRoots) {
            if (!fs.existsSync(base)) continue;
            try {
              const entries = fs.readdirSync(base);
              for (const entry of entries) {
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

          if (process.env.JAVA_HOME && process.env.JAVA_HOME.toLowerCase().includes('adopt')) {
            const javaw = path.join(process.env.JAVA_HOME, 'bin', 'javaw.exe');
            if (fs.existsSync(javaw)) return javaw;
          }
        } else if (isMac) {
          const knownPaths = [
            '/Library/Java/JavaVirtualMachines/temurin-21.jre/Contents/Home/bin/java',
            '/Library/Java/JavaVirtualMachines/temurin-21.jdk/Contents/Home/bin/java',
            path.join(gamePath, 'java', 'jdk-21.0.2+13/Contents/Home/bin/java')
          ];
          for (const p of knownPaths) {
            if (fs.existsSync(p)) return p;
          }
        }
        return null;
      }

      const foundJava = findAdoptiumJava21();
      if (foundJava) {
        javaBinaryPath = foundJava;
        logToDisk(`✅ Обнаружена среда исполнения Eclipse Adoptium 21: ${javaBinaryPath}`);
      } else {
        logToDisk('Среда Eclipse Adoptium 21 не найдена. Загрузка официального пакета Temurin 21 JDK...');
        const javaUrl = isMac
          ? 'https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.2%2B13/OpenJDK21U-jdk_aarch64_mac_hotspot_21.0.2_13.tar.gz'
          : 'https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.2%2B13/OpenJDK21U-jdk_x64_windows_hotspot_21.0.2_13.zip';
        const tempDest = path.join(os.tmpdir(), isMac ? 'temurin21.tar.gz' : 'temurin21.zip');
        
        sendStatus(10, 'Загрузка Eclipse Adoptium Temurin 21 JDK...');
        await downloadFile(javaUrl, tempDest, (loaded, total) => {
          sendStatus(Math.floor((loaded / total) * 10) + 10, `[Загрузка Adoptium 21] ${(loaded / 1024 / 1024).toFixed(1)} МБ`);
        });

        fs.mkdirSync(javaDir, { recursive: true });
        const { execSync } = require('child_process');
        if (isMac) {
          execSync(`tar -xzf "${tempDest}" -C "${javaDir}"`);
          try { fs.unlinkSync(tempDest); } catch (_) {}
        } else if (isWin) {
          try {
            execSync(`powershell -Command "Expand-Archive -Force -Path '${tempDest}' -DestinationPath '${javaDir}'"`);
          } catch (_) {
            execSync(`tar -xf "${tempDest}" -C "${javaDir}"`);
          }
          try { fs.unlinkSync(tempDest); } catch (_) {}
        }

        const freshJava = findAdoptiumJava21();
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
      
      const assetsDir = path.join(gamePath, 'assets');
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
          let logContent = `Exit Code: ${code}\nDetail: ${errDetail || 'None'}\nJava Path: ${javaBinaryPath}\n`;
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
            launcher_version: app.getVersion() || '3.1.2',
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
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
