import * as path from 'path';
import * as fs from 'fs';

const profilePath = path.join(__dirname, '..', 'player-launcher', 'meta', 'launch-profile.json');

console.log('🧪 Запуск Smoke-теста профиля запуска VozduCraft...');

if (!fs.existsSync(profilePath)) {
  console.error(`❌ Ошибка: Файл профиля не найден по пути: ${profilePath}`);
  process.exit(1);
}

const profile = JSON.parse(fs.readFileSync(profilePath, 'utf8'));

// 1. Проверка структуры профиля
if (!profile.mainClass || !Array.isArray(profile.jvmArgs) || !Array.isArray(profile.gameArgs)) {
  console.error('❌ Ошибка: Профиль имеет неверную структуру (mainClass, jvmArgs, gameArgs обязательны)');
  process.exit(1);
}

console.log(`✅ Структура профиля валидна. mainClass: ${profile.mainClass}`);

// 2. Проверка изоляции classpath (исключение конфликтующих библиотек)
const cpArg = profile.jvmArgs.find((a: string) => a.includes('${cp_separator}'));
if (!cpArg) {
  console.error('❌ Ошибка: Не найден Classpath аргумент с ${cp_separator}');
  process.exit(1);
}

const forbiddenPatterns = [
  'binarypatcher',
  'autorenamingtool',
  'installertools',
  'jarsplitter',
  'cli-utils',
  'specialsource',
  'srgutils',
  'neoform',
  'universal.jar'
];

for (const pattern of forbiddenPatterns) {
  if (cpArg.toLowerCase().includes(pattern)) {
    console.error(`❌ Ошибка: В classpath обнаружен запрещенный артефакт установщика: ${pattern}`);
    process.exit(1);
  }
}
console.log('✅ Classpath чист от конфликтующих утилит и сырых JAR.');

// 3. Тест подстановки Windows переменных
const winContext: Record<string, string> = {
  game_directory: 'C:\\Users\\Player\\.vozducraft',
  assets_root: 'C:\\Users\\Player\\.vozducraft\\assets',
  natives_directory: 'C:\\Users\\Player\\.vozducraft\\natives',
  max_memory: '4096',
  auth_player_name: 'WinPlayer',
  auth_uuid: '11111111-1111-1111-1111-111111111111',
  auth_access_token: 'test_token'
};

const replaceTokens = (str: string, ctx: Record<string, string>, cpSep: string) => {
  return str.replace(/\${(.*?)}/g, (match, token) => {
    if (token === 'cp_separator') return cpSep;
    return ctx[token] !== undefined ? ctx[token] : match;
  });
};

const winJvmArgs = profile.jvmArgs.map((arg: string) => replaceTokens(arg, winContext, ';'));
const winCpArg = winJvmArgs.find((a: string) => a.includes('C:\\Users\\Player\\.vozducraft'));

if (!winCpArg || !winCpArg.includes(';')) {
  console.error('❌ Ошибка: На Windows разделитель classpath должен быть точкой с запятой (;)');
  process.exit(1);
}
console.log('✅ Проверка Windows: разделители classpath (;) и пути успешно подставляются.');

// 4. Тест подстановки macOS переменных
const macContext: Record<string, string> = {
  game_directory: '/Users/player/.vozducraft',
  assets_root: '/Users/player/.vozducraft/assets',
  natives_directory: '/Users/player/.vozducraft/natives',
  max_memory: '4096',
  auth_player_name: 'MacPlayer',
  auth_uuid: '22222222-2222-2222-2222-222222222222',
  auth_access_token: 'test_token'
};

const macJvmArgs = profile.jvmArgs.map((arg: string) => replaceTokens(arg, macContext, ':'));
const macCpArg = macJvmArgs.find((a: string) => a.includes('/Users/player/.vozducraft'));

if (!macCpArg || !macCpArg.includes(':')) {
  console.error('❌ Ошибка: На macOS разделитель classpath должен быть двоеточием (:)');
  process.exit(1);
}
console.log('✅ Проверка macOS: разделители classpath (:) и пути успешно подставляются.');

console.log('🎉 Все Smoke-тесты запуска успешно пройдены (Windows & macOS совместимы)!');
process.exit(0);
