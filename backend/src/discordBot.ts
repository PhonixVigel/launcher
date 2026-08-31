import { 
  Client, 
  GatewayIntentBits, 
  Partials, 
  SlashCommandBuilder, 
  REST, 
  Routes, 
  EmbedBuilder, 
  ActionRowBuilder, 
  ButtonBuilder, 
  ButtonStyle, 
  ButtonInteraction, 
  ChatInputCommandInteraction 
} from 'discord.js';
import { getDb } from './db';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';

export let currentBotToken = '';
export let currentProxy = '';
export let botLastError = '';

export let discordClient = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildMembers
  ],
  partials: [Partials.Channel, Partials.Message]
});

function createProxyAgent(proxyUrl: string): any {
  if (!proxyUrl) return undefined;
  try {
    if (proxyUrl.startsWith('socks')) {
      return new SocksProxyAgent(proxyUrl);
    }
    return new HttpsProxyAgent(proxyUrl);
  } catch (e: any) {
    console.warn('[DISCORD BOT] Ошибка создания ProxyAgent:', e.message);
    return undefined;
  }
}

// Получение активного токена (из БД или .env)
export async function getActiveBotToken(): Promise<string> {
  try {
    const db = await getDb();
    const row = await db.get("SELECT value FROM system_settings WHERE key = 'discord_bot_token'");
    if (row && row.value && row.value.trim()) {
      return row.value.trim();
    }
  } catch (e) {}
  return (process.env.DISCORD_BOT_TOKEN || '').trim();
}

// Получение активного прокси (из БД или .env)
export async function getActiveProxy(): Promise<string> {
  try {
    const db = await getDb();
    const row = await db.get("SELECT value FROM system_settings WHERE key = 'discord_proxy'");
    if (row && row.value && row.value.trim()) {
      return row.value.trim();
    }
  } catch (e) {}
  return (process.env.DISCORD_PROXY || process.env.HTTPS_PROXY || process.env.HTTP_PROXY || '').trim();
}

// Статус подключения бота для админ панели
export function getDiscordBotStatus() {
  return {
    isReady: discordClient.isReady(),
    tag: discordClient.user?.tag || null,
    id: discordClient.user?.id || null,
    guildsCount: discordClient.guilds?.cache.size || 0,
    hasToken: Boolean(currentBotToken),
    proxy: currentProxy || null,
    lastError: botLastError || null
  };
}

