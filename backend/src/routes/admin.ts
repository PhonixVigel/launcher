import { Router, Request, Response } from 'express';
import { getDb } from '../db';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import net from 'net';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import AdmZip from 'adm-zip';
import SftpClient from 'ssh2-sftp-client';
import { getDiscordBotStatus, reloadDiscordBot, sendDiscordLoginRequest } from '../discordBot';
import { getJwtSecret } from '../jwtSecret';

const router = Router();

// Middleware проверки прав администратора
export const requireAdmin = async (req: Request, res: Response, next: Function) => {
  try {
    const authHeader = req.headers.authorization || (req.headers['x-admin-token'] as string);
    const queryToken = req.query.token as string;
    let token = '';
    if (authHeader && authHeader.startsWith('Bearer ')) {
      token = authHeader.split(' ')[1];
    } else if (authHeader) {
      token = authHeader;
    } else if (queryToken) {
      token = queryToken;
    }

    if (!token) {
      return res.status(401).json({ error: 'Требуется токен авторизации администратора' });
    }
    
    // Проверка подписи JWT токена с использованием криптостойкого секрета
    let decoded: any;
    try {
      decoded = jwt.verify(token, getJwtSecret());
    } catch (jwtErr) {
      return res.status(401).json({ error: 'Сессия недействительна или истекла' });
    }

    const db = await getDb();
    const userFromDb = await db.get(
      'SELECT id, username, role FROM users WHERE LOWER(username) = LOWER(?)', 
      [decoded.username || decoded.sub]
    );

    if (!userFromDb || (userFromDb.role !== 'ADMIN' && userFromDb.role !== 'MODERATOR')) {
      return res.status(401).json({ error: 'Доступ запрещен. Аккаунт был удален или права аннулированы.' });
    }

    (req as any).user = userFromDb;
    next();
  } catch (error) {
    return res.status(500).json({ error: 'Ошибка проверки авторизации' });
  }
};

// Функция записи в аудит-лог
export async function logAudit(adminUser: string, adminRole: string, actionType: string, targetName: string, details: string, ipAddress: string) {
  try {
    const db = await getDb();
    await db.run(
      'INSERT INTO audit_logs (admin_username, admin_role, action_type, target_name, details, ip_address) VALUES (?, ?, ?, ?, ?, ?)',
      [adminUser, adminRole, actionType, targetName, details, ipAddress]
    );
  } catch (err) {
    console.error('[AUDIT LOG ERROR]', err);
  }
}

// ----------------------------------------------------
// 0. ПРОВЕРКА ПРОФИЛЯ И УПРАВЛЕНИЕ АДМИНИСТРАТОРАМИ
// ----------------------------------------------------

// GET /api/v1/admin/me - Проверка статуса текущей сессии
router.get('/me', requireAdmin, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    return res.json({
      authenticated: true,
      user: {
        username: user.username,
        role: user.role
      }
    });
  } catch (error) {
    return res.status(500).json({ error: 'Ошибка проверки профиля' });
  }
});

// GET /api/v1/admin/admins - Список всех администраторов и модераторов
router.get('/admins', requireAdmin, async (req: Request, res: Response) => {
  try {
    const db = await getDb();
    const admins = await db.all(`
      SELECT id, username, role, last_ip, last_hwid, created_at 
      FROM users 
      ORDER BY id ASC
    `);
    return res.json({ admins: admins || [] });
  } catch (error) {
    return res.status(500).json({ error: 'Ошибка получения списка пользователей' });
  }
});

// POST /api/v1/admin/admins - Добавление нового пользователя, администратора или модератора
router.post('/admins', requireAdmin, async (req: Request, res: Response) => {
  try {
    const { username, password, role } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'Никнейм и пароль обязательны' });
    }
    const cleanNick = username.trim();
    if (cleanNick.length < 3 || cleanNick.length > 20) {
      return res.status(400).json({ error: 'Никнейм должен быть от 3 до 20 символов' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'Пароль должен содержать минимум 6 символов' });
    }
    let userRole = 'ADMIN';
    if (role === 'MODERATOR') userRole = 'MODERATOR';
    else if (role === 'PLAYER') userRole = 'PLAYER';

    const db = await getDb();
    const existing = await db.get("SELECT id FROM users WHERE LOWER(username) = LOWER(?)", [cleanNick]);
    const passwordHash = await bcrypt.hash(password, 10);

    if (existing) {
      await db.run(
        "UPDATE users SET password_hash = ?, role = ? WHERE id = ?",
        [passwordHash, userRole, existing.id]
      );
    } else {
      await db.run(
        "INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)",
        [cleanNick, passwordHash, userRole]
      );
    }

    const currentAdmin = (req as any).user?.username || 'Admin';
    await logAudit(currentAdmin, 'ADMIN', 'ADMIN_CREATE', cleanNick, `Создан/обновлен пользователь/админ с ролью ${userRole}`, req.ip || '');

    return res.json({ success: true, message: `Пользователь ${cleanNick} (${userRole}) успешно сохранен!` });
  } catch (error) {
    return res.status(500).json({ error: 'Ошибка добавления администратора: ' + (error as Error).message });
  }
});

// DELETE /api/v1/admin/admins/:id - Удаление администратора с немедленным сбросом всех его сессий
router.delete('/admins/:id', requireAdmin, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const db = await getDb();
    const targetUser = await db.get("SELECT * FROM users WHERE id = ?", [id]);
    if (!targetUser) {
      return res.status(404).json({ error: 'Пользователь не найден' });
    }

    // Проверяем, не является ли это последним главным администратором
    const adminCount = await db.get("SELECT COUNT(*) as cnt FROM users WHERE role = 'ADMIN'");
    if (targetUser.role === 'ADMIN' && (adminCount?.cnt || 0) <= 1) {
      return res.status(400).json({ error: 'Нельзя удалить единственного главного администратора системы' });
    }

    // 1. Удаляем пользователя из таблицы users
    await db.run("DELETE FROM users WHERE id = ?", [id]);

    // 2. Сбрасываем и удаляем ВСЕ активные сессии администратора
    await db.run("DELETE FROM sessions WHERE LOWER(username) = LOWER(?)", [targetUser.username]);

    const currentAdmin = (req as any).user?.username || 'Admin';
    await logAudit(currentAdmin, 'ADMIN', 'ADMIN_DELETE', targetUser.username, `Удален администратор и немедленно сброшены все его активные сессии`, req.ip || '');

    return res.json({ success: true, message: `Администратор ${targetUser.username} успешно удален, а его авторизация аннулирована!` });
  } catch (error) {
    return res.status(500).json({ error: 'Ошибка удаления администратора: ' + (error as Error).message });
  }
});
function tcpPingMinecraft(host: string, port: number): Promise<any> {
  return new Promise((resolve) => {
    const startTime = Date.now();
    const socket = new net.Socket();
    socket.setTimeout(2500);

    let resolved = false;

    socket.connect(port, host, () => {
      const hostBuffer = Buffer.from(host, 'utf8');
      const portBuffer = Buffer.alloc(2);
      portBuffer.writeUInt16BE(port, 0);

      // Packet ID 0x00 + Protocol Version 767 (1.21.1) + State 1 (Status)
      const handshake = Buffer.concat([
        Buffer.from([0x00]),
        Buffer.from([0xff, 0x05]),
        Buffer.from([hostBuffer.length]), hostBuffer,
        portBuffer,
        Buffer.from([0x01])
      ]);

      const fullHandshake = Buffer.concat([Buffer.from([handshake.length]), handshake]);
      socket.write(fullHandshake);
      socket.write(Buffer.from([0x01, 0x00]));
    });

    let dataBuffer = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      dataBuffer = Buffer.concat([dataBuffer, chunk]);
      const jsonMatch = dataBuffer.toString('utf8').match(/\{[\s\S]*"players"[\s\S]*\}/);
      if (jsonMatch && !resolved) {
        resolved = true;
        socket.destroy();
        try {
          const parsed = JSON.parse(jsonMatch[0]);
          resolve({
            online: true,
            ping_ms: Date.now() - startTime,
            players: parsed.players || { online: 0, max: 100 },
            version: parsed.version?.name || '1.21.1',
            motd: typeof parsed.description === 'string' ? parsed.description : (parsed.description?.text || 'VozduCraft Server')
          });
        } catch (e) {
          resolve({ online: true, ping_ms: Date.now() - startTime, players: { online: 0, max: 100 } });
        }
      }
    });

    const onFail = () => {
      if (!resolved) {
        resolved = true;
        socket.destroy();
        resolve({ online: false, players: { online: 0, max: 0 }, motd: 'Сервер оффлайн' });
      }
    };

    socket.on('error', onFail);
    socket.on('timeout', onFail);
  });
}

// ----------------------------------------------------
// 1. УПРАВЛЕНИЕ СЕРВЕРАМИ (МУЛЬТИСЕРВЕРНОСТЬ & МОДЛОАДЕРЫ)
// ----------------------------------------------------

// GET /api/v1/admin/servers - Список всех серверов
router.get('/servers', requireAdmin, async (req: Request, res: Response) => {
  try {
    const db = await getDb();
    const servers = await db.all(`
      SELECT s.*, 
        (SELECT COUNT(*) FROM modpack_files WHERE server_id = s.id) as mods_count 
      FROM servers s 
      ORDER BY s.is_default DESC, s.id ASC
    `);
    return res.json({ servers: servers || [] });
  } catch (error) {
    return res.status(500).json({ error: 'Ошибка получения списка серверов' });
  }
});

// POST /api/v1/admin/servers - Создание нового сервера
router.post('/servers', requireAdmin, async (req: Request, res: Response) => {
  try {
    const { 
      name, server_ip, server_port, minecraft_version, neoforge_version, 
      modloader, modloader_version, java_version, jvm_flags, min_ram_gb, 
      recommended_ram_gb, game_args, auto_join_server, description, is_default 
    } = req.body;

    if (!name || !server_ip) {
      return res.status(400).json({ error: 'Название и IP сервера обязательны' });
    }

    const db = await getDb();

    if (is_default) {
      await db.run('UPDATE servers SET is_default = 0');
    }

    const result = await db.run(`
      INSERT INTO servers (
        name, server_ip, server_port, minecraft_version, neoforge_version,
        modloader, modloader_version, java_version, jvm_flags, min_ram_gb,
        recommended_ram_gb, game_args, auto_join_server, description, is_default, is_active
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
    `, [
      name,
      server_ip,
      server_port ? parseInt(server_port, 10) : 25565,
      minecraft_version || '1.21.1',
      neoforge_version || '21.1.248',
      modloader || 'neoforge',
      modloader_version || neoforge_version || '21.1.248',
      java_version ? parseInt(java_version, 10) : 21,
      jvm_flags || '',
      min_ram_gb ? parseInt(min_ram_gb, 10) : 4,
      recommended_ram_gb ? parseInt(recommended_ram_gb, 10) : 6,
      game_args || '',
      auto_join_server !== undefined ? (auto_join_server ? 1 : 0) : 1,
      description || '',
      is_default ? 1 : 0
    ]);

    const adminUser = (req as any).user?.username || 'Admin';
    await logAudit(adminUser, 'ADMIN', 'SERVER_CREATE', name, `Создан сервер ${name} (${server_ip}:${server_port || 25565}, ModLoader: ${modloader || 'neoforge'})`, req.ip || '');

    return res.json({ success: true, serverId: result.lastID });
  } catch (error) {
    return res.status(500).json({ error: 'Ошибка создания сервера' });
  }
});

