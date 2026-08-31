import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import authRoutes from './routes/auth';
import manifestRoutes from './routes/manifest';
import adminRoutes from './routes/admin';
import launcherRoutes from './routes/launcher';
import { getDb } from './db';
import { initDiscordBot } from './discordBot';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Глобальный подробный логгер всех входящих запросов
app.use((req, res, next) => {
  const start = Date.now();
  const timestamp = new Date().toLocaleTimeString();
  console.log(`\n[${timestamp}] 📥 HTTP ${req.method} ${req.originalUrl}`);

  if (req.body && Object.keys(req.body).length > 0) {
    const bodyCopy = { ...req.body };
    if (bodyCopy.fileBase64) bodyCopy.fileBase64 = `[BASE64 ${bodyCopy.fileBase64.length} chars]`;
    if (bodyCopy.password) bodyCopy.password = '***';
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
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Статическая папка для раздачи модов, зеркал и бинарников лаунчера
const filesDir = path.join(__dirname, '../public/files');
if (!fs.existsSync(filesDir)) {
  fs.mkdirSync(filesDir, { recursive: true });
}
app.use('/files', express.static(filesDir));

// Статическая раздача релизных веб-интерфейсов лаунчеров
const playerDir = path.join(__dirname, '../public/player');
const adminDir = path.join(__dirname, '../public/admin');
app.use('/player', express.static(playerDir));
app.use('/admin', express.static(adminDir));

// Подключение API маршрутов
app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/manifest', manifestRoutes);
app.use('/api/v1/admin', adminRoutes);
app.use('/api/v1/launcher', launcherRoutes);

// Корневой проверщик статуса API
app.get('/', (req, res) => {
  res.json({
    status: 'ONLINE',
    service: 'VozduCraft Launcher Backend API',
    version: '1.0.0',
    links: {
      playerLauncher: 'http://185.221.213.43:3000/player/',
      adminLauncher: 'http://185.221.213.43:3000/admin/',
      serverAuthPluginJar: 'http://185.221.213.43:3000/files/vozducraft-auth-plugin.jar'
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
  await getDb(); // Инициализация SQLite базы

  app.listen(PORT, () => {
    console.log(`===================================================`);
    console.log(`🚀 VozduCraft Backend API запущен на порту ${PORT}`);
    console.log(`🌐 HTTP API: http://localhost:${PORT}`);
    console.log(`🎮 Player Launcher: http://localhost:${PORT}/player/`);
    console.log(`⚙️ Admin Launcher: http://localhost:${PORT}/admin/`);
    console.log(`===================================================`);

    // Фоновый запуск Discord-бота (не блокирует веб-сервер)
    initDiscordBot().catch((err) => {
      console.warn('[DISCORD BOT] Фоновая ошибка инициализации:', err.message);
    });
  });
}

startServer();
