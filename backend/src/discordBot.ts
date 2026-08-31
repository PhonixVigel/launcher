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

const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN || '';

export const discordClient = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildMembers
  ],
  partials: [Partials.Channel, Partials.Message]
});

// Инициализация и запуск Discord бота
export async function initDiscordBot() {
  if (!DISCORD_BOT_TOKEN) {
    console.warn('[DISCORD BOT] Токен бота не указан, модуль пропущен.');
    return;
  }

  discordClient.on('ready', async () => {
    console.log(`[DISCORD BOT] ✅ Успешно авторизован как ${discordClient.user?.tag}`);

    // Регистрация слэш-команд
    try {
      const rest = new REST({ version: '10' }).setToken(DISCORD_BOT_TOKEN);
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
        console.log('[DISCORD BOT] Слэш-команды (/register, /status, /unlink) успешно зарегистрированы!');
      }
    } catch (e) {
      console.error('[DISCORD BOT] Ошибка регистрации слэш-команд:', e);
    }
  });

  // Обработка слэш-команд и кнопок
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

  discordClient.login(DISCORD_BOT_TOKEN).catch(err => {
    console.error('[DISCORD BOT] Ошибка авторизации бота по токену:', err.message);
  });
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
    const db = await getDb();
    
    // Ищем привязанный discord_id
    const user = await db.get(
      'SELECT discord_id FROM users WHERE LOWER(username) = LOWER(?) AND discord_id IS NOT NULL',
      [username]
    );

    if (!user || !user.discord_id) {
      return {
        success: false,
        error: `Ник "${username}" еще не зарегистрирован в Discord! Зайдите в Discord-сервер и напишите боту команду: /register ${username}`
      };
    }

    const discordUser = await discordClient.users.fetch(user.discord_id).catch(() => null);
    if (!discordUser) {
      return {
        success: false,
        error: 'Не удалось найти ваш аккаунт в Discord. Проверьте правильность привязки.'
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
      error: 'Не удалось отправить сообщение в Discord! Проверьте, включены ли у вас «Личные сообщения» в настройках приватности сервера Discord.'
    };
  }
}
