"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const dotenv_1 = __importDefault(require("dotenv"));
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
const auth_1 = __importDefault(require("./routes/auth"));
const manifest_1 = __importDefault(require("./routes/manifest"));
const admin_1 = __importDefault(require("./routes/admin"));
const launcher_1 = __importDefault(require("./routes/launcher"));
const db_1 = require("./db");
const discordBot_1 = require("./discordBot");
dotenv_1.default.config();
const app = (0, express_1.default)();
const PORT = process.env.PORT || 3000;
// Доверие reverse-proxy (Nginx / Cloudflare) для корректного протокола HTTPS и IP
app.set('trust proxy', 1);
// Глобальный подробный логгер всех входящих запросов
app.use((req, res, next) => {
    const start = Date.now();
    const timestamp = new Date().toLocaleTimeString();
    console.log(`\n[${timestamp}] 📥 HTTP ${req.method} ${req.originalUrl}`);
    if (req.body && Object.keys(req.body).length > 0) {
        const bodyCopy = { ...req.body };
        if (bodyCopy.fileBase64)
            bodyCopy.fileBase64 = `[BASE64 ${bodyCopy.fileBase64.length} chars]`;
        if (bodyCopy.base64Data)
            bodyCopy.base64Data = `[BASE64 ${bodyCopy.base64Data.length} chars]`;
        if (bodyCopy.password)
            bodyCopy.password = '***';
        console.log(`   🔹 Body:`, JSON.stringify(bodyCopy).substring(0, 300));
    }
    res.on('finish', () => {
        const duration = Date.now() - start;
        const statusEmoji = res.statusCode >= 400 ? '❌' : '✅';
        console.log(`   ${statusEmoji} Ответ: ${res.statusCode} (${duration}ms)`);
    });
    next();
});
// Middleware
app.use((0, cors_1.default)());
app.use(express_1.default.json({ limit: '1024mb' }));
app.use(express_1.default.urlencoded({ extended: true, limit: '1024mb' }));
// Статическая папка для раздачи модов, зеркал и бинарников лаунчера (с полной поддержкой CORS)
const filesDir = path_1.default.join(__dirname, '../public/files');
if (!fs_1.default.existsSync(filesDir)) {
    fs_1.default.mkdirSync(filesDir, { recursive: true });
}
app.use('/files', (req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Type');
    next();
}, express_1.default.static(filesDir));
// Статическая раздача релизных веб-интерфейсов лаунчеров и ассетов
const playerDir = path_1.default.join(__dirname, '../public/player');
const adminDir = path_1.default.join(__dirname, '../public/admin');
const assetsDir = path_1.default.join(__dirname, '../public/assets');
app.use('/player', express_1.default.static(playerDir));
app.use('/admin', express_1.default.static(adminDir));
app.use('/assets', express_1.default.static(assetsDir));
// Подключение API маршрутов
app.use('/api/v1/auth', auth_1.default);
app.use('/api/v1/manifest', manifest_1.default);
app.use('/api/v1/admin', admin_1.default);
app.use('/api/v1/launcher', launcher_1.default);
// Корневой маршрут: красивый веб-лендинг скачивания лаунчера (или JSON при API-запросе)
app.get('/', (req, res) => {
    const acceptsHtml = req.headers.accept && req.headers.accept.includes('text/html');
    if (acceptsHtml) {
        return res.send(`
<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>VozduCraft — Скачать лаунчер</title>
  <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@400;600;700;800;900&display=swap" rel="stylesheet">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; font-family: 'Outfit', sans-serif; }
    body {
      background: #070810;
      color: #f8fafc;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 20px;
      position: relative;
      overflow-x: hidden;
    }
    body::before {
      content: '';
      position: absolute;
      width: 500px;
      height: 500px;
      background: radial-gradient(circle, rgba(251, 146, 60, 0.18) 0%, transparent 70%);
      top: -100px;
      left: 10%;
      z-index: 0;
    }
    body::after {
      content: '';
      position: absolute;
      width: 500px;
      height: 500px;
      background: radial-gradient(circle, rgba(124, 58, 237, 0.2) 0%, transparent 70%);
      bottom: -100px;
      right: 10%;
      z-index: 0;
    }
    .card {
      position: relative;
      z-index: 1;
      background: rgba(18, 22, 38, 0.85);
      border: 1px solid rgba(255, 255, 255, 0.1);
      backdrop-filter: blur(20px);
      -webkit-backdrop-filter: blur(20px);
      border-radius: 24px;
      padding: 48px 36px;
      max-width: 520px;
      width: 100%;
      text-align: center;
      box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.5);
    }
    .logo-img {
      width: 80px;
      height: 80px;
      border-radius: 20px;
      object-fit: cover;
      margin-bottom: 16px;
      box-shadow: 0 10px 30px rgba(56, 189, 248, 0.4);
      border: 2px solid rgba(255, 255, 255, 0.2);
    }
    .logo {
      font-size: 38px;
      font-weight: 900;
      letter-spacing: -1px;
      background: linear-gradient(135deg, #fb923c, #f43f5e, #a855f7);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      margin-bottom: 8px;
    }
    .subtitle {
      color: #94a3b8;
      font-size: 15px;
      line-height: 1.5;
      margin-bottom: 32px;
    }
    .btn-group {
      display: flex;
      flex-direction: column;
      gap: 14px;
      margin-bottom: 24px;
    }
    .btn {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 12px;
      padding: 16px 24px;
      border-radius: 14px;
      font-size: 16px;
      font-weight: 700;
      text-decoration: none;
      transition: all 0.25s ease;
      cursor: pointer;
    }
    .btn-win {
      background: linear-gradient(135deg, #0284c7, #0369a1);
      color: #fff;
      box-shadow: 0 8px 20px rgba(2, 132, 199, 0.3);
    }
    .btn-win:hover {
      transform: translateY(-2px);
      box-shadow: 0 12px 28px rgba(2, 132, 199, 0.45);
      background: linear-gradient(135deg, #38bdf8, #0284c7);
    }
    .btn-mac {
      background: rgba(255, 255, 255, 0.08);
      color: #f8fafc;
      border: 1px solid rgba(255, 255, 255, 0.15);
    }
    .btn-mac:hover {
      background: rgba(255, 255, 255, 0.15);
      transform: translateY(-2px);
    }
    .badge {
      display: inline-block;
      font-size: 13px;
      font-weight: 600;
      padding: 6px 14px;
      border-radius: 20px;
      background: rgba(16, 185, 129, 0.15);
      color: #34d399;
      border: 1px solid rgba(16, 185, 129, 0.3);
      margin-bottom: 20px;
    }
    .footer-links {
      font-size: 13px;
      color: #64748b;
      margin-top: 20px;
    }
    .footer-links a {
      color: #94a3b8;
      text-decoration: none;
      transition: color 0.2s;
    }
    .footer-links a:hover { color: #38bdf8; }
  </style>
</head>
<body>
  <div class="card">
    <div class="badge">🟢 Сервер онлайн • NeoForge 1.21.1 • Лаунчер v3.4.0</div>
    <div><img src="/assets/logo.jpg" alt="VozduCraft Logo" class="logo-img" onerror="this.style.display='none'"></div>
    <div class="logo">VOZDUCRAFT</div>
    <div class="subtitle">Официальный игровой лаунчер с автоматической синхронизацией модов и Java</div>
    
    <div class="btn-group">
      <a href="/files/launchers/VozduCraft-Windows-Setup.exe" class="btn btn-win">
        🪟 Скачать для Windows (.exe Установщик)
      </a>
      <a href="/files/launchers/VozduCraft-Windows.zip" class="btn btn-mac" style="font-size: 14px; padding: 12px 20px;">
        📦 Скачать для Windows (.zip Портативная версия)
      </a>
      <a href="/files/launchers/VozduCraft-macOS-Setup.dmg" class="btn btn-mac">
        🍏 Скачать для macOS (.dmg)
      </a>
      <div style="font-size: 12px; color: #94a3b8; margin-top: -4px; line-height: 1.4;">
        ℹ️ Если macOS пишет <i>«повреждено»</i>: откройте через <b>Правый клик ➔ «Открыть»</b> или выполните в Терминале: <br>
        <code style="color: #38bdf8; background: rgba(0,0,0,0.4); padding: 2px 6px; border-radius: 4px; font-size: 11px; display: inline-block; margin-top: 4px;">xattr -cr /Applications/VozduCraft.app</code>
      </div>
    </div>

    <div class="footer-links">
      <a href="/admin/">Панель администратора</a>
    </div>
  </div>
</body>
</html>
    `);
    }
    res.json({
        status: 'ONLINE',
        service: 'VozduCraft Launcher Backend API',
        version: '3.4.0',
        downloads: {
            windows: 'http://185.221.213.43:3000/files/launchers/VozduCraft-Windows-Setup.exe',
            macos: 'http://185.221.213.43:3000/files/launchers/VozduCraft-macOS-Setup.dmg'
        }
    });
});
// Глобальные обработчики для предотвращения падения сервера при ошибках сети
process.on('unhandledRejection', (reason) => {
    console.error('[SERVER SAFETY] Unhandled Rejection перехвачен:', reason);
});
process.on('uncaughtException', (err) => {
    console.error('[SERVER SAFETY] Uncaught Exception перехвачен:', err);
});
// Запуск сервера
async function startServer() {
    await (0, db_1.getDb)(); // Инициализация SQLite базы
    app.listen(PORT, () => {
        console.log(`===================================================`);
        console.log(`🚀 VozduCraft Backend API запущен на порту ${PORT}`);
        console.log(`🌐 HTTP API: http://localhost:${PORT}`);
        console.log(`🎮 Player Launcher: http://localhost:${PORT}/player/`);
        console.log(`⚙️ Admin Launcher: http://localhost:${PORT}/admin/`);
        console.log(`===================================================`);
        // Фоновый запуск Discord-бота (не блокирует веб-сервер)
        (0, discordBot_1.initDiscordBot)().catch((err) => {
            console.warn('[DISCORD BOT] Фоновая ошибка инициализации:', err.message);
        });
    });
}
startServer();
