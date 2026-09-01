const { packager } = require('@electron/packager');
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

const keepAlive = setInterval(() => {}, 1000);

async function main() {
  console.log('🚀 [1/3] Запуск сборки Electron Windows x64...');
  try {
    const outDir = path.join(__dirname, '..', 'dist_win');
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

    const appPaths = await packager({
      dir: __dirname,
      name: 'VozduCraft',
      platform: 'win32',
      arch: 'x64',
      out: outDir,
      overwrite: true,
      asar: true,
      prune: false
    });

    console.log('✅ [2/3] Сборка Windows завершена:', appPaths);
    console.log('📦 [3/3] Создание архива VozduCraft-Windows.zip...');
    
    const zipPath = path.join(outDir, 'VozduCraft-Windows.zip');
    execSync(`cd "${outDir}" && zip -r -9 "${zipPath}" VozduCraft-win32-x64`);
    console.log('🎉 ГОТОВО: Архив создан:', zipPath);

    fs.copyFileSync(zipPath, path.join('/Users/maksimzaika/Desktop', 'VozduCraft-Windows.zip'));
    fs.copyFileSync(zipPath, path.join(__dirname, '..', 'backend', 'public', 'files', 'launchers', 'VozduCraft-Windows-3.0.0.zip'));
    console.log('✨ Скопировано на Рабочий стол и в backend!');
  } catch (err) {
    console.error('❌ Ошибка сборки:', err);
  } finally {
    clearInterval(keepAlive);
  }
}

main();