// Перезапуск / подключение бота с новым токеном и прокси на лету
export async function reloadDiscordBot(newToken?: string, newProxy?: string): Promise<{ success: boolean; message: string; error?: string }> {
  try {
    const tokenToUse = newToken ? newToken.trim() : await getActiveBotToken();
    const proxyToUse = newProxy !== undefined ? newProxy.trim() : await getActiveProxy();

    if (!tokenToUse) {
      botLastError = 'Токен не указан';
      return { success: false, message: 'Токен Discord-бота не указан', error: botLastError };
    }

    currentBotToken = tokenToUse;
    currentProxy = proxyToUse;
    botLastError = '';

    // Если клиент уже авторизован - уничтожаем старую сессию
    if (discordClient.isReady()) {
      await discordClient.destroy();
    }

    const clientOptions: any = {
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.GuildMembers
      ],
      partials: [Partials.Channel, Partials.Message]
    };

    if (currentProxy) {
      const agent = createProxyAgent(currentProxy);
      if (agent) {
        clientOptions.ws = { agent };
        clientOptions.rest = { agent, proxy: currentProxy };
      }
    }

    discordClient = new Client(clientOptions);

    discordClient.on('ready', () => {
      console.log(`[DISCORD BOT] ✅ Успешно авторизован как ${discordClient.user?.tag}`);
      botLastError = '';
    });

    discordClient.on('error', (err) => {
      console.error('[DISCORD BOT ERROR]:', err.message);
      botLastError = err.message;
    });

    discordClient.on('shardError', (err) => {
      console.error('[DISCORD BOT SHARD ERROR]:', err.message);
      botLastError = err.message;
    });

    discordClient.on('interactionCreate', async (interaction) => {
      try {
        if (interaction.isChatInputCommand()) {
          await handleSlashCommand(interaction);
        } else if (interaction.isButton()) {
          await handleButtonInteraction(interaction);
        }
      } catch (err) {
        console.error('[DISCORD BOT] Ошибка обработки события:', err);
      }
    });

    // Безопасный логин с таймаутом 15 секунд
    const loginPromise = discordClient.login(currentBotToken);
    const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('Connect Timeout (15000ms). Проверьте прокси или настройки сети.')), 15000));
    await Promise.race([loginPromise, timeoutPromise]);

    // Регистрация слэш-команд
    try {
      const restOptions: any = { version: '10' };
      if (currentProxy) {
        restOptions.proxy = currentProxy;
      }
      const rest = new REST(restOptions).setToken(currentBotToken);
      const commands = [
        new SlashCommandBuilder()
          .setName('register')
          .setDescription('Привязать игровой никнейм Minecraft к Discord')
          .addStringOption(option =>
            option.setName('username')
              .setDescription('Ваш никнейм в игре')
              .setRequired(true)
          ),
        new SlashCommandBuilder()
          .setName('confirm')
          .setDescription('Подтвердить активный запрос на вход в лаунчер'),
        new SlashCommandBuilder()
          .setName('status')
          .setDescription('Проверить статус привязанного аккаунта'),
        new SlashCommandBuilder()
          .setName('unlink')
          .setDescription('Отвязать никнейм Minecraft от Discord')
      ].map(c => c.toJSON());

      if (discordClient.user?.id) {
        await rest.put(
          Routes.applicationCommands(discordClient.user.id),
          { body: commands }
        );
        console.log('[DISCORD BOT] Слэш-команды (/register, /confirm, /status, /unlink) успешно зарегистрированы!');
      }
    } catch (e: any) {
      console.error('[DISCORD BOT] Ошибка регистрации слэш-команд:', e.message);
    }

    return { 
      success: true, 
      message: `Бот успешно подключен: ${discordClient.user?.tag}` 
    };
  } catch (err: any) {
    botLastError = err.message || 'Ошибка входа в Discord';
    console.error('[DISCORD BOT] Ошибка входа:', botLastError);
    return { success: false, message: 'Не удалось подключить бота к Discord', error: botLastError };
  }
}

// Инициализация при старте сервера
export async function initDiscordBot() {
  discordClient.on('ready', () => {
    console.log(`[DISCORD BOT] ✅ Успешно авторизован как ${discordClient.user?.tag}`);
    botLastError = '';
  });

  discordClient.on('interactionCreate', async (interaction) => {
    try {
      if (interaction.isChatInputCommand()) {
        await handleSlashCommand(interaction);
      } else if (interaction.isButton()) {
        await handleButtonInteraction(interaction);
      }
    } catch (err) {
      console.error('[DISCORD BOT] Ошибка обработки события:', err);
    }
  });

  const token = await getActiveBotToken();
  if (token) {
    await reloadDiscordBot(token);
  } else {
    console.warn('[DISCORD BOT] Токен бота не настроен. Настройте его в админ-панели.');
  }
}

