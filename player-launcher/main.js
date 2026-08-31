const { app, BrowserWindow, ipcMain, shell } = require('electron');
const { spawn, exec } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const os = require('os');

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

function downloadFile(url, dest, onProgress) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const client = url.startsWith('https') ? https : http;

    client.get(url, (response) => {
      if (response.statusCode === 301 || response.statusCode === 302) {
        return downloadFile(response.headers.location, dest, onProgress).then(resolve).catch(reject);
      }

      const totalBytes = parseInt(response.headers['content-length'] || '0', 10);
      let downloadedBytes = 0;

      response.on('data', (chunk) => {
        downloadedBytes += chunk.length;
        if (totalBytes > 0 && onProgress) {
          onProgress(downloadedBytes, totalBytes);
        }
      });

      response.pipe(file);

      file.on('finish', () => {
        file.close(() => resolve(dest));
      });
    }).on('error', (err) => {
      fs.unlink(dest, () => reject(err));
    });
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
      const targetNeoForgeVer = '21.1.234';
      const targetMcVer = '1.21.1';

      // 1. Поиск или подгрузка Java 21
      let javaBinaryPath = 'java';
      const localJavaMac = path.join(javaDir, 'jdk-21.0.2+13/Contents/Home/bin/java');
      const localJavaWin = path.join(javaDir, 'bin', 'java.exe');
      if (fs.existsSync(localJavaMac)) {
        javaBinaryPath = localJavaMac;
      } else if (fs.existsSync(localJavaWin)) {
        javaBinaryPath = localJavaWin;
      } else {
        const isMac = process.platform === 'darwin';
        const javaUrl = isMac ? 'http://185.221.213.43:3000/files/launchers/java21-mac.tar.gz' : 'http://185.221.213.43:3000/files/launchers/java21-win.zip';
        const archiveDest = path.join(gamePath, isMac ? 'java21.tar.gz' : 'java21.zip');
        sendStatus(10, 'Загрузка Temurin Java 21 JDK...');
        await downloadFile(javaUrl, archiveDest, (loaded, total) => {
          sendStatus(Math.floor((loaded / total) * 10) + 10, `[Загрузка Java 21] ${(loaded / 1024 / 1024).toFixed(1)} МБ`);
        });
        if (isMac) {
          fs.mkdirSync(javaDir, { recursive: true });
          const { execSync } = require('child_process');
          execSync(`tar -xzf "${archiveDest}" -C "${javaDir}"`);
          if (fs.existsSync(localJavaMac)) {
            javaBinaryPath = localJavaMac;
            execSync(`chmod +x "${javaBinaryPath}"`);
          }
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
        
        const isMac = process.platform === 'darwin';
        const isArm64 = process.arch === 'arm64' || process.arch === 'aarch64';
        
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

      // 3. Загрузка библиотек
      sendStatus(30, 'Синхронизация библиотек...');
      let downloaded = 0;
      for (const lib of allLibsToDownload) {
        if (!fs.existsSync(lib.dest) || fs.statSync(lib.dest).size < 100) {
           fs.mkdirSync(path.dirname(lib.dest), { recursive: true });
           await downloadFile(lib.url, lib.dest, null).catch(e => {
               console.log(`Failed to download ${lib.url}: ${e.message}`);
           });
        }
        downloaded++;
        if (downloaded % 10 === 0) {
            sendStatus(30 + Math.floor((downloaded / allLibsToDownload.length) * 40), `[Библиотеки] ${downloaded}/${allLibsToDownload.length}`);
        }
      }

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
        await downloadFile(`http://185.221.213.43:3000/files/launchers/neoforge-21.1.234-client.jar`, neoForgeClientJarPath, null).catch(() => {});
      }

      // 4. Формирование Classpath
      sendStatus(90, 'Построение путей и запуск FML...');
      const modulePathEntries = [];
      const jvmCpEntries = [];

      for (const lib of allLibsToDownload) {
        const p = lib.dest;
        if (!fs.existsSync(p)) continue;
        const pLower = p.toLowerCase().replace(/\\/g, '/');
        if (pLower.includes('binarypatcher') || pLower.includes('autorenamingtool') || pLower.includes('installertools')) continue;
        if (pLower.includes('asm-9.0') || pLower.includes('asm-9.1') || pLower.includes('asm-9.2') || pLower.includes('asm-9.3') || pLower.includes('asm-9.4') || pLower.includes('asm-9.5') || pLower.includes('asm-9.6')) continue;
        if (pLower.includes('gson-2.8.9')) continue;
        if (pLower.includes('neoforge-21.1.234-universal.jar')) continue;
        if (pLower.includes('client-1.21.1-20240808.144430-srg.jar')) continue;
        if (pLower.includes('client-1.21.1-20240808.144430-extra.jar')) continue;
        if (pLower.includes('minecraft-1.21.1-client.jar')) continue;
        
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
      
      const isWin = process.platform === 'win32';
      const isMac = process.platform === 'darwin';
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
          // Copy from Prism if available for offline play
          const prismAssets = path.join(os.homedir(), 'Library', 'Application Support', 'PrismLauncher', 'assets');
          if (fs.existsSync(prismAssets)) {
              require('child_process').execSync(`cp -R "${prismAssets}/" "${assetsDir}/"`);
          }
      }

      // 5. Запуск процесса Java
      sendStatus(95, `Запуск ForgeWrapper...`);
      const username = launchData?.username || 'PhonixVogel';
      const ram = launchData?.ram || 6;
      const validUuid = generateValidUuid(username);
      const macFlags = isMac ? ['-XstartOnFirstThread'] : [];
      const mainClass = 'io.github.zekerzhayard.forgewrapper.installer.Main';
      const mergeString = `jna-5.14.0.jar,jna-platform-5.14.0.jar;minecraft-1.21.1-client.jar,neoforge-21.1.234-client.jar`;

      const forgewrapperInstallerJar = path.join(libsDir, 'net', 'neoforged', 'neoforge', '21.1.234', 'neoforge-21.1.234-installer.jar');

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
        `--neoForgeVersion`, `21.1.234`,
        `--fml.neoForgeVersion`, `21.1.234`,
        `--fmlVersion`, `4.0.42`,
        `--fml.fmlVersion`, `4.0.42`,
        `--mcVersion`, `1.21.1`,
        `--fml.mcVersion`, `1.21.1`,
        `--neoFormVersion`, `20240808.144430`,
        `--fml.neoFormVersion`, `20240808.144430`,
        `--launchTarget`, `forgeclient`
      ];

      const finalArgs = [...jvmArgs, mainClass, ...gameArgs];

      logToDisk(`ЗАПУСК ИГРЫ: ${javaBinaryPath} ${finalArgs.join(' ')}`);

      fs.writeFileSync('/Users/maksim/.vozducraft/java_cmd.log', finalArgs.join('\n'));
      fs.writeFileSync(gameLogFile, `=== СТАРТ ИГРОВОГО ЛОГА [${new Date().toISOString()}] ===\n`);

      const mcProcess = require('child_process').spawn(javaBinaryPath, finalArgs, { cwd: gamePath, shell: false, env: process.env });
      mcProcess.stdout?.on('data', (data) => {
        const str = data.toString();
        logToDisk(`[GAME OUT] ${str.trim()}`);
        fs.appendFileSync(gameLogFile, str);
      });
      mcProcess.stderr?.on('data', (data) => {
        const str = data.toString();
        logToDisk(`[GAME ERR] ${str.trim()}`);
        fs.appendFileSync(gameLogFile, str);
      });
      mcProcess.on('error', (err) => {
        logToDisk(`[FATAL PROCESS ERROR] ${err.message}`);
        sendClosed(-1);
      });
      mcProcess.on('close', (code) => {
        logToDisk(`Игровой процесс завершился с кодом: ${code}`);
        sendClosed(code);
      });
      sendStatus(100, 'Игра завязана и запущена!');
    } catch (err) {
      logToDisk(`[CRITICAL ERROR] ${err.message}`);
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