// PUT /api/v1/admin/servers/:id - Обновление параметров сервера, модлоадера и JVM
router.put('/servers/:id', requireAdmin, async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { 
      name, server_ip, server_port, minecraft_version, neoforge_version,
      modloader, modloader_version, java_version, jvm_flags, min_ram_gb,
      recommended_ram_gb, game_args, auto_join_server, description, is_default, is_active 
    } = req.body;

    const db = await getDb();

    if (is_default) {
      await db.run('UPDATE servers SET is_default = 0 WHERE id != ?', [id]);
    }

    await db.run(`
      UPDATE servers 
      SET name = ?, server_ip = ?, server_port = ?, minecraft_version = ?, neoforge_version = ?,
          modloader = ?, modloader_version = ?, java_version = ?, jvm_flags = ?, min_ram_gb = ?,
          recommended_ram_gb = ?, game_args = ?, auto_join_server = ?, description = ?, is_default = ?, is_active = ?
      WHERE id = ?
    `, [
      name,
      server_ip,
      server_port ? parseInt(server_port, 10) : 25565,
      minecraft_version || '1.21.1',
      neoforge_version || '21.1.248',
      modloader || 'neoforge',
      modloader_version || neoforge_version || '21.1.248',
      java_version ? parseInt(java_version, 10) : 21,
      jvm_flags || '',
      min_ram_gb ? parseInt(min_ram_gb, 10) : 4,
      recommended_ram_gb ? parseInt(recommended_ram_gb, 10) : 6,
      game_args || '',
      auto_join_server !== undefined ? (auto_join_server ? 1 : 0) : 1,
      description || '',
      is_default ? 1 : 0,
      is_active !== undefined ? (is_active ? 1 : 0) : 1,
      id
    ]);

    const adminUser = (req as any).user?.username || 'Admin';
    await logAudit(adminUser, 'ADMIN', 'SERVER_UPDATE', name || `ID:${id}`, `Обновлены параметры сервера ${id} (ModLoader: ${modloader || 'neoforge'})`, req.ip || '');

    return res.json({ success: true });
  } catch (error) {
    return res.status(500).json({ error: 'Ошибка обновления сервера' });
  }
});

// DELETE /api/v1/admin/servers/:id - Удаление сервера
router.delete('/servers/:id', requireAdmin, async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10);
    const db = await getDb();

    const server = await db.get('SELECT name FROM servers WHERE id = ?', [id]);
    await db.run('DELETE FROM servers WHERE id = ?', [id]);
    await db.run('DELETE FROM modpack_files WHERE server_id = ?', [id]);

    const adminUser = (req as any).user?.username || 'Admin';
    await logAudit(adminUser, 'ADMIN', 'SERVER_DELETE', server?.name || `ID:${id}`, `Удален сервер ${id} и привязанные файлы`, req.ip || '');

    return res.json({ success: true });
  } catch (error) {
    return res.status(500).json({ error: 'Ошибка удаления сервера' });
  }
});

// GET /api/v1/admin/servers/:id/ping - Живой прямой TCP пинг сервера
router.get('/servers/:id/ping', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10);
    const db = await getDb();
    const server = await db.get('SELECT * FROM servers WHERE id = ?', [id]);

    if (!server) return res.status(404).json({ online: false, error: 'Сервер не найден' });

    const pingResult = await tcpPingMinecraft(server.server_ip, server.server_port || 25565);
    return res.json(pingResult);
  } catch (error) {
    return res.json({ online: false, players: { online: 0, max: 0 } });
  }
});

// ----------------------------------------------------
// 2. УПРАВЛЕНИЕ СБОРКАМИ МОДОВ (ДЛЯ ВЫБРАННОГО СЕРВЕРА)
// ----------------------------------------------------

// GET /api/v1/admin/modpack - Список модов выбранного сервера
router.get('/modpack', requireAdmin, async (req: Request, res: Response) => {
  try {
    const serverId = req.query.serverId ? parseInt(req.query.serverId as string, 10) : 1;
    const db = await getDb();
    const files = await db.all("SELECT * FROM modpack_files WHERE server_id = ? ORDER BY mod_name ASC", [serverId]);
    return res.json({ files: files || [], serverId });
  } catch (error) {
    return res.status(500).json({ error: 'Ошибка получения состава сборки' });
  }
});

// POST /api/v1/admin/modpack/add-modrinth - Добавление мода из Modrinth в сборку сервера
router.post('/modpack/add-modrinth', requireAdmin, async (req: Request, res: Response) => {
  try {
    const { serverId, projectId, versionId } = req.body;
    if (!projectId || !versionId) return res.status(400).json({ error: 'projectId и versionId обязательны' });

    const targetServerId = serverId ? parseInt(serverId, 10) : 1;

    const vRes = await fetch(`https://api.modrinth.com/v2/version/${versionId}`);
    if (!vRes.ok) return res.status(404).json({ error: 'Версия не найдена на Modrinth' });
    const vData = await vRes.json();

    const pRes = await fetch(`https://api.modrinth.com/v2/project/${projectId}`);
    const pData = pRes.ok ? await pRes.json() : {};

    const primaryFile = vData.files.find((f: any) => f.primary) || vData.files[0];
    if (!primaryFile) return res.status(400).json({ error: 'У версии нет файлов для скачивания' });

    const modName = pData.title || vData.name || primaryFile.filename;
    const modDesc = pData.description || 'Установлено через Modrinth API';
    const filepath = `mods/${primaryFile.filename}`;

    const iconUrl = pData.icon_url || null;
    const db = await getDb();

    // Удаляем старую версию мода в этом сервере если была
    await db.run("DELETE FROM modpack_files WHERE server_id = ? AND filepath = ?", [targetServerId, filepath]);

    await db.run(`
      INSERT INTO modpack_files (server_id, filepath, sha256, size_bytes, is_optional, mod_name, mod_description, download_url, icon_url, group_name, allowed_users)
      VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, 'Общие', 'ALL')
    `, [
      targetServerId,
      filepath,
      primaryFile.hashes?.sha512 || primaryFile.hashes?.sha1 || 'MODRINTH_HASH',
      primaryFile.size,
      modName,
      modDesc,
      primaryFile.url,
      iconUrl
    ]);

    const adminUser = (req as any).user?.username || 'Admin';
    await logAudit(adminUser, 'ADMIN', 'MOD_ADD', modName, `Добавлен мод ${modName} в сборку сервера ${targetServerId}`, req.ip || '');

    return res.json({ success: true, modName, filepath, downloadUrl: primaryFile.url });
  } catch (error) {
    return res.status(500).json({ error: 'Ошибка добавления мода из Modrinth' });
  }
});

// POST /api/v1/admin/modpack/check-updates - Проверка обновлений всех модов сервера через Modrinth API
router.post('/modpack/check-updates', requireAdmin, async (req: Request, res: Response) => {
  try {
    const serverId = req.body.serverId ? parseInt(req.body.serverId, 10) : 1;
    const db = await getDb();
    const server = await db.get("SELECT * FROM servers WHERE id = ?", [serverId]);
    if (!server) {
      return res.status(404).json({ error: 'Сервер не найден' });
    }

    const mcVersion = server.minecraft_version || '1.21.1';
    let loader = (server.modloader || 'neoforge').toLowerCase().trim();
    if (loader === 'forge') loader = 'forge';
    else if (loader === 'fabric') loader = 'fabric';
    else if (loader === 'quilt') loader = 'quilt';
    else loader = 'neoforge';

    const modFiles = await db.all("SELECT * FROM modpack_files WHERE server_id = ?", [serverId]);
    if (!modFiles || modFiles.length === 0) {
      return res.json({
        totalChecked: 0,
        totalUpdates: 0,
        serverInfo: {
          id: server.id,
          name: server.name,
          minecraftVersion: mcVersion,
          modloader: loader
        },
        updates: []
      });
    }

    const modsStorageDir = path.resolve(__dirname, '../../public/files/mods');
    const filesDir = path.resolve(__dirname, '../../public/files');

    const hashesMap: Record<string, any> = {};
    const hashesList: string[] = [];

    for (const mf of modFiles) {
      const cleanName = path.basename(mf.filepath);
      let localPath = path.join(modsStorageDir, cleanName);
      if (!fs.existsSync(localPath)) {
        localPath = path.join(filesDir, mf.filepath);
      }

      if (fs.existsSync(localPath)) {
        try {
          const buf = fs.readFileSync(localPath);
          const sha1 = crypto.createHash('sha1').update(buf).digest('hex');
          hashesMap[sha1] = {
            ...mf,
            localPath,
            actualFilename: cleanName,
            sha1
          };
          hashesList.push(sha1);
        } catch (e) {}
      }
    }

    if (hashesList.length === 0) {
      return res.json({
        totalChecked: modFiles.length,
        totalUpdates: 0,
        serverInfo: {
          id: server.id,
          name: server.name,
          minecraftVersion: mcVersion,
          modloader: loader
        },
        updates: []
      });
    }

    // Запрос обновлений с Modrinth пачками по 100 хэшей
    const batchSize = 100;
    const allUpdatesMap: Record<string, any> = {};
    const projectIdsSet = new Set<string>();

    for (let i = 0; i < hashesList.length; i += batchSize) {
      const batch = hashesList.slice(i, i + batchSize);
      try {
        const updateRes = await fetch("https://api.modrinth.com/v2/version_files/update", {
          method: "POST",
          headers: { "Content-Type": "application/json", "User-Agent": "VozduCraft-Admin/1.0" },
          body: JSON.stringify({
            hashes: batch,
            algorithm: "sha1",
            loaders: [loader],
            game_versions: [mcVersion]
          })
        });
        if (updateRes.ok) {
          const batchData = await updateRes.json();
          for (const [h, verObj] of Object.entries(batchData as Record<string, any>)) {
            allUpdatesMap[h] = verObj;
            if (verObj.project_id) projectIdsSet.add(verObj.project_id);
          }
        }
      } catch (err) {
        console.error('[MODRINTH CHECK ERROR]', err);
      }
    }

    // Запрашиваем метаданные всех проектов для получения логотипов и ссылок на Modrinth
    const projectIdsList = Array.from(projectIdsSet);
    const projectsMap: Record<string, any> = {};

    for (let i = 0; i < projectIdsList.length; i += batchSize) {
      const pBatch = projectIdsList.slice(i, i + batchSize);
      try {
        const pRes = await fetch(`https://api.modrinth.com/v2/projects?ids=${encodeURIComponent(JSON.stringify(pBatch))}`, {
          headers: { "User-Agent": "VozduCraft-Admin/1.0" }
        });
        if (pRes.ok) {
          const pData = await pRes.json();
          for (const proj of (pData as any[])) {
            projectsMap[proj.id] = proj;
          }
        }
      } catch (pErr) {
        console.error('[MODRINTH PROJECTS ERROR]', pErr);
      }
    }

    // Формируем список доступных обновлений
    const availableUpdates: any[] = [];

    for (const [sha1, verObj] of Object.entries(allUpdatesMap)) {
      const currentMod = hashesMap[sha1];
      if (!currentMod) continue;

      const primaryFile = verObj.files?.find((f: any) => f.primary) || verObj.files?.[0];
      if (!primaryFile) continue;

      const newSha1 = primaryFile.hashes?.sha1;
      const newFilename = primaryFile.filename;

      // Проверяем, отличается ли новая версия от текущего файла
      if (newSha1 && newSha1.toLowerCase() === sha1.toLowerCase() && newFilename === currentMod.actualFilename) {
        continue;
      }

      const proj = projectsMap[verObj.project_id] || {};
      const modSlug = proj.slug || verObj.project_id;
      const modTitle = proj.title || currentMod.mod_name || currentMod.actualFilename.replace(/\.jar$/i, '');
      const iconUrl = proj.icon_url || null;
      const modrinthUrl = `https://modrinth.com/mod/${modSlug}`;

      availableUpdates.push({
        modId: currentMod.id,
        currentFilepath: currentMod.filepath,
        currentFilename: currentMod.actualFilename,
        currentModName: currentMod.mod_name || modTitle,
        currentSha1: sha1,
        newVersionId: verObj.id,
        newVersionName: verObj.name || verObj.version_number,
        newVersionNumber: verObj.version_number,
        newFilename: primaryFile.filename,
        newFileUrl: primaryFile.url,
        newFileSize: primaryFile.size,
        newSha512: primaryFile.hashes?.sha512 || null,
        newSha1: primaryFile.hashes?.sha1 || null,
        projectId: verObj.project_id,
        projectSlug: modSlug,
        projectTitle: modTitle,
        projectIcon: iconUrl,
        modrinthUrl: modrinthUrl,
        datePublished: verObj.date_published,
        changelog: verObj.changelog ? verObj.changelog.substring(0, 300) : ''
      });
    }

    return res.json({
      totalChecked: hashesList.length,
      totalUpdates: availableUpdates.length,
      serverInfo: {
        id: server.id,
        name: server.name,
        minecraftVersion: mcVersion,
        modloader: loader
      },
      updates: availableUpdates
    });
  } catch (error) {
    return res.status(500).json({ error: 'Ошибка проверки обновлений: ' + (error as Error).message });
  }
});

