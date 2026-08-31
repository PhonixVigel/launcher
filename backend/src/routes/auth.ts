import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
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

    // Проверка бана HWID или Ника в таблице bans
    const isBanned = await db.get(`
      SELECT id, reason FROM bans 
      WHERE (ban_type = 'HWID' AND target_value = ?)
         OR (ban_type = 'NICK' AND LOWER(target_value) = LOWER(?))
    `, [hwid, username]);

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

// Защита от подбора паролей (Brute-force protection)
const loginAttempts: Record<string, { count: number; blockedUntil: number }> = {};

// 2. Вход (Логин)
router.post('/login', async (req: Request, res: Response) => {
  try {
    const { username, password, hwid, isAdminApp } = req.body;
    const clientIp = req.ip || req.socket.remoteAddress || 'unknown-ip';

    // Проверка блокировки по IP после неудачных попыток
    const attemptInfo = loginAttempts[clientIp];
    if (attemptInfo && attemptInfo.blockedUntil > Date.now()) {
      const waitSeconds = Math.ceil((attemptInfo.blockedUntil - Date.now()) / 1000);
      return res.status(429).json({ 
        error: `Слишком много неудачных попыток входа. Доступ заблокирован на ${waitSeconds} сек. для защиты от взлома.` 
      });
    }

    if (!username || !password) {
      return res.status(400).json({ error: 'Введите никнейм и пароль' });
    }

    const clientHwid = hwid || 'UNKNOWN-HWID';
    const db = await getDb();

    // Проверка бана Ника, HWID или IP в таблице bans
    const isBanned = await db.get(`
      SELECT id, reason FROM bans 
      WHERE (ban_type = 'HWID' AND target_value = ?)
         OR (ban_type = 'NICK' AND LOWER(target_value) = LOWER(?))
         OR (ban_type = 'IP' AND target_value = ?)
    `, [clientHwid, username, clientIp]);

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
      recordFailedAttempt(clientIp);
      await db.run(
        'INSERT INTO connection_stats (username, event_type, details, ip_address) VALUES (?, ?, ?, ?)',
        [username, 'FAILED_AUTH', 'Пользователь не найден', clientIp]
      );
      return res.status(401).json({ error: 'Неверный никнейм или пароль' });
    }

    const isMatch = await bcrypt.compare(password, user.password_hash);
    if (!isMatch) {
      recordFailedAttempt(clientIp);
      await db.run(
        'INSERT INTO connection_stats (username, event_type, details, ip_address) VALUES (?, ?, ?, ?)',
        [username, 'FAILED_AUTH', 'Неверный пароль', clientIp]
      );
      return res.status(401).json({ error: 'Неверный никнейм или пароль' });
    }

    // Сброс счетчика неудачных попыток при успешном входе
    delete loginAttempts[clientIp];

    // Если вход выполняется через Admin Panel — проверяем роль ADMIN / MODERATOR
    if (isAdminApp && user.role !== 'ADMIN' && user.role !== 'MODERATOR') {
      return res.status(403).json({ error: 'Доступ запрещен. Учетная запись не имеет прав администратора.' });
    }

    // Обновляем последний IP и HWID пользователя
    await db.run('UPDATE users SET last_hwid = ?, last_ip = ? WHERE id = ?', [clientHwid, clientIp, user.id]);

    // Генерация криптографического JWT сессионного токена
    const token = jwt.sign(
      { userId: user.id, username: user.username, role: user.role, hwid: clientHwid },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    // Сохранение сессии в БД
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    await db.run(
      'INSERT INTO sessions (username, access_token, hwid, ip_address, is_admin_bypass, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
      [user.username, token, clientHwid, clientIp, user.role === 'ADMIN' ? 1 : 0, expiresAt]
    );

    await db.run(
      'INSERT INTO connection_stats (username, event_type, details, ip_address) VALUES (?, ?, ?, ?)',
      [user.username, 'LOGIN_SUCCESS', `Успешная авторизация (${user.role})`, clientIp]
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

function recordFailedAttempt(clientIp: string) {
  if (!loginAttempts[clientIp]) {
    loginAttempts[clientIp] = { count: 1, blockedUntil: 0 };
  } else {
    loginAttempts[clientIp].count += 1;
  }

  // Блокировка на 10 минут после 5 неудачных попыток
  if (loginAttempts[clientIp].count >= 5) {
    loginAttempts[clientIp].blockedUntil = Date.now() + 10 * 60 * 1000;
  }
}

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

// 4. Смена пароля администратора / пользователя
router.post('/change-password', async (req: Request, res: Response) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Требуется авторизация' });
    }

    const token = authHeader.split(' ')[1];
    let decoded: any;
    try {
      decoded = jwt.verify(token, JWT_SECRET);
    } catch (err) {
      return res.status(401).json({ error: 'Недействительный или просроченный токен' });
    }

    const username = decoded.username;
    const { currentPassword, newPassword } = req.body;

    if (!newPassword || newPassword.length < 5) {
      return res.status(400).json({ error: 'Новый пароль должен содержать минимум 5 символов' });
    }

    if (!currentPassword) {
      return res.status(400).json({ error: 'Введите текущий пароль для подтверждения' });
    }

    const db = await getDb();
    const user = await db.get('SELECT * FROM users WHERE LOWER(username) = LOWER(?)', [username]);
    if (!user) {
      return res.status(404).json({ error: 'Пользователь не найден' });
    }

    // Строгая проверка текущего пароля
    const isValid = await bcrypt.compare(currentPassword, user.password_hash);
    if (!isValid) {
      return res.status(400).json({ error: 'Текущий пароль указан неверно!' });
    }

    // Хеширование нового пароля
    const newHash = await bcrypt.hash(newPassword, 12);
    await db.run('UPDATE users SET password_hash = ? WHERE id = ?', [newHash, user.id]);

    // Инвалидируем старые сессии пользователя кроме текущей
    await db.run('DELETE FROM sessions WHERE username = ? AND access_token != ?', [user.username, token]);

    return res.json({ success: true, message: 'Пароль успешно обновлен!' });
  } catch (error) {
    return res.status(500).json({ error: 'Ошибка при смене пароля: ' + (error as Error).message });
  }
});

// ----------------------------------------------------
// 5. АВТОРИЗАЦИЯ ЧЕРЕЗ DISCORD БОТА ДЛЯ ЛАУНЧЕРА
// ----------------------------------------------------

// POST /api/v1/auth/discord/request-login - Инициализация входа по никнейму
router.post('/discord/request-login', async (req: Request, res: Response) => {
  try {
    const { username, hwid } = req.body;
    const clientIp = req.ip || req.socket.remoteAddress || 'unknown-ip';

    if (!username || username.trim().length < 3) {
      return res.status(400).json({ error: 'Введите корректный никнейм (от 3 символов)' });
    }

    const cleanNick = username.trim();
    const clientHwid = hwid || 'LAUNCHER-HWID';
    const db = await getDb();

    // Проверка блокировок по нику, HWID или IP
    const isBanned = await db.get(`
      SELECT id, reason FROM bans 
      WHERE (ban_type = 'HWID' AND target_value = ?)
         OR (ban_type = 'NICK' AND LOWER(target_value) = LOWER(?))
         OR (ban_type = 'IP' AND target_value = ?)
    `, [clientHwid, cleanNick, clientIp]);

    if (isBanned) {
      return res.status(403).json({ error: `Ваш аккаунт или устройство заблокированы. Причина: ${isBanned.reason}` });
    }

    // Генерация уникального ID запроса
    const requestId = crypto.randomBytes(16).toString('hex');
    const expiresAt = new Date(Date.now() + 120 * 1000).toISOString(); // 2 минуты на подтверждение

    await db.run(`
      INSERT INTO discord_auth_requests (id, username, ip_address, status, expires_at)
      VALUES (?, ?, ?, 'PENDING', ?)
    `, [requestId, cleanNick, clientIp, expiresAt]);

    // Проверяем, есть ли пользователь в базе, если нет - регистрируем
    const existingUser = await db.get('SELECT * FROM users WHERE LOWER(username) = LOWER(?)', [cleanNick]);
    if (!existingUser) {
      const randomPasswordHash = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 10);
      await db.run(
        'INSERT INTO users (username, password_hash, role, last_hwid, last_ip) VALUES (?, ?, ?, ?, ?)',
        [cleanNick, randomPasswordHash, 'PLAYER', clientHwid, clientIp]
      );
    } else {
      await db.run('UPDATE users SET last_hwid = ?, last_ip = ? WHERE id = ?', [clientHwid, clientIp, existingUser.id]);
    }

    await db.run(
      'INSERT INTO connection_stats (username, event_type, details, ip_address, hwid) VALUES (?, ?, ?, ?, ?)',
      [cleanNick, 'DISCORD_LOGIN_REQUEST', `Запрос авторизации в лаунчер (ID: ${requestId})`, clientIp, clientHwid]
    );

    return res.json({
      success: true,
      requestId,
      username: cleanNick,
      expiresInSeconds: 120,
      message: 'Запрос на подтверждение входа отправлен в Discord.'
    });
  } catch (error) {
    return res.status(500).json({ error: 'Ошибка отправки запроса в Discord: ' + (error as Error).message });
  }
});

