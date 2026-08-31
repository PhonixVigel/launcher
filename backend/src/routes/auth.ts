import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { getDb } from '../db';

const router = Router();
const JWT_SECRET = process.env.JWT_SECRET || 'vozducraft_secret_key_2026_super_secure';

// 1. Регистрация нового игрока
router.post('/register', async (req: Request, res: Response) => {
  try {
    const { username, password, hwid } = req.body;

    if (!username || !password || !hwid) {
      return res.status(400).json({ error: 'Заполните все обязательные поля (логин, пароль, HWID)' });
    }

    if (username.length < 3 || username.length > 16) {
      return res.status(400).json({ error: 'Никнейм должен быть от 3 до 16 символов' });
    }

    const db = await getDb();

    // Проверка бана HWID
    let isBanned = null;
    try {
      isBanned = await db.get('SELECT id, reason FROM banned_hwids WHERE hwid = ? OR LOWER(username) = LOWER(?)', [hwid, username]);
    } catch (e) {
      isBanned = await db.get('SELECT id, reason FROM banned_hwids WHERE hwid = ?', [hwid]);
    }

    if (isBanned) {
      await db.run(
        'INSERT INTO connection_stats (username, event_type, details) VALUES (?, ?, ?)',
        [username, 'FAILED_HWID_BAN', `Попытка регистрации с забаненного ПК/Ника: ${isBanned.reason}`]
      );
      return res.status(403).json({ error: `Ваше устройство или ник заблокированы. Причина: ${isBanned.reason}` });
    }

    // Проверка уникальности Ника
    const existingUser = await db.get('SELECT id FROM users WHERE LOWER(username) = LOWER(?)', [username]);
    if (existingUser) {
      return res.status(400).json({ error: 'Пользователь с таким никнеймом уже зарегистрирован' });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    await db.run(
      'INSERT INTO users (username, password_hash, role, last_hwid) VALUES (?, ?, ?, ?)',
      [username, passwordHash, 'PLAYER', hwid]
    );

    await db.run(
      'INSERT INTO connection_stats (username, event_type, details) VALUES (?, ?, ?)',
      [username, 'REGISTER_SUCCESS', 'Успешная регистрация игрока']
    );

    return res.json({ success: true, message: 'Регистрация прошла успешно! Теперь вы можете войти.' });
  } catch (error) {
    console.error('[AUTH REGISTER ERROR]', error);
    return res.status(500).json({ error: 'Внутренняя ошибка сервера при регистрации' });
  }
});

// 2. Вход (Логин)
router.post('/login', async (req: Request, res: Response) => {
  try {
    const { username, password, hwid, isAdminApp } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: 'Введите никнейм и пароль' });
    }

    const clientHwid = hwid || 'UNKNOWN-HWID';
    const db = await getDb();

    // Проверка бана HWID или Ника
    let isBanned = null;
    try {
      isBanned = await db.get('SELECT id, reason FROM banned_hwids WHERE hwid = ? OR LOWER(username) = LOWER(?)', [clientHwid, username]);
    } catch (e) {
      isBanned = await db.get('SELECT id, reason FROM banned_hwids WHERE hwid = ?', [clientHwid]);
    }

    if (isBanned) {
      await db.run(
        'INSERT INTO connection_stats (username, event_type, details) VALUES (?, ?, ?)',
        [username, 'FAILED_HWID_BAN', `Попытка входа с забаненного ПК/Ника: ${isBanned.reason}`]
      );
      return res.status(403).json({ error: `Ваш аккаунт или компьютер заблокированы! Причина: ${isBanned.reason}` });
    }

    // Проверка учетной записи
    const user = await db.get('SELECT * FROM users WHERE LOWER(username) = LOWER(?)', [username]);
    if (!user) {
      await db.run(
        'INSERT INTO connection_stats (username, event_type, details) VALUES (?, ?, ?)',
        [username, 'FAILED_AUTH', 'Пользователь не найден']
      );
      return res.status(401).json({ error: 'Неверный никнейм или пароль' });
    }

    const isMatch = await bcrypt.compare(password, user.password_hash);
    if (!isMatch) {
      await db.run(
        'INSERT INTO connection_stats (username, event_type, details) VALUES (?, ?, ?)',
        [username, 'FAILED_AUTH', 'Неверный пароль']
      );
      return res.status(401).json({ error: 'Неверный никнейм или пароль' });
    }

    // Если вход выполняется через Admin Launcher — проверяем роль ADMIN
    if (isAdminApp && user.role !== 'ADMIN') {
      return res.status(403).json({ error: 'Доступ запрещен. Учетная запись не имеет прав администратора.' });
    }

    // Обновляем последний HWID пользователя
    await db.run('UPDATE users SET last_hwid = ? WHERE id = ?', [clientHwid, user.id]);

    // Генерация JWT сессионного токена
    const token = jwt.sign(
      { userId: user.id, username: user.username, role: user.role, hwid: clientHwid },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    // Сохранение сессии в БД
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    await db.run(
      'INSERT INTO sessions (username, access_token, hwid, is_admin_bypass, expires_at) VALUES (?, ?, ?, ?, ?)',
      [user.username, token, clientHwid, user.role === 'ADMIN' ? 1 : 0, expiresAt]
    );

    await db.run(
      'INSERT INTO connection_stats (username, event_type, details) VALUES (?, ?, ?)',
      [user.username, 'SUCCESS', `Успешная авторизация (${user.role})`]
    );

    return res.json({
      success: true,
      username: user.username,
      role: user.role,
      token,
      expiresAt
    });
  } catch (error) {
    console.error('[AUTH LOGIN ERROR]', error);
    return res.status(500).json({ error: 'Внутренняя ошибка сервера при входе: ' + (error as Error).message });
  }
});

// 3. Проверка валидности сессии (Для серверного плагина VozduCraftAuthPlugin.java)
router.get('/verify-session', async (req: Request, res: Response) => {
  try {
    const { token, username, hwid } = req.query;

    if (!token || !username) {
      return res.status(400).json({ valid: false, error: 'Отсутствует токен или имя пользователя' });
    }

    const db = await getDb();
    const session = await db.get(
      'SELECT * FROM sessions WHERE access_token = ? AND LOWER(username) = LOWER(?) AND expires_at > CURRENT_TIMESTAMP',
      [String(token), String(username)]
    );

    if (!session) {
      return res.status(401).json({ valid: false, error: 'Сессия истекла или не существует' });
    }

    // В случае обычного игрока проверяем HWID
    if (!session.is_admin_bypass && hwid && session.hwid !== String(hwid)) {
      return res.status(403).json({ valid: false, error: 'Несовпадение отпечатка HWID' });
    }

    return res.json({
      valid: true,
      username: session.username,
      isAdminBypass: Boolean(session.is_admin_bypass)
    });
  } catch (error) {
    return res.status(500).json({ valid: false, error: 'Ошибка проверки сессии' });
  }
});

export default router;