// POST /api/v1/admin/modpack/apply-update - Применение обновления мода из Modrinth
router.post('/modpack/apply-update', requireAdmin, async (req: Request, res: Response) => {
  try {
    const { serverId, oldFilepath, newFileUrl, newFilename, modName, modDescription } = req.body;
    if (!newFileUrl || !newFilename) {
      return res.status(400).json({ error: 'newFileUrl и newFilename обязательны' });
    }

    const targetServerId = serverId ? parseInt(serverId, 10) : 1;
    const cleanFilename = path.basename(newFilename);
    const modsStorageDir = path.resolve(__dirname, '../../public/files/mods');

    if (!fs.existsSync(modsStorageDir)) {
      fs.mkdirSync(modsStorageDir, { recursive: true });
    }

    // Скачиваем обновленный .jar файл с CDN Modrinth
    const response = await fetch(newFileUrl);
    if (!response.ok) {
      return res.status(502).json({ error: `Не удалось скачать файл мода с Modrinth (${response.status})` });
    }

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
    const targetFilePath = path.join(modsStorageDir, cleanFilename);

    fs.writeFileSync(targetFilePath, buffer);

    const relativePath = `mods/${cleanFilename}`;
    const name = modName || cleanFilename.replace(/\.jar$/i, '');
    const desc = modDescription || 'Обновлено через Modrinth';
    const downloadUrl = `http://localhost:3000/files/mods/${cleanFilename}`;

    const db = await getDb();

    // Удаляем старый файл с диска, если имя файла изменилось
    if (oldFilepath) {
      const oldCleanName = path.basename(oldFilepath);
      if (oldCleanName !== cleanFilename) {
        const oldDiskPath = path.join(modsStorageDir, oldCleanName);
        if (fs.existsSync(oldDiskPath)) {
          try { fs.unlinkSync(oldDiskPath); } catch (e) {}
        }
      }
      await db.run("DELETE FROM modpack_files WHERE server_id = ? AND filepath = ?", [targetServerId, oldFilepath]);
    }

    // Удаляем дублирующую запись с таким же целевым filepath
    await db.run("DELETE FROM modpack_files WHERE server_id = ? AND filepath = ?", [targetServerId, relativePath]);

    await db.run(`
      INSERT INTO modpack_files (server_id, filepath, sha256, size_bytes, is_optional, mod_name, mod_description, download_url)
      VALUES (?, ?, ?, ?, 0, ?, ?, ?)
    `, [
      targetServerId,
      relativePath,
      sha256,
      buffer.length,
      name,
      desc,
      downloadUrl
    ]);

    const adminUser = (req as any).user?.username || 'Admin';
    await logAudit(adminUser, 'ADMIN', 'MOD_UPDATE', name, `Обновлен мод ${name} (файл ${cleanFilename}, ${buffer.length} B) для сервера ${targetServerId}`, req.ip || '');

    return res.json({
      success: true,
      filename: cleanFilename,
      filepath: relativePath,
      sha256,
      sizeBytes: buffer.length,
      downloadUrl: `/files/mods/${cleanFilename}`,
      directCdnUrl: newFileUrl
    });
  } catch (error) {
    return res.status(500).json({ error: 'Ошибка применения обновления мода: ' + (error as Error).message });
  }
});

// POST /api/v1/admin/modpack/batch-update-and-zip - Пакетное обновление всех модов с архивацией в ZIP и выдачей ссылки на скачивание
router.post('/modpack/batch-update-and-zip', requireAdmin, async (req: Request, res: Response) => {
  try {
    const { serverId, updates } = req.body;
    if (!updates || !Array.isArray(updates) || updates.length === 0) {
      return res.status(400).json({ error: 'Список updates обязателен' });
    }

    const targetServerId = serverId ? parseInt(serverId, 10) : 1;
    const modsStorageDir = path.resolve(__dirname, '../../public/files/mods');
    const tempDir = path.resolve(__dirname, '../../public/files/temp');

    if (!fs.existsSync(modsStorageDir)) {
      fs.mkdirSync(modsStorageDir, { recursive: true });
    }
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    const db = await getDb();
    const server = await db.get("SELECT name FROM servers WHERE id = ?", [targetServerId]);
    const serverName = (server?.name || `server_${targetServerId}`).replace(/[^a-zA-Z0-9_\-]/g, '_');

    const updatedFilesOnDisk: { filename: string; filePath: string }[] = [];
    const errors: string[] = [];

    const zip = new AdmZip();

    for (const item of updates) {
      try {
        if (!item.newFileUrl || !item.newFilename) continue;

        const cleanFilename = path.basename(item.newFilename);
        const targetFilePath = path.join(modsStorageDir, cleanFilename);

        // Скачиваем обновленный .jar
        const response = await fetch(item.newFileUrl);
        if (!response.ok) {
          errors.push(`Не удалось скачать ${cleanFilename} (${response.status})`);
          continue;
        }

        const arrayBuffer = await response.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');

        fs.writeFileSync(targetFilePath, buffer);

        // Добавляем файл в ZIP-архив
        zip.addFile(cleanFilename, buffer);
        updatedFilesOnDisk.push({ filename: cleanFilename, filePath: targetFilePath });

        const relativePath = `mods/${cleanFilename}`;
        const name = item.modName || cleanFilename.replace(/\.jar$/i, '');
        const desc = item.modDescription || 'Обновлено через Modrinth Batch';
        const downloadUrl = `http://localhost:3000/files/mods/${cleanFilename}`;

        // Удаляем старый файл с диска, если имя файла изменилось
        if (item.oldFilepath) {
          const oldCleanName = path.basename(item.oldFilepath);
          if (oldCleanName !== cleanFilename) {
            const oldDiskPath = path.join(modsStorageDir, oldCleanName);
            if (fs.existsSync(oldDiskPath)) {
              try { fs.unlinkSync(oldDiskPath); } catch (e) {}
            }
          }
          await db.run("DELETE FROM modpack_files WHERE server_id = ? AND filepath = ?", [targetServerId, item.oldFilepath]);
        }

        await db.run("DELETE FROM modpack_files WHERE server_id = ? AND filepath = ?", [targetServerId, relativePath]);

        await db.run(`
          INSERT INTO modpack_files (server_id, filepath, sha256, size_bytes, is_optional, mod_name, mod_description, download_url)
          VALUES (?, ?, ?, ?, 0, ?, ?, ?)
        `, [
          targetServerId,
          relativePath,
          sha256,
          buffer.length,
          name,
          desc,
          downloadUrl
        ]);
      } catch (err: any) {
        errors.push(`Ошибка обработки ${item.newFilename}: ${err.message}`);
      }
    }

    if (updatedFilesOnDisk.length === 0) {
      return res.status(500).json({ error: 'Не удалось обновить ни один мод: ' + errors.join('; ') });
    }

    // Сохраняем готовый ZIP-архив
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const zipFilename = `updated_mods_${serverName}_${timestamp}.zip`;
    const zipFilePath = path.join(tempDir, zipFilename);

    zip.writeZip(zipFilePath);

    const zipStat = fs.statSync(zipFilePath);

    const adminUser = (req as any).user?.username || 'Admin';
    await logAudit(adminUser, 'ADMIN', 'MODS_BATCH_UPDATE_ZIP', serverName, `Пакетно обновлено ${updatedFilesOnDisk.length} модов, создан ZIP архив (${(zipStat.size / (1024 * 1024)).toFixed(2)} MB)`, req.ip || '');

    return res.json({
      success: true,
      updatedCount: updatedFilesOnDisk.length,
      errors: errors.length > 0 ? errors : undefined,
      zipFilename: zipFilename,
      zipDownloadUrl: `/files/temp/${zipFilename}`,
      zipSizeBytes: zipStat.size
    });
  } catch (error) {
    return res.status(500).json({ error: 'Ошибка пакетного обновления и архивации: ' + (error as Error).message });
  }
});

