"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.discordClient = exports.botLastError = exports.currentProxy = exports.currentBotToken = void 0;
exports.getActiveBotToken = getActiveBotToken;
exports.getActiveProxy = getActiveProxy;
exports.getDiscordBotStatus = getDiscordBotStatus;
exports.reloadDiscordBot = reloadDiscordBot;
exports.initDiscordBot = initDiscordBot;
exports.sendDiscordLoginRequest = sendDiscordLoginRequest;
const discord_js_1 = require("discord.js");
const db_1 = require("./db");
const https_proxy_agent_1 = require("https-proxy-agent");
const socks_proxy_agent_1 = require("socks-proxy-agent");
const undici_1 = require("undici");
exports.currentBotToken = '';
exports.currentProxy = '';
exports.botLastError = '';
exports.discordClient = new discord_js_1.Client({
    intents: [
        discord_js_1.GatewayIntentBits.Guilds,
        discord_js_1.GatewayIntentBits.DirectMessages,
        discord_js_1.GatewayIntentBits.GuildMembers
    ],
    partials: [discord_js_1.Partials.Channel, discord_js_1.Partials.Message]
});
function createProxyAgent(proxyUrl) {
    if (!proxyUrl)
        return undefined;
    try {
        if (proxyUrl.startsWith('socks')) {
            return new socks_proxy_agent_1.SocksProxyAgent(proxyUrl);
        }
        return new https_proxy_agent_1.HttpsProxyAgent(proxyUrl);
    }
    catch (e) {
        console.warn('[DISCORD BOT] Ошибка создания ProxyAgent:', e.message);
        return undefined;
    }
}
// Получение активного токена (из БД или .env)
async function getActiveBotToken() {
    try {
        const db = await (0, db_1.getDb)();
        const row = await db.get("SELECT value FROM system_settings WHERE key = 'discord_bot_token'");
        if (row && row.value && row.value.trim()) {
            return row.value.trim();
        }
    }
    catch (e) { }
    return (process.env.DISCORD_BOT_TOKEN || '').trim();
}
// Получение активного прокси (из БД или .env)
async function getActiveProxy() {
    try {
        const db = await (0, db_1.getDb)();
        const row = await db.get("SELECT value FROM system_settings WHERE key = 'discord_proxy'");
        if (row && row.value && row.value.trim()) {
            return row.value.trim();
        }
    }
    catch (e) { }
    return (process.env.DISCORD_PROXY || process.env.HTTPS_PROXY || process.env.HTTP_PROXY || '').trim();
}
// Статус подключения бота для админ панели
function getDiscordBotStatus() {
    return {
        isReady: exports.discordClient.isReady(),
        tag: exports.discordClient.user?.tag || null,
        id: exports.discordClient.user?.id || null,
        guildsCount: exports.discordClient.guilds?.cache.size || 0,
        hasToken: Boolean(exports.currentBotToken),
        proxy: exports.currentProxy || null,
        lastError: exports.botLastError || null
    };
}
// Перезапуск / подключение бота с новым токеном и прокси на лету
async function reloadDiscordBot(newToken, newProxy) {
    try {
        const tokenToUse = newToken ? newToken.trim() : await getActiveBotToken();
        const proxyToUse = newProxy !== undefined ? newProxy.trim() : await getActiveProxy();
        if (!tokenToUse) {
            exports.botLastError = 'Токен не указан';
            return { success: false, message: 'Токен Discord-бота не указан', error: exports.botLastError };
        }
        exports.currentBotToken = tokenToUse;
        exports.currentProxy = proxyToUse;
        exports.botLastError = '';
        if (exports.currentProxy) {
            try {
                const undiciAgent = new undici_1.ProxyAgent(exports.currentProxy);
                (0, undici_1.setGlobalDispatcher)(undiciAgent);
                console.log(`[DISCORD BOT] 🌐 Global ProxyAgent активирован: ${exports.currentProxy}`);
            }
            catch (pe) {
                console.warn('[DISCORD BOT] Ошибка активации Global ProxyAgent:', pe.message);
            }
        }
        // Если клиент уже авторизован - уничтожаем старую сессию
        if (exports.discordClient.isReady()) {
            await exports.discordClient.destroy();
        }
        const clientOptions = {
            intents: [
                discord_js_1.GatewayIntentBits.Guilds,
                discord_js_1.GatewayIntentBits.DirectMessages,
                discord_js_1.GatewayIntentBits.GuildMembers
            ],
            partials: [discord_js_1.Partials.Channel, discord_js_1.Partials.Message]
        };
        if (exports.currentProxy) {
            const agent = createProxyAgent(exports.currentProxy);
            if (agent) {
                clientOptions.ws = { agent };
            }
            try {
                clientOptions.rest = { agent: new undici_1.ProxyAgent(exports.currentProxy) };
            }
            catch (_) {
                clientOptions.rest = { proxy: exports.currentProxy };
            }
        }
        exports.discordClient = new discord_js_1.Client(clientOptions);
        exports.discordClient.on('ready', () => {
            console.log(`[DISCORD BOT] ✅ Успешно авторизован как ${exports.discordClient.user?.tag}`);
            exports.botLastError = '';
        });
        exports.discordClient.on('error', (err) => {
            console.error('[DISCORD BOT ERROR]:', err.message);
            exports.botLastError = err.message;
        });
        exports.discordClient.on('shardError', (err) => {
            console.error('[DISCORD BOT SHARD ERROR]:', err.message);
            exports.botLastError = err.message;
        });
        exports.discordClient.on('interactionCreate', async (interaction) => {
            try {
                if (interaction.isChatInputCommand()) {
                    await handleSlashCommand(interaction);
                }
                else if (interaction.isButton()) {
                    await handleButtonInteraction(interaction);
                }
            }
            catch (err) {
                console.error('[DISCORD BOT] Ошибка обработки события:', err);
            }
        });
        // Безопасный логин с таймаутом 30 секунд
        const loginPromise = exports.discordClient.login(exports.currentBotToken);
        const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('Connect Timeout (30000ms). Проверьте прокси или настройки сети.')), 30000));
        await Promise.race([loginPromise, timeoutPromise]);
        // Регистрация слэш-команд
        try {
            const restOptions = { version: '10' };
            if (exports.currentProxy) {
                try {
                    restOptions.agent = new undici_1.ProxyAgent(exports.currentProxy);
                }
                catch (_) {
                    restOptions.proxy = exports.currentProxy;
                }
            }
            const rest = new discord_js_1.REST(restOptions).setToken(exports.currentBotToken);
            const commands = [
                new discord_js_1.SlashCommandBuilder()
                    .setName('register')
                    .setDescription('Привязать игровой никнейм Minecraft к Discord')
                    .addStringOption(option => option.setName('username')
                    .setDescription('Ваш никнейм в игре')
                    .setRequired(true)),
                new discord_js_1.SlashCommandBuilder()
                    .setName('confirm')
                    .setDescription('Подтвердить активный запрос на вход в лаунчер'),
                new discord_js_1.SlashCommandBuilder()
                    .setName('status')
                    .setDescription('Проверить статус привязанного аккаунта'),
                new discord_js_1.SlashCommandBuilder()
                    .setName('unlink')
                    .setDescription('Отвязать никнейм Minecraft от Discord')
            ].map(c => c.toJSON());
            if (exports.discordClient.user?.id) {
                await rest.put(discord_js_1.Routes.applicationCommands(exports.discordClient.user.id), { body: commands });
                console.log('[DISCORD BOT] Слэш-команды (/register, /confirm, /status, /unlink) успешно зарегистрированы!');
            }
        }
        catch (e) {
            console.error('[DISCORD BOT] Ошибка регистрации слэш-команд:', e.message);
        }
        return {
            success: true,
            message: `Бот успешно подключен: ${exports.discordClient.user?.tag}`
        };
    }
    catch (err) {
        exports.botLastError = err.message || 'Ошибка входа в Discord';
        console.error('[DISCORD BOT] Ошибка входа:', exports.botLastError);
        return { success: false, message: 'Не удалось подключить бота к Discord', error: exports.botLastError };
    }
}
// Инициализация при старте сервера
async function initDiscordBot() {
    exports.discordClient.on('ready', () => {
        console.log(`[DISCORD BOT] ✅ Успешно авторизован как ${exports.discordClient.user?.tag}`);
        exports.botLastError = '';
    });
    exports.discordClient.on('interactionCreate', async (interaction) => {
        try {
            if (interaction.isChatInputCommand()) {
                await handleSlashCommand(interaction);
            }
            else if (interaction.isButton()) {
                await handleButtonInteraction(interaction);
            }
        }
        catch (err) {
            console.error('[DISCORD BOT] Ошибка обработки события:', err);
        }
    });
    const token = await getActiveBotToken();
    if (token) {
        await reloadDiscordBot(token);
    }
    else {
        console.warn('[DISCORD BOT] Токен бота не настроен. Настройте его в админ-панели.');
    }
}
// Обработка команд /register, /status, /unlink
async function handleSlashCommand(interaction) {
    const db = await (0, db_1.getDb)();
    const discordId = interaction.user.id;
    const command = interaction.commandName;
    if (command === 'register') {
        const rawUsername = interaction.options.getString('username', true).trim();
        // Проверка, занят ли никнейм другим Discord-аккаунтом
        const existing = await db.get('SELECT username, discord_id FROM users WHERE LOWER(username) = LOWER(?) AND discord_id IS NOT NULL AND discord_id != ?', [rawUsername, discordId]);
        if (existing) {
            return interaction.reply({
                content: `❌ Ник **${rawUsername}** уже привязан к другому Discord-аккаунту!`,
                ephemeral: true
            });
        }
        // Сохраняем привязку в базе
        const user = await db.get('SELECT id FROM users WHERE LOWER(username) = LOWER(?)', [rawUsername]);
        if (user) {
            await db.run('UPDATE users SET discord_id = ? WHERE id = ?', [discordId, user.id]);
        }
        else {
            await db.run('INSERT INTO users (username, password_hash, role, discord_id) VALUES (?, ?, ?, ?)', [rawUsername, 'DISCORD_REGISTERED', 'PLAYER', discordId]);
        }
        return interaction.reply({
            content: `✅ Ник **${rawUsername}** успешно привязан к вашему Discord! Теперь вы можете нажать кнопку входа в лаунчере.`,
            ephemeral: true
        });
    }
    if (command === 'confirm') {
        const pendingReq = await db.get(`SELECT r.* FROM discord_auth_requests r
       JOIN users u ON LOWER(u.username) = LOWER(r.username)
       WHERE u.discord_id = ? AND r.status = 'PENDING'
       ORDER BY r.created_at DESC LIMIT 1`, [discordId]);
        if (pendingReq) {
            await db.run("UPDATE discord_auth_requests SET status = 'APPROVED', discord_id = ? WHERE id = ?", [discordId, pendingReq.id]);
            return interaction.reply({
                content: `✅ Вход в лаунчер для **${pendingReq.username}** успешно подтвержден!`,
                ephemeral: true
            });
        }
        else {
            return interaction.reply({
                content: '⚠️ У вас нет активных запросов на подтверждение входа.',
                ephemeral: true
            });
        }
    }
    if (command === 'status') {
        const user = await db.get('SELECT username FROM users WHERE discord_id = ?', [discordId]);
        if (user) {
            return interaction.reply({
                content: `ℹ️ К вашему Discord привязан аккаунт: **${user.username}**`,
                ephemeral: true
            });
        }
        else {
            return interaction.reply({
                content: '⚠️ У вас нет привязанных аккаунтов. Используйте `/register <ваш_ник>`.',
                ephemeral: true
            });
        }
    }
    if (command === 'unlink') {
        await db.run('UPDATE users SET discord_id = NULL WHERE discord_id = ?', [discordId]);
        return interaction.reply({
            content: '✅ Привязка аккаунта удалена.',
            ephemeral: true
        });
    }
}
// Обработка нажатий на кнопки [✅ Подтвердить] и [❌ Отклонить]
async function handleButtonInteraction(interaction) {
    const customId = interaction.customId;
    const db = await (0, db_1.getDb)();
    if (customId.startsWith('auth_approve_')) {
        const requestId = customId.replace('auth_approve_', '');
        const authReq = await db.get('SELECT * FROM discord_auth_requests WHERE id = ?', [requestId]);
        if (!authReq || authReq.status !== 'PENDING') {
            return interaction.update({
                content: '⚠️ Этот запрос на вход уже был обработан или истек.',
                components: []
            });
        }
        await db.run("UPDATE discord_auth_requests SET status = 'APPROVED', discord_id = ? WHERE id = ?", [interaction.user.id, requestId]);
        const embed = new discord_js_1.EmbedBuilder()
            .setColor(0x22c55e)
            .setTitle('✅ Вход в лаунчер подтвержден')
            .setDescription(`Авторизация для игрока **${authReq.username}** прошла успешно! Приятной игры на **VozduCraft**.`);
        return interaction.update({
            embeds: [embed],
            components: []
        });
    }
    if (customId.startsWith('auth_reject_')) {
        const requestId = customId.replace('auth_reject_', '');
        await db.run("UPDATE discord_auth_requests SET status = 'REJECTED' WHERE id = ?", [requestId]);
        const embed = new discord_js_1.EmbedBuilder()
            .setColor(0xef4444)
            .setTitle('❌ Вход в лаунчер отклонен')
            .setDescription('Попытка входа была отклонена.');
        return interaction.update({
            embeds: [embed],
            components: []
        });
    }
}
// Отправка личного сообщения игроку в Discord
async function sendDiscordLoginRequest(username, ip, requestId) {
    try {
        if (!exports.discordClient.isReady()) {
            return {
                success: false,
                error: 'Бот Discord сейчас не подключен на сервере VDS. Убедитесь, что в файле /root/vozducraft/.env указан правильный DISCORD_BOT_TOKEN и выполнен docker compose up -d'
            };
        }
        const db = await (0, db_1.getDb)();
        // Ищем привязанный discord_id
        const user = await db.get('SELECT discord_id FROM users WHERE LOWER(username) = LOWER(?) AND discord_id IS NOT NULL', [username]);
        if (!user || !user.discord_id) {
            return {
                success: false,
                error: `Ник "${username}" еще не привязан к Discord! Зайдите в Discord-сервер и напишите боту команду: /register ${username}`
            };
        }
        const discordUser = await exports.discordClient.users.fetch(user.discord_id).catch((err) => {
            console.error(`[DISCORD BOT] Ошибка поиска пользователя ${user.discord_id}:`, err);
            return null;
        });
        if (!discordUser) {
            return {
                success: false,
                error: `Не удалось найти Discord-пользователя (ID: ${user.discord_id}). Проверьте привязку командой /status в Discord.`
            };
        }
        const embed = new discord_js_1.EmbedBuilder()
            .setColor(0x5865F2)
            .setTitle('🛡️ Подтверждение входа в лаунчер VozduCraft')
            .setDescription(`Была зафиксирована попытка входа в лаунчер с вашего аккаунта.\n\n👤 **Никнейм:** \`${username}\`\n🌐 **IP-адрес:** \`${ip}\`\n⏱️ **Время на ответ:** \`2 минуты\``)
            .setFooter({ text: 'Если это были не вы, нажмите кнопку «Отклонить».' })
            .setTimestamp();
        const row = new discord_js_1.ActionRowBuilder().addComponents(new discord_js_1.ButtonBuilder()
            .setCustomId(`auth_approve_${requestId}`)
            .setLabel('✅ Подтвердить вход')
            .setStyle(discord_js_1.ButtonStyle.Success), new discord_js_1.ButtonBuilder()
            .setCustomId(`auth_reject_${requestId}`)
            .setLabel('❌ Отклонить')
            .setStyle(discord_js_1.ButtonStyle.Danger));
        await discordUser.send({
            embeds: [embed],
            components: [row]
        });
        return { success: true };
    }
    catch (err) {
        console.error('[DISCORD BOT] Ошибка отправки DM:', err);
        return {
            success: false,
            error: `Ошибка отправки в Discord: ${err.message || 'Проверьте настройки приватности ЛС или введите /confirm на сервере Discord'}`
        };
    }
}
