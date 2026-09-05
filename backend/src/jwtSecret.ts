import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

let cachedSecret: string | null = null;

export function getJwtSecret(): string {
  if (cachedSecret) return cachedSecret;

  // 1. Если в .env задан явный надежный секрет (не дефолтный)
  const envSecret = process.env.JWT_SECRET;
  if (envSecret && envSecret !== 'vozducraft_secret_key_2026_super_secure' && envSecret.trim().length >= 16) {
    cachedSecret = envSecret.trim();
    return cachedSecret;
  }

  // 2. Иначе используем изолированный файл с криптографическим секретом
  const dataDir = path.resolve(__dirname, '../../data');
  if (!fs.existsSync(dataDir)) {
    try { fs.mkdirSync(dataDir, { recursive: true }); } catch (_) {}
  }

  const secretFilePath = path.join(dataDir, '.jwt_secret');

  try {
    if (fs.existsSync(secretFilePath)) {
      const stored = fs.readFileSync(secretFilePath, 'utf8').trim();
      if (stored.length >= 32) {
        cachedSecret = stored;
        return cachedSecret;
      }
    }
  } catch (_) {}

  // 3. Генерируем 512-битный криптографически стойкий случайный ключ
  const newSecret = crypto.randomBytes(64).toString('hex');
  try {
    fs.writeFileSync(secretFilePath, newSecret, { mode: 0o600 });
  } catch (err) {
    console.warn('[SECURITY] Не удалось записать .jwt_secret на диск, используется секрет в памяти:', err);
  }

  cachedSecret = newSecret;
  return cachedSecret;
}