function normalizeSftpTarget(rawHost: string, rawPort?: any, rawUsername?: string) {
  let host = (rawHost || '').trim();
  let port = rawPort ? parseInt(String(rawPort), 10) : 22;
  let username = (rawUsername || '').trim();

  // Удаляем протоколы: sftp://, ssh://, ftp://
  if (/^(sftp|ssh|ftp):\/\//i.test(host)) {
    host = host.replace(/^(sftp|ssh|ftp):\/\//i, '');
  }

  // Извлекаем username если в формате user@host
  if (host.includes('@')) {
    const atParts = host.split('@');
    if (!username && atParts[0]) {
      username = atParts[0].trim();
    }
    host = atParts.slice(1).join('@');
  }

  // Извлекаем порт если в формате host:port
  if (host.includes(':')) {
    const colonParts = host.split(':');
    host = colonParts[0].trim();
    const p = parseInt(colonParts[1], 10);
    if (!isNaN(p) && p > 0) {
      port = p;
    }
  }

  // Удаляем слеши или путь на конце если есть
  if (host.includes('/')) {
    host = host.split('/')[0].trim();
  }

  return { host, port: isNaN(port) ? 22 : port, username };
}

// POST /api/v1/admin/modpack/sftp-test-scan - Проверка подключения к SFTP игрового сервера и сканирование папки модов
router.post('/modpack/sftp-test-scan', requireAdmin, async (req: Request, res: Response) => {
  const { host: rawHost, port: rawPort, username: rawUsername, password, privateKey, remotePath, updates } = req.body;
  const { host, port: sftpPort, username } = normalizeSftpTarget(rawHost, rawPort, rawUsername);

  if (!host || !username || (!password && !privateKey)) {
    return res.status(400).json({ error: 'Хост, логин и пароль/ключ SFTP обязательны' });
  }

  const sftp = new SftpClient();
  const targetRemotePath = remotePath ? remotePath.trim() : 'mods';

  try {
    const config: SftpClient.ConnectOptions = {
      host: host,
      port: sftpPort,
      username: username,
      readyTimeout: 10000,
      retries: 1
    };

    if (privateKey) {
      config.privateKey = privateKey;
    } else {
      config.password = password;
    }

    await sftp.connect(config);

    // Проверяем существование папки модов
    let realPath = targetRemotePath;
    let fileList: SftpClient.FileInfo[] = [];

    try {
      const exists = await sftp.exists(realPath);
      if (!exists) {
        if (await sftp.exists('/mods')) realPath = '/mods';
        else if (await sftp.exists('./mods')) realPath = './mods';
      }
      fileList = await sftp.list(realPath);
    } catch (listErr) {
      try {
        fileList = await sftp.list('.');
        realPath = '.';
      } catch (e) {
        throw new Error(`Не удалось прочитать директорию "${targetRemotePath}" на SFTP: ${(listErr as Error).message}`);
      }
    }

    const remoteFilenames = new Set(fileList.map(f => f.name.toLowerCase()));

    // Сверяем с модами на обновление
    const matchedUpdates: any[] = [];
    if (updates && Array.isArray(updates)) {
      for (const item of updates) {
        const oldName = item.currentFilename ? item.currentFilename.toLowerCase() : '';
        const existsOnRemote = oldName && remoteFilenames.has(oldName);
        matchedUpdates.push({
          ...item,
          existsOnRemote: !!existsOnRemote,
          remoteOldFile: existsOnRemote ? item.currentFilename : null
        });
      }
    }

    await sftp.end();

    return res.json({
      success: true,
      message: 'Подключение к SFTP успешно установлено!',
      remotePath: realPath,
      totalRemoteFiles: fileList.length,
      matchedUpdates: matchedUpdates
    });
  } catch (err: any) {
    try { await sftp.end(); } catch (e) {}
    return res.status(500).json({ error: 'Ошибка SFTP подключения: ' + (err.message || 'Не удалось соединиться с сервером') });
  }
});

// POST /api/v1/admin/modpack/sftp-deploy-updates - Полный цикл обновления модов: скачивание, обновление лаунчера и замена файлов на Minecraft сервере через SFTP
router.post('/modpack/sftp-deploy-updates', requireAdmin, async (req: Request, res: Response) => {
  const { host: rawHost, port: rawPort, username: rawUsername, password, privateKey, remotePath, serverId, updates } = req.body;
  const { host, port: sftpPort, username } = normalizeSftpTarget(rawHost, rawPort, rawUsername);

  if (!host || !username || (!password && !privateKey)) {
    return res.status(400).json({ error: 'Учетные данные SFTP обязательны' });
  }
  if (!updates || !Array.isArray(updates) || updates.length === 0) {
    return res.status(400).json({ error: 'Список updates пуст' });
  }

  const targetServerId = serverId ? parseInt(serverId, 10) : 1;
  const targetRemotePath = remotePath ? remotePath.trim() : 'mods';

  const modsStorageDir = path.resolve(__dirname, '../../public/files/mods');
  if (!fs.existsSync(modsStorageDir)) {
    fs.mkdirSync(modsStorageDir, { recursive: true });
  }

  const db = await getDb();
  const server = await db.get("SELECT name FROM servers WHERE id = ?", [targetServerId]);
  const serverName = server?.name || `Server_${targetServerId}`;

  const downloadedUpdates: {
    cleanFilename: string;
    buffer: Buffer;
    oldCleanName?: string;
    item: any;
  }[] = [];
  const errors: string[] = [];

  // 1. Скачиваем все моды и обновляем локальный лаунчер
  for (const item of updates) {
    try {
      if (!item.newFileUrl || !item.newFilename) continue;

      const cleanFilename = path.basename(item.newFilename);
      const targetFilePath = path.join(modsStorageDir, cleanFilename);

      const response = await fetch(item.newFileUrl);
      if (!response.ok) {
        errors.push(`Не удалось скачать ${cleanFilename} (${response.status})`);
        continue;
      }

      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');

      fs.writeFileSync(targetFilePath, buffer);

      const relativePath = `mods/${cleanFilename}`;
      const name = item.modName || cleanFilename.replace(/\.jar$/i, '');
      const desc = item.modDescription || 'Обновлено через Modrinth SFTP Deploy';
      const downloadUrl = `http://localhost:3000/files/mods/${cleanFilename}`;

      let oldCleanName: string | undefined;
      if (item.oldFilepath) {
        oldCleanName = path.basename(item.oldFilepath);
        if (oldCleanName !== cleanFilename) {
          const oldDiskPath = path.join(modsStorageDir, oldCleanName);
          if (fs.existsSync(oldDiskPath)) {
            try { fs.unlinkSync(oldDiskPath); } catch (e) {}
          }
        }
        await db.run("DELETE FROM modpack_files WHERE server_id = ? AND filepath = ?", [targetServerId, item.oldFilepath]);
      }

      await db.run("DELETE FROM modpack_files WHERE server_id = ? AND filepath = ?", [targetServerId, relativePath]);

      await db.run(`
        INSERT INTO modpack_files (server_id, filepath, sha256, size_bytes, is_optional, mod_name, mod_description, download_url)
        VALUES (?, ?, ?, ?, 0, ?, ?, ?)
      `, [
        targetServerId,
        relativePath,
        sha256,
        buffer.length,
        name,
        desc,
        downloadUrl
      ]);

      downloadedUpdates.push({
        cleanFilename,
        buffer,
        oldCleanName,
        item
      });
    } catch (err: any) {
      errors.push(`Ошибка загрузки ${item.newFilename}: ${err.message}`);
    }
  }

  if (downloadedUpdates.length === 0) {
    return res.status(500).json({ error: 'Не удалось подготовить файлы модов: ' + errors.join('; ') });
  }

  // 2. Подключаемся по SFTP и заменяем моды на удаленном Minecraft сервере
  const sftp = new SftpClient();
  let sftpUploadedCount = 0;
  let sftpDeletedCount = 0;

  try {
    const config: SftpClient.ConnectOptions = {
      host: host.trim(),
      port: sftpPort,
      username: username.trim(),
      readyTimeout: 15000,
      retries: 1
    };

    if (privateKey) config.privateKey = privateKey;
    else config.password = password;

    await sftp.connect(config);

    // Нормализуем удаленный путь
    let realPath = targetRemotePath;
    try {
      if (!(await sftp.exists(realPath))) {
        if (await sftp.exists('/mods')) realPath = '/mods';
        else if (await sftp.exists('./mods')) realPath = './mods';
      }
    } catch (e) {}

    for (const d of downloadedUpdates) {
      try {
        const remoteDestFile = `${realPath.replace(/\/+$/, '')}/${d.cleanFilename}`;

        // Загружаем новый файл на SFTP
        await sftp.put(d.buffer, remoteDestFile);
        sftpUploadedCount++;

        // Если старый файл отличался по имени, удаляем старый .jar на сервере
        if (d.oldCleanName && d.oldCleanName !== d.cleanFilename) {
          const remoteOldFile = `${realPath.replace(/\/+$/, '')}/${d.oldCleanName}`;
          try {
            if (await sftp.exists(remoteOldFile)) {
              await sftp.delete(remoteOldFile);
              sftpDeletedCount++;
            }
          } catch (delErr) {
            // Игнорируем если старого файла не было на сервере
          }
        }
      } catch (uploadErr: any) {
        errors.push(`Ошибка заливки на SFTP ${d.cleanFilename}: ${uploadErr.message}`);
      }
    }

    await sftp.end();

    const adminUser = (req as any).user?.username || 'Admin';
    await logAudit(adminUser, 'ADMIN', 'MODS_SFTP_DEPLOY', serverName, `Обновлено ${downloadedUpdates.length} модов в лаунчере и ${sftpUploadedCount} на Minecraft сервере (${host}:${sftpPort}${realPath})`, req.ip || '');

    return res.json({
      success: true,
      updatedInLauncher: downloadedUpdates.length,
      uploadedToSftp: sftpUploadedCount,
      deletedOldOnSftp: sftpDeletedCount,
      errors: errors.length > 0 ? errors : undefined,
      remotePath: realPath
    });
  } catch (sftpErr: any) {
    try { await sftp.end(); } catch (e) {}
    return res.status(500).json({
      error: `Лаунчер обновлен (${downloadedUpdates.length} модов), но произошла ошибка SFTP передачи на сервер: ${sftpErr.message}`
    });
  }
});

// POST /api/v1/admin/modpack/upload - Загрузка локального файла мода (.jar / .zip)
router.post('/modpack/upload', requireAdmin, async (req: Request, res: Response) => {
  try {
    const { serverId, filename, base64Data, modName, modDescription, isOptional, groupName, allowedUsers, iconUrl } = req.body;
    if (!filename || !base64Data) {
      return res.status(400).json({ error: 'Имя файла и base64Data обязательны' });
    }

    const targetServerId = serverId ? parseInt(serverId, 10) : 1;
    const cleanFilename = path.basename(filename);
    const modsStorageDir = path.resolve(__dirname, '../../public/files/mods');
    
    if (!fs.existsSync(modsStorageDir)) {
      fs.mkdirSync(modsStorageDir, { recursive: true });
    }

    const buffer = Buffer.from(base64Data, 'base64');
    const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
    const targetFilePath = path.join(modsStorageDir, cleanFilename);

    fs.writeFileSync(targetFilePath, buffer);

    const relativePath = `mods/${cleanFilename}`;
    const name = modName || cleanFilename.replace(/\.jar$/i, '');
    const desc = modDescription || 'Загружено администратором';
    const downloadUrl = `http://localhost:3000/files/mods/${cleanFilename}`;

    let normUsers = 'ALL';
    if (Array.isArray(allowedUsers)) {
      normUsers = JSON.stringify(allowedUsers.map((u: string) => u.trim()).filter(Boolean));
    } else if (typeof allowedUsers === 'string') {
      normUsers = allowedUsers.trim();
    }

    const db = await getDb();
    await db.run("DELETE FROM modpack_files WHERE server_id = ? AND filepath = ?", [targetServerId, relativePath]);
    await db.run(`
      INSERT INTO modpack_files (server_id, filepath, sha256, size_bytes, is_optional, mod_name, mod_description, download_url, icon_url, group_name, allowed_users)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      targetServerId,
      relativePath,
      sha256,
      buffer.length,
      isOptional ? 1 : 0,
      name,
      desc,
      downloadUrl,
      iconUrl || null,
      groupName || 'Общие',
      normUsers
    ]);

    const adminUser = (req as any).user?.username || 'Admin';
    await logAudit(adminUser, 'ADMIN', 'MOD_UPLOAD', name, `Загружен локальный мод ${cleanFilename} (${buffer.length} B) для сервера ${targetServerId}`, req.ip || '');

    return res.json({ success: true, filename: cleanFilename, sha256, sizeBytes: buffer.length });
  } catch (error) {
    return res.status(500).json({ error: 'Ошибка сохранения файла мода' });
  }
});

// POST /api/v1/admin/modpack/copy-from-server - Заимствование (копирование) модов из другой сборки
router.post('/modpack/copy-from-server', requireAdmin, async (req: Request, res: Response) => {
  try {
    const { targetServerId, sourceServerId, onlyOptional, modIds } = req.body;
    if (!targetServerId || !sourceServerId) {
      return res.status(400).json({ error: 'targetServerId и sourceServerId обязательны' });
    }

    const db = await getDb();
    let query = "SELECT * FROM modpack_files WHERE server_id = ?";
    const params: any[] = [sourceServerId];

    if (onlyOptional) {
      query += " AND is_optional = 1";
    }

    if (Array.isArray(modIds) && modIds.length > 0) {
      query += ` AND id IN (${modIds.map(() => '?').join(',')})`;
      params.push(...modIds);
    }

    const sourceMods = await db.all(query, params);
    if (!sourceMods || sourceMods.length === 0) {
      return res.json({ success: true, count: 0, message: 'Не найдено модов для копирования' });
    }

    let copiedCount = 0;
    for (const mod of sourceMods) {
      await db.run("DELETE FROM modpack_files WHERE server_id = ? AND filepath = ?", [targetServerId, mod.filepath]);
      await db.run(`
        INSERT INTO modpack_files (server_id, filepath, sha256, size_bytes, is_optional, mod_name, mod_description, download_url)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        targetServerId,
        mod.filepath,
        mod.sha256,
        mod.size_bytes,
        mod.is_optional,
        mod.mod_name,
        mod.mod_description,
        mod.download_url
      ]);
      copiedCount++;
    }

    const adminUser = (req as any).user?.username || 'Admin';
    await logAudit(adminUser, 'ADMIN', 'MOD_COPY', `Сервер ${sourceServerId} -> ${targetServerId}`, `Скопировано ${copiedCount} модов`, req.ip || '');

    return res.json({ success: true, count: copiedCount });
  } catch (error) {
    return res.status(500).json({ error: 'Ошибка копирования модов между серверами' });
  }
});

// DELETE /api/v1/admin/modpack/:id - Удаление мода из сборки
router.delete('/modpack/:id', requireAdmin, async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10);
    const db = await getDb();
    const file = await db.get("SELECT * FROM modpack_files WHERE id = ?", [id]);
    await db.run("DELETE FROM modpack_files WHERE id = ?", [id]);

    const adminUser = (req as any).user?.username || 'Admin';
    await logAudit(adminUser, 'ADMIN', 'MOD_DELETE', file?.mod_name || `ID:${id}`, `Удален мод ${file?.filepath} из сервера ${file?.server_id}`, req.ip || '');

    return res.json({ success: true });
  } catch (error) {
    return res.status(500).json({ error: 'Ошибка удаления файла из сборки' });
  }
});

// POST /api/v1/admin/modpack/bulk-delete - Массовое удаление модов
router.post('/modpack/bulk-delete', requireAdmin, async (req: Request, res: Response) => {
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: 'Список ID модов не предоставлен' });
    }

    const db = await getDb();
    const placeholders = ids.map(() => '?').join(',');
    await db.run(`DELETE FROM modpack_files WHERE id IN (${placeholders})`, ids);

    const adminUser = (req as any).user?.username || 'Admin';
    await logAudit(adminUser, 'ADMIN', 'MOD_BULK_DELETE', `${ids.length} модов`, `Массово удалено ${ids.length} модов`, req.ip || '');

    return res.json({ success: true, deletedCount: ids.length });
  } catch (error) {
    return res.status(500).json({ error: 'Ошибка массового удаления модов' });
  }
});

// POST /api/v1/admin/modpack/bulk-set-optional - Массовая смена опциональности модов
router.post('/modpack/bulk-set-optional', requireAdmin, async (req: Request, res: Response) => {
  try {
    const { ids, is_optional } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: 'Список ID модов не предоставлен' });
    }

    const targetOpt = is_optional ? 1 : 0;
    const db = await getDb();
    const placeholders = ids.map(() => '?').join(',');
    await db.run(`UPDATE modpack_files SET is_optional = ? WHERE id IN (${placeholders})`, [targetOpt, ...ids]);

    const adminUser = (req as any).user?.username || 'Admin';
    await logAudit(adminUser, 'ADMIN', 'MOD_BULK_OPTIONAL', `${ids.length} модов`, `Установлен статус опциональности (${targetOpt}) для ${ids.length} модов`, req.ip || '');

    return res.json({ success: true, updatedCount: ids.length, is_optional: targetOpt });
  } catch (error) {
    return res.status(500).json({ error: 'Ошибка массового изменения статуса опциональности' });
  }
});

