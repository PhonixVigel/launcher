const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawn } = require('child_process');

class SystemManager {
  static getGameDirectory() {
    const home = os.homedir();
    if (process.platform === 'win32') {
      return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), '.vozducraft');
    } else if (process.platform === 'darwin') {
      return path.join(home, 'Library', 'Application Support', 'VozduCraft');
    } else {
      return path.join(home, '.vozducraft');
    }
  }

  static getJavaPath(javaVersion = '21') {
    const gameDir = this.getGameDirectory();
    const javaBin = process.platform === 'win32' ? 'java.exe' : 'java';
    return path.join(gameDir, 'jre', javaVersion, 'bin', javaBin);
  }

  static async startXrayProxy(resourcesPath) {
    const binName = process.platform === 'win32' ? 'xray-win.exe' : 'xray-mac';
    const binDir = resourcesPath.includes('app.asar') 
      ? path.join(path.dirname(resourcesPath), 'bin') 
      : path.join(__dirname, '..', 'bin');
      
    const xrayPath = path.join(binDir, binName);

    if (!fs.existsSync(xrayPath)) {
      console.warn(`[Proxy] Исполняемый файл Xray не найден по пути: ${xrayPath}`);
      return null;
    }

    if (process.platform !== 'win32') {
      fs.chmodSync(xrayPath, '755');
    }

    console.log(`[Proxy] Запуск Xray Proxy на 127.0.0.1:1080...`);
    const xrayProcess = spawn(xrayPath, ['-c', path.join(binDir, 'config.json')], {
      cwd: binDir,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    xrayProcess.stdout.on('data', (data) => console.log(`[Xray] ${data.toString().trim()}`));
    xrayProcess.stderr.on('data', (data) => console.error(`[Xray ERROR] ${data.toString().trim()}`));

    return xrayProcess;
  }
}

module.exports = SystemManager;