// Обработка команд /register, /status, /unlink
async function handleSlashCommand(interaction: ChatInputCommandInteraction) {
  const db = await getDb();
  const discordId = interaction.user.id;
  const command = interaction.commandName;

  if (command === 'register') {
    const rawUsername = interaction.options.getString('username', true).trim();
    
    // Проверка, занят ли никнейм другим Discord-аккаунтом
    const existing = await db.get(
      'SELECT username, discord_id FROM users WHERE LOWER(username) = LOWER(?) AND discord_id IS NOT NULL AND discord_id != ?',
      [rawUsername, discordId]
    );

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
    } else {
      await db.run(
        'INSERT INTO users (username, password_hash, role, discord_id) VALUES (?, ?, ?, ?)',
        [rawUsername, 'DISCORD_REGISTERED', 'PLAYER', discordId]
      );
    }

    return interaction.reply({
      content: `✅ Ник **${rawUsername}** успешно привязан к вашему Discord! Теперь вы можете нажать кнопку входа в лаунчере.`,
      ephemeral: true
    });
  }

  if (command === 'confirm') {
    const pendingReq = await db.get(
      `SELECT r.* FROM discord_auth_requests r
       JOIN users u ON LOWER(u.username) = LOWER(r.username)
       WHERE u.discord_id = ? AND r.status = 'PENDING'
       ORDER BY r.created_at DESC LIMIT 1`,
      [discordId]
    );

    if (pendingReq) {
      await db.run("UPDATE discord_auth_requests SET status = 'APPROVED', discord_id = ? WHERE id = ?", [discordId, pendingReq.id]);
      return interaction.reply({
        content: `✅ Вход в лаунчер для **${pendingReq.username}** успешно подтвержден!`,
        ephemeral: true
      });
    } else {
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
    } else {
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
async function handleButtonInteraction(interaction: ButtonInteraction) {
  const customId = interaction.customId;
  const db = await getDb();

  if (customId.startsWith('auth_approve_')) {
    const requestId = customId.replace('auth_approve_', '');
    const authReq = await db.get('SELECT * FROM discord_auth_requests WHERE id = ?', [requestId]);

    if (!authReq || authReq.status !== 'PENDING') {
      return interaction.update({
        content: '⚠️ Этот запрос на вход уже был обработан или истек.',
        components: []
      });
    }

    await db.run(
      "UPDATE discord_auth_requests SET status = 'APPROVED', discord_id = ? WHERE id = ?",
      [interaction.user.id, requestId]
    );

    const embed = new EmbedBuilder()
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

    const embed = new EmbedBuilder()
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
export async function sendDiscordLoginRequest(username: string, ip: string, requestId: string): Promise<{ success: boolean; error?: string }> {
  try {
    if (!discordClient.isReady()) {
      return {
        success: false,
        error: 'Бот Discord сейчас не подключен на сервере VDS. Убедитесь, что в файле /root/vozducraft/.env указан правильный DISCORD_BOT_TOKEN и выполнен docker compose up -d'
      };
    }

    const db = await getDb();
    
    // Ищем привязанный discord_id
    const user = await db.get(
      'SELECT discord_id FROM users WHERE LOWER(username) = LOWER(?) AND discord_id IS NOT NULL',
      [username]
    );

    if (!user || !user.discord_id) {
      return {
        success: false,
        error: `Ник "${username}" еще не привязан к Discord! Зайдите в Discord-сервер и напишите боту команду: /register ${username}`
      };
    }

    const discordUser = await discordClient.users.fetch(user.discord_id).catch((err) => {
      console.error(`[DISCORD BOT] Ошибка поиска пользователя ${user.discord_id}:`, err);
      return null;
    });

    if (!discordUser) {
      return {
        success: false,
        error: `Не удалось найти Discord-пользователя (ID: ${user.discord_id}). Проверьте привязку командой /status в Discord.`
      };
    }

    const embed = new EmbedBuilder()
      .setColor(0x5865F2)
      .setTitle('🛡️ Подтверждение входа в лаунчер VozduCraft')
      .setDescription(`Была зафиксирована попытка входа в лаунчер с вашего аккаунта.\n\n👤 **Никнейм:** \`${username}\`\n🌐 **IP-адрес:** \`${ip}\`\n⏱️ **Время на ответ:** \`2 минуты\``)
      .setFooter({ text: 'Если это были не вы, нажмите кнопку «Отклонить».' })
      .setTimestamp();

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`auth_approve_${requestId}`)
        .setLabel('✅ Подтвердить вход')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`auth_reject_${requestId}`)
        .setLabel('❌ Отклонить')
        .setStyle(ButtonStyle.Danger)
    );

    await discordUser.send({
      embeds: [embed],
      components: [row]
    });

    return { success: true };
  } catch (err: any) {
    console.error('[DISCORD BOT] Ошибка отправки DM:', err);
    return {
      success: false,
      error: `Ошибка отправки в Discord: ${err.message || 'Проверьте настройки приватности ЛС или введите /confirm на сервере Discord'}`
    };
  }
}