// POST /api/v1/admin/modpack/bulk-edit-details - Массовое изменение группы и прав доступа для выбранных модов
router.post('/modpack/bulk-edit-details', requireAdmin, async (req: Request, res: Response) => {
  try {
    const { ids, group_name, allowed_users, is_optional } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: 'Список ID модов не предоставлен' });
    }

    let normUsers: string | undefined = undefined;
    if (allowed_users !== undefined && allowed_users !== null) {
      if (Array.isArray(allowed_users)) {
        normUsers = JSON.stringify(allowed_users.map((u: string) => u.trim()).filter(Boolean));
      } else if (typeof allowed_users === 'string') {
        normUsers = allowed_users.trim();
      }
    }

    const db = await getDb();
    const placeholders = ids.map(() => '?').join(',');

    const updates: string[] = [];
    const params: any[] = [];

    if (group_name !== undefined && group_name !== null && group_name.trim() !== '') {
      updates.push('group_name = ?');
      params.push(group_name.trim());
    }
    if (normUsers !== undefined) {
      updates.push('allowed_users = ?');
      params.push(normUsers);
    }
    if (is_optional !== undefined && is_optional !== null && is_optional !== '') {
      updates.push('is_optional = ?');
      params.push(is_optional === true || is_optional === 1 || is_optional === '1' ? 1 : 0);
    }

    if (updates.length > 0) {
      params.push(...ids);
      await db.run(`UPDATE modpack_files SET ${updates.join(', ')} WHERE id IN (${placeholders})`, params);
    }

    const adminUser = (req as any).user?.username || 'Admin';
    await logAudit(adminUser, 'ADMIN', 'MOD_BULK_EDIT', `${ids.length} модов`, `Групповое изменение параметров для ${ids.length} модов`, req.ip || '');

    return res.json({ success: true, updatedCount: ids.length });
  } catch (error) {
    return res.status(500).json({ error: 'Ошибка группового изменения модов' });
  }
});

// POST /api/v1/admin/modpack/group-manager - Централизованное управление группой (переименование, удаление, смена прав, массовый статус)
router.post('/modpack/group-manager', requireAdmin, async (req: Request, res: Response) => {
  try {
    const { serverId, action, groupName, newGroupName, allowedUsers, isOptional, modIds } = req.body;
    if (!serverId || !action) {
      return res.status(400).json({ error: 'serverId и action обязательны' });
    }

    const sId = parseInt(serverId, 10);
    const db = await getDb();
    const adminUser = (req as any).user?.username || 'Admin';

    if (action === 'set-access') {
      if (!groupName) return res.status(400).json({ error: 'Имя группы не указано' });
      let normUsers = 'ALL';
      if (allowedUsers !== undefined && allowedUsers !== null) {
        if (Array.isArray(allowedUsers)) {
          normUsers = JSON.stringify(allowedUsers.map((u: string) => u.trim()).filter(Boolean));
        } else if (typeof allowedUsers === 'string') {
          normUsers = allowedUsers.trim();
        }
      }
      await db.run(
        'UPDATE modpack_files SET allowed_users = ? WHERE server_id = ? AND group_name = ?',
        [normUsers, sId, groupName]
      );
      await logAudit(adminUser, 'ADMIN', 'GROUP_ACCESS_UPDATE', groupName, `Обновлены права доступа для группы ${groupName} (сервер #${sId})`, req.ip || '');
      return res.json({ success: true, groupName, allowedUsers: normUsers });
    }

    if (action === 'rename-group') {
      if (!groupName || !newGroupName || !newGroupName.trim()) {
        return res.status(400).json({ error: 'Укажите старое и новое имя группы' });
      }
      const trimmedNew = newGroupName.trim();
      await db.run(
        'UPDATE modpack_files SET group_name = ? WHERE server_id = ? AND group_name = ?',
        [trimmedNew, sId, groupName]
      );
      await logAudit(adminUser, 'ADMIN', 'GROUP_RENAME', `${groupName} -> ${trimmedNew}`, `Переименование группы модов (сервер #${sId})`, req.ip || '');
      return res.json({ success: true, oldName: groupName, newName: trimmedNew });
    }

    if (action === 'delete-group') {
      if (!groupName) return res.status(400).json({ error: 'Имя группы не указано' });
      // Моды не удаляются с диска, а перемещаются в группу 'Общие' со сбросом прав на ALL
      await db.run(
        "UPDATE modpack_files SET group_name = 'Общие', allowed_users = 'ALL' WHERE server_id = ? AND group_name = ?",
        [sId, groupName]
      );
      await logAudit(adminUser, 'ADMIN', 'GROUP_DELETE', groupName, `Группа ${groupName} расформирована в Общие (сервер #${sId})`, req.ip || '');
      return res.json({ success: true, groupName });
    }

    if (action === 'set-optional') {
      if (!groupName) return res.status(400).json({ error: 'Имя группы не указано' });
      const optVal = isOptional === true || isOptional === 1 || isOptional === '1' ? 1 : 0;
      await db.run(
        'UPDATE modpack_files SET is_optional = ? WHERE server_id = ? AND group_name = ?',
        [optVal, sId, groupName]
      );
      await logAudit(adminUser, 'ADMIN', 'GROUP_OPTIONAL_UPDATE', groupName, `Смена статуса обязательности для группы ${groupName} на ${optVal} (сервер #${sId})`, req.ip || '');
      return res.json({ success: true, groupName, isOptional: optVal });
    }

    if (action === 'add-mods') {
      if (!groupName || !Array.isArray(modIds) || modIds.length === 0) {
        return res.status(400).json({ error: 'Не указаны моды или имя группы' });
      }
      const placeholders = modIds.map(() => '?').join(',');
      let query = `UPDATE modpack_files SET group_name = ?`;
      const params: any[] = [groupName.trim()];

      if (allowedUsers !== undefined) {
        let normUsers = 'ALL';
        if (Array.isArray(allowedUsers)) {
          normUsers = JSON.stringify(allowedUsers.map((u: string) => u.trim()).filter(Boolean));
        } else if (typeof allowedUsers === 'string') {
          normUsers = allowedUsers.trim();
        }
        query += `, allowed_users = ?`;
        params.push(normUsers);
      }

      query += ` WHERE server_id = ? AND id IN (${placeholders})`;
      params.push(sId, ...modIds);

      await db.run(query, params);
      await logAudit(adminUser, 'ADMIN', 'GROUP_ADD_MODS', `${modIds.length} модов`, `Добавление ${modIds.length} модов в группу ${groupName} (сервер #${sId})`, req.ip || '');
      return res.json({ success: true, count: modIds.length, groupName });
    }

    if (action === 'remove-mods') {
      if (!Array.isArray(modIds) || modIds.length === 0) {
        return res.status(400).json({ error: 'Не указаны моды' });
      }
      const placeholders = modIds.map(() => '?').join(',');
      await db.run(
        `UPDATE modpack_files SET group_name = 'Общие', allowed_users = 'ALL' WHERE server_id = ? AND id IN (${placeholders})`,
        [sId, ...modIds]
      );
      await logAudit(adminUser, 'ADMIN', 'GROUP_REMOVE_MODS', `${modIds.length} модов`, `Удаление ${modIds.length} модов из группы в Общие (сервер #${sId})`, req.ip || '');
      return res.json({ success: true, count: modIds.length });
    }

    return res.status(400).json({ error: 'Неизвестное действие' });
  } catch (error) {
    return res.status(500).json({ error: 'Ошибка выполнения действия с группой' });
  }
});

// PATCH /api/v1/admin/modpack/:id/toggle-optional - Переключение статуса опциональности
router.patch('/modpack/:id/toggle-optional', requireAdmin, async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10);
    const db = await getDb();
    await db.run("UPDATE modpack_files SET is_optional = CASE WHEN is_optional = 1 THEN 0 ELSE 1 END WHERE id = ?", [id]);
    const file = await db.get("SELECT is_optional FROM modpack_files WHERE id = ?", [id]);
    return res.json({ success: true, is_optional: file?.is_optional });
  } catch (error) {
    return res.status(500).json({ error: 'Ошибка изменения статуса опциональности' });
  }
});

// PATCH /api/v1/admin/modpack/:id/details - Изменение параметров мода (Группа, доступ, иконка, описание)
router.patch('/modpack/:id/details', requireAdmin, async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { mod_name, mod_description, group_name, allowed_users, icon_url, is_optional } = req.body;
    const db = await getDb();

    let normUsers = 'ALL';
    if (Array.isArray(allowed_users)) {
      normUsers = JSON.stringify(allowed_users.map((u: string) => u.trim()).filter(Boolean));
    } else if (typeof allowed_users === 'string') {
      normUsers = allowed_users.trim();
    }

    await db.run(`
      UPDATE modpack_files 
      SET mod_name = COALESCE(?, mod_name),
          mod_description = COALESCE(?, mod_description),
          group_name = COALESCE(?, group_name),
          allowed_users = ?,
          icon_url = COALESCE(?, icon_url),
          is_optional = CASE WHEN ? IS NOT NULL THEN ? ELSE is_optional END
      WHERE id = ?
    `, [
      mod_name,
      mod_description,
      group_name,
      normUsers,
      icon_url,
      is_optional !== undefined ? (is_optional ? 1 : 0) : null,
      is_optional !== undefined ? (is_optional ? 1 : 0) : 0,
      id
    ]);

    const updated = await db.get("SELECT * FROM modpack_files WHERE id = ?", [id]);
    return res.json({ success: true, mod: updated });
  } catch (error) {
    return res.status(500).json({ error: 'Ошибка обновления параметров мода' });
  }
});

// ----------------------------------------------------
// 2.1. КЛИЕНТСКИЕ СЕРВЕРЫ (ДЛЯ SERVERS.DAT)
// ----------------------------------------------------

// GET /api/v1/admin/client-servers
router.get('/client-servers', requireAdmin, async (req: Request, res: Response) => {
  try {
    const serverId = req.query.serverId ? parseInt(req.query.serverId as string, 10) : 1;
    const db = await getDb();
    const list = await db.all("SELECT * FROM client_servers WHERE server_id = ? ORDER BY sort_order ASC, id ASC", [serverId]);
    return res.json({ servers: list || [] });
  } catch (error) {
    return res.status(500).json({ error: 'Ошибка получения клиентских серверов' });
  }
});

// POST /api/v1/admin/client-servers
router.post('/client-servers', requireAdmin, async (req: Request, res: Response) => {
  try {
    const { server_id, name, address, icon_base64, is_active } = req.body;
    if (!name || !address) return res.status(400).json({ error: 'Название и IP:порт обязательны' });
    const targetServerId = server_id ? parseInt(server_id, 10) : 1;
    const db = await getDb();
    const result = await db.run(`
      INSERT INTO client_servers (server_id, name, address, icon_base64, is_active, sort_order)
      VALUES (?, ?, ?, ?, ?, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM client_servers WHERE server_id = ?))
    `, [targetServerId, name.trim(), address.trim(), icon_base64 || null, is_active !== undefined ? (is_active ? 1 : 0) : 1, targetServerId]);

    return res.json({ success: true, id: result.lastID });
  } catch (error) {
    return res.status(500).json({ error: 'Ошибка добавления клиентского сервера' });
  }
});

// PUT /api/v1/admin/client-servers/:id
router.put('/client-servers/:id', requireAdmin, async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { name, address, icon_base64, is_active, sort_order } = req.body;
    const db = await getDb();
    await db.run(`
      UPDATE client_servers 
      SET name = COALESCE(?, name),
          address = COALESCE(?, address),
          icon_base64 = COALESCE(?, icon_base64),
          is_active = CASE WHEN ? IS NOT NULL THEN ? ELSE is_active END,
          sort_order = COALESCE(?, sort_order)
      WHERE id = ?
    `, [
      name,
      address,
      icon_base64,
      is_active !== undefined ? (is_active ? 1 : 0) : null,
      is_active !== undefined ? (is_active ? 1 : 0) : 1,
      sort_order,
      id
    ]);

    return res.json({ success: true });
  } catch (error) {
    return res.status(500).json({ error: 'Ошибка обновления клиентского сервера' });
  }
});

// DELETE /api/v1/admin/client-servers/:id
router.delete('/client-servers/:id', requireAdmin, async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10);
    const db = await getDb();
    await db.run("DELETE FROM client_servers WHERE id = ?", [id]);
    return res.json({ success: true });
  } catch (error) {
    return res.status(500).json({ error: 'Ошибка удаления клиентского сервера' });
  }
});

// ----------------------------------------------------
// 2.2. УПРАВЛЕНИЕ РЕСУРСПАКАМИ (RESOURCE PACKS)
// ----------------------------------------------------