// GET /api/v1/auth/discord/status/:requestId - Проверка статуса подтверждения запроса
router.get('/discord/status/:requestId', async (req: Request, res: Response) => {
  try {
    const { requestId } = req.params;
    const db = await getDb();

    const authReq = await db.get('SELECT * FROM discord_auth_requests WHERE id = ?', [requestId]);
    if (!authReq) {
      return res.status(404).json({ status: 'NOT_FOUND', error: 'Запрос авторизации не найден' });
    }

    // Проверка истечения времени
    if (authReq.status === 'PENDING' && new Date(authReq.expires_at).getTime() < Date.now()) {
      await db.run("UPDATE discord_auth_requests SET status = 'EXPIRED' WHERE id = ?", [requestId]);
      return res.json({ status: 'EXPIRED', error: 'Время ожидания подтверждения истекло' });
    }

    if (authReq.status === 'REJECTED') {
      return res.json({ status: 'REJECTED', error: 'Вход был отклонен в Discord' });
    }

    if (authReq.status === 'APPROVED') {
      let token = authReq.token;
      if (!token) {
        // Генерируем 24-часовой JWT токен (86400 секунд)
        token = jwt.sign(
          { username: authReq.username, role: 'PLAYER' },
          JWT_SECRET,
          { expiresIn: '24h' }
        );

        const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
        await db.run('UPDATE discord_auth_requests SET token = ? WHERE id = ?', [token, requestId]);
        
        await db.run(
          'INSERT INTO sessions (username, access_token, hwid, ip_address, expires_at) VALUES (?, ?, ?, ?, ?)',
          [authReq.username, token, 'DISCORD-LAUNCHER', authReq.ip_address || '', expiresAt]
        );
      }

      const sessionExpiry = Date.now() + 24 * 60 * 60 * 1000;
      return res.json({
        status: 'APPROVED',
        username: authReq.username,
        token,
        sessionExpiry
      });
    }

    return res.json({ status: 'PENDING' });
  } catch (error) {
    return res.status(500).json({ error: 'Ошибка проверки статуса' });
  }
});

