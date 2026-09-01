const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

console.log('🚀 [1/4] Поиск кэша Electron Windows x64...');
const cacheBase = path.join(process.env.HOME, 'Library/Caches/electron');
let electronZip = null;

function findZip(dir) {
  if (!fs.existsSync(dir)) return;
  const files = fs.readdirSync(dir);
  for (const f of files) {
    const full = path.join(dir, f);
    const stat = fs.statSync(full);
    if (stat.isDirectory()) {
      findZip(full);
    } else if (f === 'electron-v29.1.0-win32-x64.zip') {
      electronZip = full;
    }
  }
}

findZip(cacheBase);

if (!electronZip) {
  console.log('📥 Кэш не найден, скачивание electron-v29.1.0-win32-x64.zip...');
  const tmpZip = '/tmp/electron-v29.1.0-win32-x64.zip';
  execSync(`curl -L -o "${tmpZip}" "https://github.com/electron/electron/releases/download/v29.1.0/electron-v29.1.0-win32-x64.zip"`);
  electronZip = tmpZip;
}

console.log('📦 [2/4] Распаковка базового бинарника Windows:', electronZip);
const distWin = path.join(__dirname, 'dist_win');
const winAppDir = path.join(distWin, 'VozduCraft-win32-x64');

if (fs.existsSync(winAppDir)) {
  fs.rmSync(winAppDir, { recursive: true, force: true });
}
fs.mkdirSync(winAppDir, { recursive: true });

execSync(`unzip -q -o "${electronZip}" -d "${winAppDir}"`);

// Переименовываем electron.exe в VozduCraft.exe
const oldExe = path.join(winAppDir, 'electron.exe');
const newExe = path.join(winAppDir, 'VozduCraft.exe');
if (fs.existsSync(oldExe)) {
  fs.renameSync(oldExe, newExe);
}

console.log('✨ [3/4] Упаковка ресурсов лаунчера (UI, логика, ассеты, манифесты)...');
const resourcesApp = path.join(winAppDir, 'resources', 'app');
fs.mkdirSync(resourcesApp, { recursive: true });

const srcDir = path.join(__dirname, 'player-launcher');
const filesToCopy = ['index.html', 'app.js', 'main.js', 'styles.css', 'package.json'];

for (const f of filesToCopy) {
  const s = path.join(srcDir, f);
  if (fs.existsSync(s)) {
    fs.copyFileSync(s, path.join(resourcesApp, f));
  }
}

// Копируем assets и meta
execSync(`cp -r "${path.join(srcDir, 'assets')}" "${resourcesApp}/" 2>/dev/null || true`);
execSync(`cp -r "${path.join(srcDir, 'meta')}" "${resourcesApp}/" 2>/dev/null || true`);

// Оптимизация размера (удаление неиспользуемых языковых пакетов и тяжелых html-лицензий)
const localesDir = path.join(winAppDir, 'locales');
if (fs.existsSync(localesDir)) {
  for (const f of fs.readdirSync(localesDir)) {
    if (f !== 'ru.pak' && f !== 'en-US.pak') {
      fs.unlinkSync(path.join(localesDir, f));
    }
  }
}
const licHtml = path.join(winAppDir, 'LICENSES.chromium.html');
if (fs.existsSync(licHtml)) fs.unlinkSync(licHtml);

console.log('📦 [4/4] Создание ультра-сжатого ZIP архива VozduCraft-Windows.zip...');
const zipOutput = path.join(distWin, 'VozduCraft-Windows.zip');
if (fs.existsSync(zipOutput)) fs.unlinkSync(zipOutput);

execSync(`cd "${distWin}" && zip -r -9 "${zipOutput}" VozduCraft-win32-x64`);

const desktopZip = path.join(process.env.HOME, 'Desktop', 'VozduCraft-Windows.zip');
const backendZip = path.join(__dirname, 'backend', 'public', 'files', 'launchers', 'VozduCraft-Windows-3.0.0.zip');

fs.copyFileSync(zipOutput, desktopZip);
fs.copyFileSync(zipOutput, backendZip);

console.log('🎉 УСПЕШНО СОБРАНО!');
console.log('👉 Рабочий стол:', desktopZip);
console.log('👉 Сервер загрузок:', backendZip);