// GET /api/v1/admin/resourcepacks
router.get('/resourcepacks', requireAdmin, async (req: Request, res: Response) => {
  try {
    const serverId = req.query.serverId ? parseInt(req.query.serverId as string, 10) : 1;
    const db = await getDb();
    const packs = await db.all("SELECT * FROM resource_packs WHERE server_id = ? ORDER BY name ASC", [serverId]);
    return res.json({ resourcePacks: packs || [], serverId });
  } catch (error) {
    return res.status(500).json({ error: 'Ошибка получения списка ресурспаков' });
  }
});

// POST /api/v1/admin/resourcepacks/upload - Загрузка локального .zip ресурспака
router.post('/resourcepacks/upload', requireAdmin, async (req: Request, res: Response) => {
  try {
    const { serverId, filename, base64Data, name, description, isOptional, isRequired, groupName, allowedUsers, iconUrl } = req.body;
    if (!filename || !base64Data) return res.status(400).json({ error: 'Имя файла и base64Data обязательны' });

    const targetServerId = serverId ? parseInt(serverId, 10) : 1;
    const cleanFilename = path.basename(filename);
    const rpStorageDir = path.resolve(__dirname, '../../public/files/resourcepacks');
    if (!fs.existsSync(rpStorageDir)) {
      fs.mkdirSync(rpStorageDir, { recursive: true });
    }

    const buffer = Buffer.from(base64Data, 'base64');
    const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
    const targetFilePath = path.join(rpStorageDir, cleanFilename);
    fs.writeFileSync(targetFilePath, buffer);

    const relativePath = `resourcepacks/${cleanFilename}`;
    const packName = name || cleanFilename.replace(/\.zip$/i, '');
    const packDesc = description || 'Ресурспак загружен администратором';
    const downloadUrl = `http://localhost:3000/files/resourcepacks/${cleanFilename}`;

    let normUsers = 'ALL';
    if (Array.isArray(allowedUsers)) {
      normUsers = JSON.stringify(allowedUsers.map((u: string) => u.trim()).filter(Boolean));
    } else if (typeof allowedUsers === 'string') {
      normUsers = allowedUsers.trim();
    }

    const db = await getDb();
    await db.run("DELETE FROM resource_packs WHERE server_id = ? AND filepath = ?", [targetServerId, relativePath]);
    const result = await db.run(`
      INSERT INTO resource_packs (server_id, name, filename, filepath, sha256, size_bytes, description, icon_url, is_optional, is_required, group_name, allowed_users, download_url)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      targetServerId,
      packName,
      cleanFilename,
      relativePath,
      sha256,
      buffer.length,
      packDesc,
      iconUrl || null,
      isOptional ? 1 : 0,
      isRequired !== undefined ? (isRequired ? 1 : 0) : (isOptional ? 0 : 1),
      groupName || 'Текстуры',
      normUsers,
      downloadUrl
    ]);

    const adminUser = (req as any).user?.username || 'Admin';
    await logAudit(adminUser, 'ADMIN', 'RESOURCEPACK_UPLOAD', packName, `Загружен ресурспак ${cleanFilename} (${buffer.length} B)`, req.ip || '');

    return res.json({ success: true, id: result.lastID, name: packName, filename: cleanFilename, sha256, sizeBytes: buffer.length });
  } catch (error) {
    return res.status(500).json({ error: 'Ошибка сохранения ресурспака' });
  }
});

// POST /api/v1/admin/resourcepacks/add-modrinth - Установка ресурспака из Modrinth
router.post('/resourcepacks/add-modrinth', requireAdmin, async (req: Request, res: Response) => {
  try {
    const { serverId, projectId, versionId, isOptional, groupName, allowedUsers } = req.body;
    if (!projectId || !versionId) return res.status(400).json({ error: 'projectId и versionId обязательны' });
    const targetServerId = serverId ? parseInt(serverId, 10) : 1;

    const vRes = await fetch(`https://api.modrinth.com/v2/version/${versionId}`);
    if (!vRes.ok) return res.status(404).json({ error: 'Версия ресурспака не найдена на Modrinth' });
    const vData = await vRes.json();

    const pRes = await fetch(`https://api.modrinth.com/v2/project/${projectId}`);
    const pData = pRes.ok ? await pRes.json() : {};

    const primaryFile = vData.files.find((f: any) => f.primary) || vData.files[0];
    if (!primaryFile) return res.status(400).json({ error: 'У версии нет файлов для скачивания' });

    const packName = pData.title || vData.name || primaryFile.filename;
    const packDesc = pData.description || 'Установлено через Modrinth API';
    const cleanFilename = primaryFile.filename;
    const filepath = `resourcepacks/${cleanFilename}`;
    const iconUrl = pData.icon_url || null;

    let normUsers = 'ALL';
    if (Array.isArray(allowedUsers)) {
      normUsers = JSON.stringify(allowedUsers.map((u: string) => u.trim()).filter(Boolean));
    } else if (typeof allowedUsers === 'string') {
      normUsers = allowedUsers.trim();
    }

    const db = await getDb();
    await db.run("DELETE FROM resource_packs WHERE server_id = ? AND filepath = ?", [targetServerId, filepath]);
    const result = await db.run(`
      INSERT INTO resource_packs (server_id, name, filename, filepath, sha256, size_bytes, description, icon_url, is_optional, is_required, group_name, allowed_users, download_url)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      targetServerId,
      packName,
      cleanFilename,
      filepath,
      primaryFile.hashes?.sha256 || primaryFile.hashes?.sha1 || 'MODRINTH_HASH',
      primaryFile.size,
      packDesc,
      iconUrl,
      isOptional ? 1 : 0,
      isOptional ? 0 : 1,
      groupName || 'Текстуры',
      normUsers,
      primaryFile.url
    ]);

    const adminUser = (req as any).user?.username || 'Admin';
    await logAudit(adminUser, 'ADMIN', 'RESOURCEPACK_MODRINTH', packName, `Добавлен ресурспак ${packName} из Modrinth`, req.ip || '');

    return res.json({ success: true, id: result.lastID, name: packName, filepath, downloadUrl: primaryFile.url });
  } catch (error) {
    return res.status(500).json({ error: 'Ошибка добавления ресурспака из Modrinth' });
  }
});

// PATCH /api/v1/admin/resourcepacks/:id/details
router.patch('/resourcepacks/:id/details', requireAdmin, async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { name, description, group_name, allowed_users, icon_url, is_optional, is_required } = req.body;
    const db = await getDb();

    let normUsers = 'ALL';
    if (Array.isArray(allowed_users)) {
      normUsers = JSON.stringify(allowed_users.map((u: string) => u.trim()).filter(Boolean));
    } else if (typeof allowed_users === 'string') {
      normUsers = allowed_users.trim();
    }

    await db.run(`
      UPDATE resource_packs
      SET name = COALESCE(?, name),
          description = COALESCE(?, description),
          group_name = COALESCE(?, group_name),
          allowed_users = ?,
          icon_url = COALESCE(?, icon_url),
          is_optional = CASE WHEN ? IS NOT NULL THEN ? ELSE is_optional END,
          is_required = CASE WHEN ? IS NOT NULL THEN ? ELSE is_required END
      WHERE id = ?
    `, [
      name,
      description,
      group_name,
      normUsers,
      icon_url,
      is_optional !== undefined ? (is_optional ? 1 : 0) : null,
      is_optional !== undefined ? (is_optional ? 1 : 0) : 0,
      is_required !== undefined ? (is_required ? 1 : 0) : null,
      is_required !== undefined ? (is_required ? 1 : 0) : 1,
      id
    ]);

    return res.json({ success: true });
  } catch (error) {
    return res.status(500).json({ error: 'Ошибка обновления ресурспака' });
  }
});

// DELETE /api/v1/admin/resourcepacks/:id
router.delete('/resourcepacks/:id', requireAdmin, async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10);
    const db = await getDb();
    const pack = await db.get("SELECT * FROM resource_packs WHERE id = ?", [id]);
    await db.run("DELETE FROM resource_packs WHERE id = ?", [id]);

    const adminUser = (req as any).user?.username || 'Admin';
    await logAudit(adminUser, 'ADMIN', 'RESOURCEPACK_DELETE', pack?.name || `ID:${id}`, `Удален ресурспак ${pack?.filename}`, req.ip || '');

    return res.json({ success: true });
  } catch (error) {
    return res.status(500).json({ error: 'Ошибка удаления ресурспака' });
  }
});

// ----------------------------------------------------
// 3. БЕЗОПАСНОСТЬ: БАНЫ ПО НИКУ, HWID, IP И ПУЛУ IP
// ----------------------------------------------------

// GET /api/v1/admin/bans - Список всех блокировок
router.get('/bans', requireAdmin, async (req: Request, res: Response) => {
  try {
    const db = await getDb();
    const bans = await db.all("SELECT * FROM bans ORDER BY created_at DESC");
    return res.json({ bans: bans || [] });
  } catch (error) {
    return res.status(500).json({ error: 'Ошибка получения бан-листа' });
  }
});

// POST /api/v1/admin/bans - Добавление новой блокировки
router.post('/bans', requireAdmin, async (req: Request, res: Response) => {
  try {
    const { ban_type, target_value, reason, expires_in_hours } = req.body;
    if (!ban_type || !target_value) {
      return res.status(400).json({ error: 'Тип блокировки и значение обязательны' });
    }

    const validTypes = ['NICK', 'HWID', 'IP', 'IP_RANGE'];
    if (!validTypes.includes(ban_type)) {
      return res.status(400).json({ error: 'Недопустимый тип бана. Доступны: NICK, HWID, IP, IP_RANGE' });
    }

    let expiresAt: string | null = null;
    if (expires_in_hours && parseInt(expires_in_hours, 10) > 0) {
      const d = new Date(Date.now() + parseInt(expires_in_hours, 10) * 3600 * 1000);
      expiresAt = d.toISOString();
    }

    const db = await getDb();
    const adminUser = (req as any).user?.username || 'Admin';

    await db.run(`
      INSERT INTO bans (ban_type, target_value, reason, banned_by, expires_at)
      VALUES (?, ?, ?, ?, ?)
    `, [
      ban_type,
      target_value.trim(),
      reason || 'Нарушение правил проекта',
      adminUser,
      expiresAt
    ]);

    await logAudit(adminUser, 'ADMIN', 'BAN_ADD', target_value, `Заблокирован [${ban_type}]: ${target_value}. Причина: ${reason || 'Без причины'}`, req.ip || '');

    return res.json({ success: true, message: `Блокировка [${ban_type}] успешно создана` });
  } catch (error) {
    return res.status(500).json({ error: 'Ошибка создания блокировки' });
  }
});

// DELETE /api/v1/admin/bans/:id - Снятие блокировки
router.delete('/bans/:id', requireAdmin, async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10);
    const db = await getDb();
    const ban = await db.get("SELECT * FROM bans WHERE id = ?", [id]);
    await db.run("DELETE FROM bans WHERE id = ?", [id]);

    const adminUser = (req as any).user?.username || 'Admin';
    await logAudit(adminUser, 'ADMIN', 'BAN_REMOVE', ban?.target_value || `ID:${id}`, `Разблокирован [${ban?.ban_type}]: ${ban?.target_value}`, req.ip || '');

    return res.json({ success: true });
  } catch (error) {
    return res.status(500).json({ error: 'Ошибка снятия блокировки' });
  }
});

// ----------------------------------------------------
// 4. УПРАВЛЕНИЕ РЕЛИЗАМИ И ПАТЧАМИ ЛАУНЧЕРА
// ----------------------------------------------------

// GET /api/v1/admin/launcher/releases - Список релизов
router.get('/launcher/releases', requireAdmin, async (req: Request, res: Response) => {
  try {
    const db = await getDb();
    const releases = await db.all("SELECT * FROM launcher_releases ORDER BY created_at DESC");
    return res.json({ releases: releases || [] });
  } catch (error) {
    return res.status(500).json({ error: 'Ошибка получения релизов лаунчера' });
  }
});

// POST /api/v1/admin/launcher/upload-release - Публикация нового релиза/патча
router.post('/launcher/upload-release', requireAdmin, async (req: Request, res: Response) => {
  try {
    const { version, release_notes, mac_download_url, win_download_url, linux_download_url, is_mandatory } = req.body;
    if (!version) return res.status(400).json({ error: 'Номер версии обязателен (например, 3.1.0)' });

    const db = await getDb();
    await db.run(`
      INSERT OR REPLACE INTO launcher_releases (version, release_notes, mac_download_url, win_download_url, linux_download_url, is_mandatory)
      VALUES (?, ?, ?, ?, ?, ?)
    `, [
      version,
      release_notes || '',
      mac_download_url || '',
      win_download_url || '',
      linux_download_url || '',
      is_mandatory ? 1 : 0
    ]);

    // Обновляем текущую актуальную версию в project_config
    await db.run("INSERT OR REPLACE INTO project_config (key, value) VALUES ('launcher_version', ?)", [version]);

    const adminUser = (req as any).user?.username || 'Admin';
    await logAudit(adminUser, 'ADMIN', 'RELEASE_PUBLISH', version, `Опубликован патч/релиз лаунчера v${version}`, req.ip || '');

    return res.json({ success: true, version });
  } catch (error) {
    return res.status(500).json({ error: 'Ошибка публикации релиза' });
  }
});

// ----------------------------------------------------
// 5. АНАЛИТИКА И ЖУРНАЛ АУДИТА
// ----------------------------------------------------

// GET /api/v1/admin/analytics - Сводная аналитика
router.get('/analytics', requireAdmin, async (req: Request, res: Response) => {
  try {
    const db = await getDb();
    const successJoins = await db.get("SELECT COUNT(*) as cnt FROM connection_stats WHERE event_type = 'LOGIN_SUCCESS'") || { cnt: 0 };
    const failedAuths = await db.get("SELECT COUNT(*) as cnt FROM connection_stats WHERE event_type = 'LOGIN_FAILED'") || { cnt: 0 };
    const totalBans = await db.get("SELECT COUNT(*) as cnt FROM bans") || { cnt: 0 };
    const totalUsers = await db.get("SELECT COUNT(*) as cnt FROM users") || { cnt: 0 };
    const recentEvents = await db.all("SELECT * FROM connection_stats ORDER BY created_at DESC LIMIT 20");

    return res.json({
      successJoins: successJoins.cnt,
      failedAuths: failedAuths.cnt,
      totalBans: totalBans.cnt,
      totalUsers: totalUsers.cnt,
      recentEvents: recentEvents || []
    });
  } catch (error) {
    return res.status(500).json({ error: 'Ошибка получения аналитики' });
  }
});

// GET /api/v1/admin/audit-logs - Журнал действий администраторов и модераторов
router.get('/audit-logs', requireAdmin, async (req: Request, res: Response) => {
  try {
    const db = await getDb();
    const logs = await db.all("SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 50");
    return res.json({ logs: logs || [] });
  } catch (error) {
    return res.status(500).json({ error: 'Ошибка получения логов аудита' });
  }
});

// ----------------------------------------------------
// 6. ПОЛУЧЕНИЕ ВЕРСИЙ MINECRAFT И NEOFORGE
// ----------------------------------------------------

// GET /api/v1/admin/neoforge-versions
router.get('/neoforge-versions', requireAdmin, async (req: Request, res: Response) => {
  try {
    const response = await fetch('https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml');
    const xmlText = await response.text();
    const versionsMatch = xmlText.match(/<version>(21\.1\.[0-9]+)<\/version>/g);
    let versions: string[] = [];

    if (versionsMatch) {
      versions = versionsMatch
        .map(v => v.replace(/<\/?version>/g, ''))
        .reverse()
        .slice(0, 30);
    }

    if (versions.length === 0) {
      versions = ['21.1.248', '21.1.238', '21.1.234', '21.1.230', '21.1.88'];
    }

    return res.json({ versions });
  } catch (error) {
    return res.json({ versions: ['21.1.248', '21.1.238', '21.1.234', '21.1.230', '21.1.88'] });
  }
});

// GET /api/v1/admin/modrinth/search
router.get('/modrinth/search', requireAdmin, async (req: Request, res: Response) => {
  try {
    const query = req.query.q as string || '';
    const projectType = (req.query.projectType as string || 'mod').toLowerCase();
    
    let facets = '[["project_type:mod"],["categories:neoforge"],["versions:1.21.1"]]';
    if (projectType === 'resourcepack') {
      facets = '[["project_type:resourcepack"],["versions:1.21.1"]]';
    }

    const response = await fetch(`https://api.modrinth.com/v2/search?query=${encodeURIComponent(query)}&limit=20&facets=${encodeURIComponent(facets)}`);
    const data = await response.json();
    return res.json(data);
  } catch (error) {
    return res.status(500).json({ error: 'Ошибка поиска в Modrinth API' });
  }
});

// GET /api/v1/admin/modrinth/versions
router.get('/modrinth/versions', requireAdmin, async (req: Request, res: Response) => {
  try {
    const projectId = req.query.projectId as string;
    const projectType = (req.query.projectType as string || 'mod').toLowerCase();
    if (!projectId) return res.status(400).json({ error: 'projectId обязателен' });

    let url = `https://api.modrinth.com/v2/project/${projectId}/version?loaders=["neoforge"]&game_versions=["1.21.1"]`;
    if (projectType === 'resourcepack') {
      url = `https://api.modrinth.com/v2/project/${projectId}/version?game_versions=["1.21.1"]`;
    }

    const response = await fetch(url);
    const versions = response.ok ? await response.json() : [];
    return res.json(versions);
  } catch (error) {
    return res.status(500).json({ error: 'Ошибка получения версий с Modrinth API' });
  }
});

// ----------------------------------------------------
// 7. УПРАВЛЕНИЕ ЗЕРКАЛАМИ API И БЕСШОВНАЯ МИГРАЦИЯ (FAILOVER)
// ----------------------------------------------------

// GET /api/v1/admin/mirrors - Список всех зеркал API
router.get('/mirrors', requireAdmin, async (req: Request, res: Response) => {
  try {
    const db = await getDb();
    const mirrors = await db.all("SELECT * FROM api_mirrors ORDER BY is_primary DESC, priority DESC, id ASC");
    return res.json({ mirrors: mirrors || [] });
  } catch (error) {
    return res.status(500).json({ error: 'Ошибка получения списка зеркал' });
  }
});

// POST /api/v1/admin/mirrors - Добавление нового зеркала
router.post('/mirrors', requireAdmin, async (req: Request, res: Response) => {
  try {
    const { name, url, region, priority, is_primary } = req.body;
    if (!name || !url) return res.status(400).json({ error: 'Название и URL зеркала обязательны' });

    const db = await getDb();
    if (is_primary) {
      await db.run("UPDATE api_mirrors SET is_primary = 0");
    }

    const cleanUrl = url.trim().replace(/\/+$/, '');
    await db.run(`
      INSERT INTO api_mirrors (name, url, region, priority, is_primary, is_active)
      VALUES (?, ?, ?, ?, ?, 1)
    `, [name, cleanUrl, region || 'Global', priority ? parseInt(priority, 10) : 50, is_primary ? 1 : 0]);

    const adminUser = (req as any).user?.username || 'Admin';
    await logAudit(adminUser, 'ADMIN', 'MIRROR_ADD', name, `Добавлено резервное зеркало API: ${cleanUrl}`, req.ip || '');

    return res.json({ success: true, url: cleanUrl });
  } catch (error) {
    return res.status(500).json({ error: 'Ошибка добавления зеркала' });
  }
});

// POST /api/v1/admin/mirrors/:id/set-primary - Назначение зеркала основным (Миграция проекта на новый сервер)
router.post('/mirrors/:id/set-primary', requireAdmin, async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10);
    const db = await getDb();
    const targetMirror = await db.get("SELECT * FROM api_mirrors WHERE id = ?", [id]);
    if (!targetMirror) return res.status(404).json({ error: 'Зеркало не найдено' });

    await db.run("UPDATE api_mirrors SET is_primary = 0");
    await db.run("UPDATE api_mirrors SET is_primary = 1, is_active = 1 WHERE id = ?", [id]);

    const adminUser = (req as any).user?.username || 'Admin';
    await logAudit(adminUser, 'ADMIN', 'MIRROR_MIGRATE', targetMirror.name, `Установлен новый основной IP/URL проекта: ${targetMirror.url}`, req.ip || '');

    return res.json({ success: true, primaryMirror: targetMirror });
  } catch (error) {
    return res.status(500).json({ error: 'Ошибка назначения основного зеркала' });
  }
});

