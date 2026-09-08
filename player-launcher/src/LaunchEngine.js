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
      ...(process.platform === 'darwin' ? ['-XstartOnFirstThread'] : []),
      profile.mainClass,
      ...finalGameArgs
    ];

    if (!fs.existsSync(context.game_directory)) {
      fs.mkdirSync(context.game_directory, { recursive: true });
    }

    // Для обхода лимита длины командной строки Windows (32KB / ENAMETOOLONG)
    // используем официальный механизм аргументов Java (@argument-file)
    let executionArgs = spawnArgs;
    if (process.platform === 'win32' || spawnArgs.join(' ').length > 25000) {
      const argsFile = path.join(context.game_directory, 'jvm_args.txt');
      const fileContent = spawnArgs.map(arg => {
        if (arg.includes(' ') || arg.includes('"')) {
          return `"${arg.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
        }
        return arg;
      }).join('\n');
      
      fs.writeFileSync(argsFile, fileContent, 'utf8');
      executionArgs = [`@${argsFile}`];
      logger(`[Launch] Создан файл аргументов (@${argsFile}) для надежного запуска на Windows без лимита командной строки`);
    } else {
      logger('[Launch] Формирование команды завершено. Запускаем JVM...\nARGS: ' + JSON.stringify(spawnArgs, null, 2));
    }

    const gameProcess = spawn(javaPath, executionArgs, {
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
