const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

class LaunchEngine {
  /**
   * Запуск игры через заранее подготовленный launch-profile.json
   * @param {Object} profile - JSON объект скачанный с бэкенда (launch-profile.json)
   * @param {Object} context - Данные игрока и путей
   * @param {String} javaPath - Путь к бинарнику Java
   * @param {Function} logger - Функция для записи логов игры
   */
  static launch(profile, context, javaPath, logger = console.log) {
    const cpSeparator = process.platform === 'win32' ? ';' : ':';
    
    // Функция для подмены плейсхолдеров
    const replaceTokens = (str) => {
      return str.replace(/\${(.*?)}/g, (match, token) => {
        if (token === 'cp_separator') return cpSeparator;
        return context[token] !== undefined ? context[token] : match;
      });
    };

    const finalJvmArgs = profile.jvmArgs.map(replaceTokens);
    const finalGameArgs = profile.gameArgs.map(replaceTokens);
    
    const spawnArgs = [
      ...finalJvmArgs,
      profile.mainClass,
      ...finalGameArgs
    ];

    logger('[Launch] Формирование команды завершено. Запускаем JVM...');

    if (!fs.existsSync(context.game_directory)) {
      fs.mkdirSync(context.game_directory, { recursive: true });
    }

    const gameProcess = spawn(javaPath, spawnArgs, {
      cwd: context.game_directory,
      detached: true, 
      stdio: ['ignore', 'pipe', 'pipe']
    });

    gameProcess.stdout.on('data', (d) => logger(`[GAME] ${d.toString().trim()}`));
    gameProcess.stderr.on('data', (d) => logger(`[GAME ERROR] ${d.toString().trim()}`));

    gameProcess.unref(); 
    return gameProcess;
  }
}

module.exports = LaunchEngine;