// DELETE /api/v1/admin/mirrors/:id - Удаление зеркала
router.delete('/mirrors/:id', requireAdmin, async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10);
    const db = await getDb();
    const mirror = await db.get("SELECT * FROM api_mirrors WHERE id = ?", [id]);
    if (mirror?.is_primary) {
      return res.status(400).json({ error: 'Нельзя удалить основное зеркало. Сначала назначьте другое зеркало основным.' });
    }

    await db.run("DELETE FROM api_mirrors WHERE id = ?", [id]);
    return res.json({ success: true });
  } catch (error) {
    return res.status(500).json({ error: 'Ошибка удаления зеркала' });
  }
});

// ----------------------------------------------------
// 10. УПРАВЛЕНИЕ DISCORD БОТОМ ИЗ АДМИН-ПАНЕЛИ
// ----------------------------------------------------

// GET /api/v1/admin/discord/status - Получение статуса подключения бота и токена
router.get('/discord/status', requireAdmin, async (req: Request, res: Response) => {
  try {
    const db = await getDb();
    const tokenRow = await db.get("SELECT value FROM system_settings WHERE key = 'discord_bot_token'");
    const guildRow = await db.get("SELECT value FROM system_settings WHERE key = 'discord_guild_id'");
    const proxyRow = await db.get("SELECT value FROM system_settings WHERE key = 'discord_proxy'");
    const rawToken = (tokenRow?.value || process.env.DISCORD_BOT_TOKEN || '').trim();

    const maskedToken = rawToken 
      ? (rawToken.substring(0, 8) + '••••••••••••••••••••••••••••••••' + rawToken.substring(rawToken.length - 6))
      : '';

    const botStatus = getDiscordBotStatus();

    return res.json({
      ...botStatus,
      maskedToken,
      hasConfiguredToken: Boolean(rawToken),
      guildId: guildRow?.value || '',
      proxy: proxyRow?.value || process.env.DISCORD_PROXY || ''
    });
  } catch (error) {
    return res.status(500).json({ error: 'Ошибка получения статуса Discord бота' });
  }
});

// POST /api/v1/admin/discord/config - Сохранение нового токена, прокси и моментальный перезапуск бота
router.post('/discord/config', requireAdmin, async (req: Request, res: Response) => {
  try {
    const { botToken, guildId, proxy } = req.body;
    const db = await getDb();

    let cleanToken = botToken ? botToken.trim() : '';

    // Если токен содержит точки маскировки (••••), сохраняем текущий токен из БД
    if (cleanToken.includes('••••') || !cleanToken) {
      const existingTokenRow = await db.get("SELECT value FROM system_settings WHERE key = 'discord_bot_token'");
      cleanToken = (existingTokenRow?.value || process.env.DISCORD_BOT_TOKEN || '').trim();
    }

    if (!cleanToken) {
      return res.status(400).json({ error: 'Введите корректный токен Discord бота' });
    }

    const cleanProxy = proxy !== undefined ? proxy.trim() : undefined;

    // Сохраняем в таблицу системных настроек SQLite
    await db.run(
      "INSERT INTO system_settings (key, value, updated_at) VALUES ('discord_bot_token', ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
      [cleanToken]
    );

    if (guildId !== undefined) {
      await db.run(
        "INSERT INTO system_settings (key, value, updated_at) VALUES ('discord_guild_id', ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        [String(guildId).trim()]
      );
    }

    if (cleanProxy !== undefined) {
      await db.run(
        "INSERT INTO system_settings (key, value, updated_at) VALUES ('discord_proxy', ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        [cleanProxy]
      );
    }

    // Перезапускаем Discord бота на лету с новым токеном и прокси
    const reloadResult = await reloadDiscordBot(cleanToken, cleanProxy);

    const adminUser = (req as any).user?.username || 'Admin';
    await logAudit(adminUser, 'ADMIN', 'DISCORD_BOT_UPDATE', 'Bot Config', reloadResult.message, req.ip || '');

    if (!reloadResult.success) {
      return res.status(400).json({
        success: false,
        error: reloadResult.error || reloadResult.message,
        botStatus: getDiscordBotStatus()
      });
    }

    return res.json({
      success: true,
      message: reloadResult.message,
      botStatus: getDiscordBotStatus()
    });
  } catch (error) {
    return res.status(500).json({ error: 'Ошибка сохранения настроек Discord: ' + (error as Error).message });
  }
});

