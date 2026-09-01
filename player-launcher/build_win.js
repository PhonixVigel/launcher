const packager = require('electron-packager');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

(async () => {
  console.log('🚀 [1/3] Запуск сборщика Electron для Windows x64...');
  try {
    const appPaths = await packager({
      dir: __dirname,
      name: 'VozduCraft',
      platform: 'win32',
      arch: 'x64',
      out: path.join(__dirname, '..', 'dist_win'),
      overwrite: true,
      asar: true,
      prune: true
    });
    console.log('✅ [2/3] Сборка Windows завершена:', appPaths);
    
    // Создаем ZIP архив для раздачи игрокам
    console.log('📦 [3/3] Создание архива VozduCraft-Windows.zip...');
    const outDir = path.join(__dirname, '..', 'dist_win');
    execSync(`cd "${outDir}" && zip -r -9 VozduCraft-Windows.zip VozduCraft-win32-x64`);
    console.log('🎉 ГОТОВО: Архив создан в dist_win/VozduCraft-Windows.zip');
    
    // Копируем на рабочий стол и в public файлы бэкенда
    fs.copyFileSync(
      path.join(outDir, 'VozduCraft-Windows.zip'),
      path.join('/Users/maksimzaika/Desktop', 'VozduCraft-Windows.zip')
    );
    fs.copyFileSync(
      path.join(outDir, 'VozduCraft-Windows.zip'),
      path.join(__dirname, '..', 'backend', 'public', 'files', 'launchers', 'VozduCraft-Windows-3.0.0.zip')
    );
    console.log('✨ Скопировано на Рабочий стол и в backend/public/files/launchers/ !');
    process.exit(0);
  } catch (err) {
    console.error('❌ Ошибка сборки:', err);
    process.exit(1);
  }
})();

