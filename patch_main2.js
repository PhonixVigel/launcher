const fs = require('fs');
const path = require('path');
const file = path.join(__dirname, 'player-launcher', 'main.js');
let content = fs.readFileSync(file, 'utf8');

const oldSpawnBlock = `const mcProcess = require('child_process').spawn(javaBinaryPath, finalArgs, { cwd: gamePath, shell: false, env: process.env });`;
const newSpawnBlock = `// Запуск игры через новый движок LaunchEngine
      const mcProcess = LaunchEngine.launch(profile, launchContext, javaBinaryPath, logToDisk);`;

if (content.includes(oldSpawnBlock)) {
    content = content.replace(oldSpawnBlock, newSpawnBlock);
    fs.writeFileSync(file, content, 'utf8');
    console.log('Block 2 replaced successfully.');
} else {
    console.log('Block 2 not found.');
}
