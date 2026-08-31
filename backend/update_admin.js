import bcrypt from 'bcryptjs';
import { getDb } from './dist/db.js';

async function run() {
  const db = await getDb();

  // 1. Удаляем всех прошлых админов, включая старый аккаунт 'Admin'
  await db.run("DELETE FROM users WHERE role = 'ADMIN' AND LOWER(username) != 'vozduhan'");
  await db.run("DELETE FROM users WHERE LOWER(username) = 'admin'");

  // 2. Хешируем новый пароль для VozduHAN
  const passHash = await bcrypt.hash('rthcddsfj31231', 10);

  // 3. Создаем или обновляем аккаунт VozduHAN
  const existing = await db.get("SELECT id FROM users WHERE LOWER(username) = 'vozduhan'");
  if (existing) {
    await db.run("UPDATE users SET username = 'VozduHAN', password_hash = ?, role = 'ADMIN' WHERE id = ?", [passHash, existing.id]);
  } else {
    await db.run("INSERT INTO users (username, password_hash, role, last_hwid) VALUES ('VozduHAN', ?, 'ADMIN', 'ADMIN-HWID-MASTER')", [passHash]);
  }

  const users = await db.all("SELECT id, username, role FROM users");
  console.log('[SUCCESS] Обновлены пользователи в БД:', users);
  process.exit(0);
}

run();
