import sqlite3 from 'sqlite3';
import { open, Database } from 'sqlite';
import path from 'path';
import crypto from 'crypto';

let dbInstance: Database | null = null;

export async function getDb(): Promise<Database> {
  if (dbInstance) return dbInstance;

  const dbPath = process.env.DATABASE_PATH || path.join(__dirname, '../vozducraft.db');
  
  dbInstance = await open({
    filename: dbPath,
    driver: sqlite3.Database
  });

  await initDbSchema(dbInstance);
  return dbInstance;
}

async function initDbSchema(db: Database) {
  // 1. Таблица пользователей и модераторов
  await db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'PLAYER',
      last_hwid TEXT,
      last_ip TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // 1.1. Таблица запросов авторизации через Discord бота
  await db.exec(`
    CREATE TABLE IF NOT EXISTS discord_auth_requests (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      discord_id TEXT,
      ip_address TEXT,
      status TEXT DEFAULT 'PENDING', -- PENDING, APPROVED, REJECTED, EXPIRED
      token TEXT,
      expires_at DATETIME NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // 1.2. Таблица системных настроек (Токены, Discord, Интеграции)
  await db.exec(`
    CREATE TABLE IF NOT EXISTS system_settings (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // 2. Таблица серверов (Мультисерверность и конфигурация сборок)
  await db.exec(`
    CREATE TABLE IF NOT EXISTS servers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      server_ip TEXT NOT NULL,
      server_port INTEGER NOT NULL DEFAULT 25565,
      minecraft_version TEXT NOT NULL DEFAULT '1.21.1',
      neoforge_version TEXT NOT NULL DEFAULT '21.1.248',
      modloader TEXT NOT NULL DEFAULT 'neoforge',
      modloader_version TEXT NOT NULL DEFAULT '21.1.248',
      java_version INTEGER DEFAULT 21,
      jvm_flags TEXT,
      min_ram_gb INTEGER DEFAULT 4,
      recommended_ram_gb INTEGER DEFAULT 6,
      game_args TEXT,
      auto_join_server INTEGER DEFAULT 1,
      description TEXT,
      icon_url TEXT,
      is_default INTEGER DEFAULT 0,
      is_active INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // 3. Таблица банов (Ник, HWID, IP, Пул IP)
  await db.exec(`
    CREATE TABLE IF NOT EXISTS bans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ban_type TEXT NOT NULL, -- 'NICK', 'HWID', 'IP', 'IP_RANGE'
      target_value TEXT NOT NULL,
      reason TEXT DEFAULT 'Нарушение правил проекта',
      banned_by TEXT DEFAULT 'ADMIN',
      expires_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // 4. Таблица сессий
  await db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL,
      access_token TEXT UNIQUE NOT NULL,
      hwid TEXT NOT NULL,
      ip_address TEXT,
      is_admin_bypass INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      expires_at DATETIME NOT NULL
    );
  `);

  // 5. Таблица файлов сборок модов (с привязкой к server_id)
  await db.exec(`
    CREATE TABLE IF NOT EXISTS modpack_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      server_id INTEGER NOT NULL DEFAULT 1,
      filepath TEXT NOT NULL,
      sha256 TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      is_optional INTEGER DEFAULT 0,
      mod_name TEXT,
      mod_description TEXT,
      download_url TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // 6. Таблица релизов и патчей лаунчера
  await db.exec(`
    CREATE TABLE IF NOT EXISTS launcher_releases (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      version TEXT UNIQUE NOT NULL,
      release_notes TEXT,
      mac_download_url TEXT,
      win_download_url TEXT,
      linux_download_url TEXT,
      is_mandatory INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // 6.1. Таблица одноразовых сессионных билетов запуска игры официальным лаунчером
  await db.exec(`
    CREATE TABLE IF NOT EXISTS launcher_tickets (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      ip_address TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      expires_at DATETIME NOT NULL,
      used INTEGER DEFAULT 0
    );
  `);

  // 6.2. Таблица разрешений на вход с мобильных устройств (PojavLauncher / телефоны)
  await db.exec(`
    CREATE TABLE IF NOT EXISTS launcher_bypasses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      reason TEXT DEFAULT 'Мобильный клиент (телефон)',
      created_by TEXT DEFAULT 'ADMIN',
      expires_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // 6.3. Таблица дебаг-логов лаунчеров (хранение 3 дня)
  await db.exec(`
    CREATE TABLE IF NOT EXISTS launcher_debug_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL,
      os TEXT,
      launcher_version TEXT,
      event_type TEXT DEFAULT 'INFO',
      log_content TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // 6.4. Таблица краш-репортов Minecraft (только /crash-reports, хранение 3 дня)
  await db.exec(`
    CREATE TABLE IF NOT EXISTS launcher_crash_reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL,
      os TEXT,
      server_id INTEGER DEFAULT 1,
      crash_filename TEXT NOT NULL,
      report_content TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Автоматическая очистка старых логов (TTL 3 дня)
  try {
    await db.run("DELETE FROM launcher_debug_logs WHERE created_at < datetime('now', '-3 days')");
    await db.run("DELETE FROM launcher_crash_reports WHERE created_at < datetime('now', '-3 days')");
  } catch (_) {}

  // 7. Журнал аудита действий (для админки и будущей панели модераторов)
  await db.exec(`
    CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      actor_username TEXT NOT NULL,
      actor_role TEXT NOT NULL DEFAULT 'ADMIN',
      action_type TEXT NOT NULL,
      target TEXT,
      details TEXT,
      ip_address TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // 8. Статистика входов и подключений
  await db.exec(`
    CREATE TABLE IF NOT EXISTS connection_stats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT,
      server_id INTEGER DEFAULT 1,
      event_type TEXT NOT NULL,
      details TEXT,
      ip_address TEXT,
      hwid TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // 9. Системные настройки проекта
  await db.exec(`
    CREATE TABLE IF NOT EXISTS project_config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  // 10. Отказоустойчивые Зеркала API и Гео-ноды (Failover & Geo-Mirrors)
  await db.exec(`
    CREATE TABLE IF NOT EXISTS api_mirrors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      url TEXT UNIQUE NOT NULL,
      region TEXT DEFAULT 'Global',
      is_primary INTEGER DEFAULT 0,
      is_active INTEGER DEFAULT 1,
      priority INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Миграции столбцов
  const migrations = [
    'ALTER TABLE users ADD COLUMN last_ip TEXT;',
    'ALTER TABLE users ADD COLUMN last_hwid TEXT;',
    'ALTER TABLE sessions ADD COLUMN ip_address TEXT;',
    'ALTER TABLE sessions ADD COLUMN is_admin_bypass INTEGER DEFAULT 0;',
    'ALTER TABLE modpack_files ADD COLUMN server_id INTEGER NOT NULL DEFAULT 1;',
    'ALTER TABLE modpack_files ADD COLUMN download_url TEXT;',
    'ALTER TABLE connection_stats ADD COLUMN server_id INTEGER DEFAULT 1;',
    'ALTER TABLE connection_stats ADD COLUMN ip_address TEXT;',
    'ALTER TABLE connection_stats ADD COLUMN hwid TEXT;',
    'ALTER TABLE servers ADD COLUMN modloader TEXT NOT NULL DEFAULT \'neoforge\';',
    'ALTER TABLE servers ADD COLUMN modloader_version TEXT NOT NULL DEFAULT \'21.1.248\';',
    'ALTER TABLE servers ADD COLUMN java_version INTEGER DEFAULT 21;',
    'ALTER TABLE servers ADD COLUMN jvm_flags TEXT;',
    'ALTER TABLE servers ADD COLUMN min_ram_gb INTEGER DEFAULT 4;',
    'ALTER TABLE servers ADD COLUMN recommended_ram_gb INTEGER DEFAULT 6;',
    'ALTER TABLE servers ADD COLUMN game_args TEXT;',
    'ALTER TABLE servers ADD COLUMN auto_join_server INTEGER DEFAULT 1;',
    'CREATE INDEX IF NOT EXISTS idx_modpack_server ON modpack_files(server_id);',
    'CREATE INDEX IF NOT EXISTS idx_bans_target ON bans(ban_type, target_value);'
  ];

  for (const query of migrations) {
    try {
      await db.exec(query);
    } catch (e) {
      // Игнорируем дублирующиеся столбцы
    }
  }

  // Сид начальных зеркал API при первом запуске
  const existingMirrors = await db.get('SELECT COUNT(*) as count FROM api_mirrors');
  if (!existingMirrors || existingMirrors.count === 0) {
    await db.run(`
      INSERT INTO api_mirrors (name, url, region, is_primary, is_active, priority)
      VALUES 
        ('Основной узел (Localhost)', 'http://localhost:3000/api/v1', 'Локальный', 1, 1, 100),
        ('Резервный европейский узел #1', 'http://89.248.236.145:3000/api/v1', 'Европа (Германия)', 0, 1, 90),
        ('Запасной гео-узел #2 (Failover)', 'http://185.221.213.43:3000/api/v1', 'Россия / СНГ', 0, 1, 80)
    `);
  }

  // Обновление или заполнение серверов по умолчанию с реальным IP и портом
  const server1 = await db.get('SELECT id FROM servers WHERE id = 1');
  if (server1) {
    await db.run(`
      UPDATE servers 
      SET server_ip = '89.248.236.145', server_port = 27123, modloader = 'neoforge', modloader_version = '21.1.248', minecraft_version = '1.21.1'
      WHERE id = 1
    `);
  } else {
    await db.run(`
      INSERT INTO servers (name, server_ip, server_port, minecraft_version, neoforge_version, modloader, modloader_version, description, is_default, is_active)
      VALUES 
        ('VozduCraft Season #2', '89.248.236.145', 27123, '1.21.1', '21.1.248', 'neoforge', '21.1.248', 'Официальный сервер выживания VozduCraft Season #2 (170+ модов)', 1, 1),
        ('VozduCraft Tech & Create', '185.221.213.43', 25566, '1.21.1', '21.1.248', 'neoforge', '21.1.248', 'Индустриальный сервер с механизмами Create, авиацией и поездами', 0, 1)
    `);
  }

  // Обязательная регистрация релиза 3.2.6
  const r326 = await db.get("SELECT id FROM launcher_releases WHERE version = '3.2.6'");
  if (!r326) {
    await db.run(`
      INSERT INTO launcher_releases (version, release_notes, mac_download_url, win_download_url, is_mandatory, created_at)
      VALUES 
        ('3.2.6', 'Финальный релиз v3.2.6: автоматическое создание постоянного ярлыка на Рабочем столе и надежное обновление', 'http://185.221.213.43:3000/files/launchers/VozduCraft-macOS-Setup.dmg', 'http://185.221.213.43:3000/files/launchers/VozduCraft-Windows-Setup.exe', 1, CURRENT_TIMESTAMP)
    `);
  }
  await db.run("UPDATE project_config SET value = '3.2.6' WHERE key = 'launcher_version'");
  // Удаляем серверный мод Vanishmod из клиентского манифеста (вызывает краш в одиночной игре)
  await db.run("DELETE FROM modpack_files WHERE filepath LIKE '%vanishmod%' OR filepath LIKE '%Vanishmod%'");

  // Системные конфиги
  const defaultConfigs: Record<string, string> = {
    'launcher_version': '3.2.6',
    'neoforge_version': '21.1.248',
    'minecraft_version': '1.21.1',
    'jvm_flags': '-XX:+UnlockExperimentalVMOptions -XX:+UseG1GC -XX:G1NewSizePercent=20 -XX:G1ReservePercent=20 -XX:MaxGCPauseMillis=50 -XX:G1HeapRegionSize=32M -XX:+DisableExplicitGC -XX:+AlwaysPreTouch -XX:+PerfDisableSharedMem',
    'download_mirrors_json': JSON.stringify([
      'http://185.221.213.43:3000/files/',
      'https://cloud-api.yandex.net/v1/disk/public/resources/download?public_key=VOZDUCRAFT_MIRROR'
    ])
  };

  for (const [key, val] of Object.entries(defaultConfigs)) {
    const existing = await db.get('SELECT key FROM project_config WHERE key = ?', [key]);
    if (!existing) {
      await db.run('INSERT INTO project_config (key, value) VALUES (?, ?)', [key, val]);
    }
  }

  // Создание администратора VozduHAN (если нет)
  const adminUser = await db.get('SELECT id FROM users WHERE username = ?', ['VozduHAN']);
  if (!adminUser) {
    // Пароль по умолчанию: admin123
    const salt = 'vozducraft_salt';
    const hash = crypto.createHash('sha256').update('admin123' + salt).digest('hex');
    await db.run(`
      INSERT INTO users (username, password_hash, role)
      VALUES (?, ?, 'ADMIN')
    `, ['VozduHAN', hash]);
  }

  console.log('[DB] База данных VozduCraft полностью инициализирована: мультисерверность, bans (NICK, HWID, IP, IP_RANGE), releases, audit_logs.');
}