// POST /api/v1/admin/discord/test-dm - Тестовая отправка сообщения в ЛС игроку
router.post('/discord/test-dm', requireAdmin, async (req: Request, res: Response) => {
  try {
    const { username } = req.body;
    if (!username || !username.trim()) {
      return res.status(400).json({ error: 'Укажите никнейм игрока для теста' });
    }

    const cleanNick = username.trim();
    const testRequestId = 'TEST-' + crypto.randomBytes(6).toString('hex');
    const result = await sendDiscordLoginRequest(cleanNick, req.ip || '127.0.0.1', testRequestId);

    if (!result.success) {
      return res.status(400).json({ success: false, error: result.error });
    }

    return res.json({ success: true, message: `Тестовое сообщение успешно отправлено игроку ${cleanNick} в Discord!` });
  } catch (error) {
    return res.status(500).json({ error: 'Ошибка отправки теста: ' + (error as Error).message });
  }
});

// GET /api/v1/admin/discord/pending-requests - Получение активных запросов на вход игроков
router.get('/discord/pending-requests', requireAdmin, async (req: Request, res: Response) => {
  try {
    const db = await getDb();
    const requests = await db.all(`
      SELECT * FROM discord_auth_requests 
      WHERE status = 'PENDING' AND expires_at > datetime('now')
      ORDER BY created_at DESC LIMIT 20
    `);
    return res.json(requests);
  } catch (error) {
    return res.status(500).json({ error: 'Ошибка получения запросов' });
  }
});

// POST /api/v1/admin/discord/approve-request - Ручное мгновенное одобрение входа игрока администратором
router.post('/discord/approve-request', requireAdmin, async (req: Request, res: Response) => {
  try {
    const { requestId } = req.body;
    const db = await getDb();
    const authReq = await db.get("SELECT * FROM discord_auth_requests WHERE id = ?", [requestId]);
    if (!authReq) return res.status(404).json({ error: 'Запрос на вход не найден или истек' });

    await db.run("UPDATE discord_auth_requests SET status = 'APPROVED' WHERE id = ?", [requestId]);

    const adminUser = (req as any).user?.username || 'Admin';
    await logAudit(adminUser, 'ADMIN', 'AUTH_FORCE_APPROVE', authReq.username, `Ручное одобрение входа в лаунчер`, req.ip || '');

    return res.json({ success: true, message: `Вход для игрока ${authReq.username} успешно одобрен!` });
  } catch (error) {
    return res.status(500).json({ error: 'Ошибка одобрения запроса: ' + (error as Error).message });
  }
});

// POST /api/v1/admin/discord/simulate-auth - Эмуляция подтверждения авторизации
router.post('/discord/simulate-auth', requireAdmin, async (req: Request, res: Response) => {
  try {
    const { username } = req.body;
    if (!username) return res.status(400).json({ error: 'Укажите никнейм' });
    const cleanNick = username.trim();
    const db = await getDb();

    // Находим последний ожидающий запрос
    const authReq = await db.get(
      "SELECT id FROM discord_auth_requests WHERE LOWER(username) = LOWER(?) AND status = 'PENDING' ORDER BY created_at DESC LIMIT 1",
      [cleanNick]
    );

    if (authReq) {
      await db.run("UPDATE discord_auth_requests SET status = 'APPROVED' WHERE id = ?", [authReq.id]);
      return res.json({ success: true, message: `Вход для ${cleanNick} (запрос: ${authReq.id}) мгновенно подтвержден!` });
    }

    // Если нет запроса - создаем одобренный
    const fakeRequestId = 'SIM-' + crypto.randomBytes(8).toString('hex');
    const expiresAt = new Date(Date.now() + 120 * 1000).toISOString();
    await db.run(
      "INSERT INTO discord_auth_requests (id, username, ip_address, status, expires_at) VALUES (?, ?, '127.0.0.1', 'APPROVED', ?)",
      [fakeRequestId, cleanNick, expiresAt]
    );

    return res.json({ success: true, requestId: fakeRequestId, message: `Создана сессия для игрока ${cleanNick}` });
  } catch (error) {
    return res.status(500).json({ error: 'Ошибка эмуляции: ' + (error as Error).message });
  }
});

// ----------------------------------------------------
// 10. МОБИЛЬНЫЕ БАЙПАСЫ (Вход с телефонов / PojavLauncher)
// ----------------------------------------------------

// GET /api/v1/admin/launcher/bypasses - Список активных байпасов
router.get('/launcher/bypasses', requireAdmin, async (req: Request, res: Response) => {
  try {
    const db = await getDb();
    const bypasses = await db.all(`
      SELECT * FROM launcher_bypasses 
      WHERE expires_at IS NULL OR expires_at > datetime('now')
      ORDER BY created_at DESC
    `);
    return res.json({ bypasses: bypasses || [] });
  } catch (error) {
    return res.status(500).json({ error: 'Ошибка получения байпасов' });
  }
});

// POST /api/v1/admin/launcher/bypasses - Выдать байпас игроку
router.post('/launcher/bypasses', requireAdmin, async (req: Request, res: Response) => {
  try {
    const { username, reason, days } = req.body;
    if (!username) return res.status(400).json({ error: 'Никнейм обязателен' });

    const cleanNick = username.trim();
    const adminUser = (req as any).user?.username || 'Admin';
    const expiresAt = days && parseInt(days) > 0 
      ? new Date(Date.now() + parseInt(days) * 86400 * 1000).toISOString()
      : null; // null = бессрочно

    const db = await getDb();
    await db.run(`
      INSERT OR REPLACE INTO launcher_bypasses (username, reason, created_by, expires_at)
      VALUES (?, ?, ?, ?)
    `, [cleanNick, reason || 'Мобильный клиент (телефон)', adminUser, expiresAt]);

    await logAudit(adminUser, 'ADMIN', 'BYPASS_GRANT', cleanNick, `Выдан мобильный байпас на вход (${reason || 'Телефон'})`, req.ip || '');

    return res.json({ success: true, message: `Мобильный байпас для ${cleanNick} успешно выдан!` });
  } catch (error) {
    return res.status(500).json({ error: 'Ошибка выдачи байпаса: ' + (error as Error).message });
  }
});

// DELETE /api/v1/admin/launcher/bypasses/:id - Удалить байпас
router.delete('/launcher/bypasses/:id', requireAdmin, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const db = await getDb();
    const bypass = await db.get("SELECT * FROM launcher_bypasses WHERE id = ?", [id]);
    await db.run("DELETE FROM launcher_bypasses WHERE id = ?", [id]);

    const adminUser = (req as any).user?.username || 'Admin';
    if (bypass) {
      await logAudit(adminUser, 'ADMIN', 'BYPASS_REVOKE', bypass.username, `Отозван мобильный байпас`, req.ip || '');
    }

    return res.json({ success: true });
  } catch (error) {
    return res.status(500).json({ error: 'Ошибка отзыва байпаса' });
  }
});

// ----------------------------------------------------
// 11. ДЕБАГ-ЛОГИ ЛАУНЧЕРОВ (Хранение 3 дня)
// ----------------------------------------------------

// GET /api/v1/admin/debug-logs - Список дебаг-логов
router.get('/debug-logs', requireAdmin, async (req: Request, res: Response) => {
  try {
    const { username, os, limit, offset } = req.query;
    const db = await getDb();

    // Авто-очистка логов старше 3 дней
    await db.run("DELETE FROM launcher_debug_logs WHERE created_at < datetime('now', '-3 days')");

    let query = "SELECT id, username, os, launcher_version, event_type, created_at, length(log_content) as size FROM launcher_debug_logs WHERE 1=1";
    const params: any[] = [];

    if (username) {
      query += " AND LOWER(username) LIKE LOWER(?)";
      params.push(`%${username}%`);
    }
    if (os) {
      query += " AND LOWER(os) LIKE LOWER(?)";
      params.push(`%${os}%`);
    }

    query += " ORDER BY created_at DESC LIMIT ? OFFSET ?";
    params.push(parseInt(limit as string) || 50, parseInt(offset as string) || 0);

    const logs = await db.all(query, params);
    const totalCount = await db.get("SELECT COUNT(*) as cnt FROM launcher_debug_logs");

    return res.json({
      logs: logs || [],
      total: totalCount?.cnt || 0
    });
  } catch (error) {
    return res.status(500).json({ error: 'Ошибка получения дебаг-логов' });
  }
});

// GET /api/v1/admin/debug-logs/:id - Получить конкретный лог целиком
router.get('/debug-logs/:id', requireAdmin, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const db = await getDb();
    const logItem = await db.get("SELECT * FROM launcher_debug_logs WHERE id = ?", [id]);
    if (!logItem) return res.status(404).json({ error: 'Лог не найден' });
    return res.json(logItem);
  } catch (error) {
    return res.status(500).json({ error: 'Ошибка получения лога' });
  }
});

// GET /api/v1/admin/debug-logs/:id/download - Скачать файл .log
router.get('/debug-logs/:id/download', requireAdmin, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const db = await getDb();
    const logItem = await db.get("SELECT * FROM launcher_debug_logs WHERE id = ?", [id]);
    if (!logItem) return res.status(404).send('Лог не найден');

    const filename = `launcher-debug-${logItem.username}-${new Date(logItem.created_at).toISOString().replace(/[:.]/g, '-')}.log`;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.send(logItem.log_content);
  } catch (error) {
    return res.status(500).send('Ошибка скачивания лога');
  }
});

// DELETE /api/v1/admin/debug-logs/:id - Удалить лог
router.delete('/debug-logs/:id', requireAdmin, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const db = await getDb();
    await db.run("DELETE FROM launcher_debug_logs WHERE id = ?", [id]);
    return res.json({ success: true });
  } catch (error) {
    return res.status(500).json({ error: 'Ошибка удаления лога' });
  }
});

// ----------------------------------------------------
// 12. КРАШ-РЕПОРТЫ MINECRAFT (/crash-reports, Хранение 3 дня)
// ----------------------------------------------------

// GET /api/v1/admin/crash-reports - Список краш-репортов
router.get('/crash-reports', requireAdmin, async (req: Request, res: Response) => {
  try {
    const { username, limit, offset } = req.query;
    const db = await getDb();

    // Авто-очистка краш-репортов старше 3 дней
    await db.run("DELETE FROM launcher_crash_reports WHERE created_at < datetime('now', '-3 days')");

    let query = "SELECT id, username, os, server_id, crash_filename, created_at, length(report_content) as size FROM launcher_crash_reports WHERE 1=1";
    const params: any[] = [];

    if (username) {
      query += " AND LOWER(username) LIKE LOWER(?)";
      params.push(`%${username}%`);
    }

    query += " ORDER BY created_at DESC LIMIT ? OFFSET ?";
    params.push(parseInt(limit as string) || 50, parseInt(offset as string) || 0);

    const reports = await db.all(query, params);
    const totalCount = await db.get("SELECT COUNT(*) as cnt FROM launcher_crash_reports");

    return res.json({
      reports: reports || [],
      total: totalCount?.cnt || 0
    });
  } catch (error) {
    return res.status(500).json({ error: 'Ошибка получения краш-репортов' });
  }
});

// GET /api/v1/admin/crash-reports/:id - Получить текст краша
router.get('/crash-reports/:id', requireAdmin, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const db = await getDb();
    const crashItem = await db.get("SELECT * FROM launcher_crash_reports WHERE id = ?", [id]);
    if (!crashItem) return res.status(404).json({ error: 'Краш-репорт не найден' });
    return res.json(crashItem);
  } catch (error) {
    return res.status(500).json({ error: 'Ошибка получения краш-репорта' });
  }
});

// GET /api/v1/admin/crash-reports/:id/download - Скачать .txt краш-репорта
router.get('/crash-reports/:id/download', requireAdmin, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const db = await getDb();
    const crashItem = await db.get("SELECT * FROM launcher_crash_reports WHERE id = ?", [id]);
    if (!crashItem) return res.status(404).send('Краш-репорт не найден');

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${crashItem.crash_filename || 'crash-report.txt'}"`);
    return res.send(crashItem.report_content);
  } catch (error) {
    return res.status(500).send('Ошибка скачивания краш-репорта');
  }
});

// DELETE /api/v1/admin/crash-reports/:id - Удалить краш-репорт
router.delete('/crash-reports/:id', requireAdmin, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const db = await getDb();
    await db.run("DELETE FROM launcher_crash_reports WHERE id = ?", [id]);
    return res.json({ success: true });
  } catch (error) {
    return res.status(500).json({ error: 'Ошибка удаления краш-репорта' });
  }
});

export default router;
