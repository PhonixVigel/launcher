"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getJwtSecret = getJwtSecret;
const crypto_1 = __importDefault(require("crypto"));
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
let cachedSecret = null;
function getJwtSecret() {
    if (cachedSecret)
        return cachedSecret;
    // 1. Если в .env задан явный надежный секрет (не дефолтный)
    const envSecret = process.env.JWT_SECRET;
    if (envSecret && envSecret !== 'vozducraft_secret_key_2026_super_secure' && envSecret.trim().length >= 16) {
        cachedSecret = envSecret.trim();
        return cachedSecret;
    }
    // 2. Иначе используем изолированный файл с криптографическим секретом
    const dataDir = path_1.default.resolve(__dirname, '../../data');
    if (!fs_1.default.existsSync(dataDir)) {
        try {
            fs_1.default.mkdirSync(dataDir, { recursive: true });
        }
        catch (_) { }
    }
    const secretFilePath = path_1.default.join(dataDir, '.jwt_secret');
    try {
        if (fs_1.default.existsSync(secretFilePath)) {
            const stored = fs_1.default.readFileSync(secretFilePath, 'utf8').trim();
            if (stored.length >= 32) {
                cachedSecret = stored;
                return cachedSecret;
            }
        }
    }
    catch (_) { }
    // 3. Генерируем 512-битный криптографически стойкий случайный ключ
    const newSecret = crypto_1.default.randomBytes(64).toString('hex');
    try {
        fs_1.default.writeFileSync(secretFilePath, newSecret, { mode: 0o600 });
    }
    catch (err) {
        console.warn('[SECURITY] Не удалось записать .jwt_secret на диск, используется секрет в памяти:', err);
    }
    cachedSecret = newSecret;
    return cachedSecret;
}