// POST /api/v1/auth/discord/callback - Подтверждение / Отклонение из Discord-бота
router.post('/discord/callback', async (req: Request, res: Response) => {
  try {
    const { requestId, action, discordId } = req.body; // action: 'approve' | 'reject'
    const db = await getDb();

    const authReq = await db.get('SELECT * FROM discord_auth_requests WHERE id = ?', [requestId]);
    if (!authReq) {
      return res.status(404).json({ error: 'Запрос не найден' });
    }

    if (action === 'approve') {
      // 24 часа сессия
      const token = jwt.sign(
        { username: authReq.username, role: 'PLAYER', discordId },
        JWT_SECRET,
        { expiresIn: '24h' }
      );

      const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      await db.run(
        "UPDATE discord_auth_requests SET status = 'APPROVED', token = ?, discord_id = ? WHERE id = ?",
        [token, discordId || '', requestId]
      );

      await db.run(
        'INSERT INTO sessions (username, access_token, hwid, ip_address, expires_at) VALUES (?, ?, ?, ?, ?)',
        [authReq.username, token, 'DISCORD-LAUNCHER', authReq.ip_address || '', expiresAt]
      );

      await db.run(
        'INSERT INTO connection_stats (username, event_type, details) VALUES (?, ?, ?)',
        [authReq.username, 'DISCORD_LOGIN_APPROVED', `Вход подтвержден в Discord (${discordId || 'Web'})`]
      );

      return res.json({ success: true, message: 'Авторизация в лаунчере подтверждена!' });
    } else {
      await db.run("UPDATE discord_auth_requests SET status = 'REJECTED' WHERE id = ?", [requestId]);
      return res.json({ success: true, message: 'Вход отклонен.' });
    }
  } catch (error) {
    return res.status(500).json({ error: 'Ошибка обработки колбэка' });
  }
});

export default router;
