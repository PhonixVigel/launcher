const fs = require('fs');
const path = require('path');
const file = path.join(__dirname, 'player-launcher', 'main.js');
let content = fs.readFileSync(file, 'utf8');

// Replace the argument builder
const startMark = 'const jvmArgs = [';
const endMark = 'fs.writeFileSync(gameLogFile, `=== СТАРТ ИГРОВОГО ЛОГА [${new Date().toISOString()}] ===\\n`);\n      } catch (_) {}';

const startIdx = content.indexOf(startMark);
const endIdx = content.indexOf(endMark) + endMark.length;

if (startIdx !== -1 && endIdx !== -1) {
    const replacement = `// Загрузка готового профиля NeoForge
      const profilePath = path.join(__dirname, 'meta', 'launch-profile.json');
      let profile;
      try {
        profile = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
      } catch (err) {
        logToDisk('[LAUNCH ERROR] Не удалось прочитать launch-profile.json: ' + err.message);
        throw err;
      }

      // Подготовка контекста переменных
      const launchContext = {
        auth_player_name: username,
        auth_uuid: validUuid,
        auth_access_token: \`VOZDUCRAFT-TOKEN-\${Date.now()}\`,
        game_directory: gamePath,
        assets_root: path.join(gamePath, 'assets'),
        natives_directory: path.join(gamePath, 'natives'),
        max_memory: String(ram * 1024)
      };

      try {
        fs.writeFileSync(gameLogFile, \`=== СТАРТ ИГРОВОГО ЛОГА [\${new Date().toISOString()}] ===\\n\`);
      } catch (_) {}`;
      
    content = content.substring(0, startIdx) + replacement + content.substring(endIdx);
    fs.writeFileSync(file, content, 'utf8');
    console.log('Block 1 replaced successfully.');
} else {
    console.log('Block 1 marks not found.');
}
