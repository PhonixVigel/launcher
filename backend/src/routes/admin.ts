import { Router, Request, Response } from 'express';
import { getDb } from '../db';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import net from 'net';

const router = Router();

// Middleware проверки прав администратора
export const requireAdmin = async (req: Request, res: Response, next: Function) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Требуется токен авторизации администратора' });
    }

    const token = authHeader.split(' ')[1];
    
    // Специальный локальный токен администратора для удобства разработки
    if (token === 'VOZDUHAN-ADMIN-TOKEN') {
      (req as any).user = { username: 'VozduHAN', role: 'ADMIN' };
      return next();
    }

    const db = await getDb();
    const session = await db.get(`
      SELECT s.*, u.role, u.username
      FROM sessions s
      JOIN users u ON s.username = u.username
      WHERE s.access_token = ? AND (s.expires_at > CURRENT_TIMESTAMP OR s.is_admin_bypass = 1)
    `, [token]);

    if (!session || (session.role !== 'ADMIN' && session.role !== 'MODERATOR')) {
      return res.status(403).json({ error: 'Доступ запрещен. Требуются права администратора или модератора.' });
    }

    (req as any).user = session;
    next();
  } catch (error) {
    return res.status(500).json({ error: 'Ошибка проверки авторизации' });
  }
};

// Функция записи в аудит-лог
async function logAudit(actor: string, role: string, action: string, target: string, details: string, ip: string) {
  try {
    const db = await getDb();
    await db.run(`
      INSERT INTO audit_logs (actor_username, actor_role, action_type, target, details, ip_address)
      VALUES (?, ?, ?, ?, ?, ?)
    `, [actor, role, action, target, details, ip]);
  } catch (e) {
    console.error('[AUDIT ERROR]', e);
  }
}

// Прямой опрос статуса Minecraft сервера через нативный TCP Socket (Handshake Protocol)
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

    const db = await getDb();

    // Удаляем старую версию мода в этом сервере если была
    await db.run("DELETE FROM modpack_files WHERE server_id = ? AND filepath = ?", [targetServerId, filepath]);

    await db.run(`
      INSERT INTO modpack_files (server_id, filepath, sha256, size_bytes, is_optional, mod_name, mod_description, download_url)
      VALUES (?, ?, ?, ?, 0, ?, ?, ?)
    `, [
      targetServerId,
      filepath,
      primaryFile.hashes?.sha512 || primaryFile.hashes?.sha1 || 'MODRINTH_HASH',
      primaryFile.size,
      modName,
      modDesc,
      primaryFile.url
    ]);

    const adminUser = (req as any).user?.username || 'Admin';
    await logAudit(adminUser, 'ADMIN', 'MOD_ADD', modName, `Добавлен мод ${modName} в сборку сервера ${targetServerId}`, req.ip || '');

    return res.json({ success: true, modName, filepath, downloadUrl: primaryFile.url });
  } catch (error) {
    return res.status(500).json({ error: 'Ошибка добавления мода из Modrinth' });
  }
});

// POST /api/v1/admin/modpack/upload - Загрузка локального файла мода (.jar / .zip)
router.post('/modpack/upload', requireAdmin, async (req: Request, res: Response) => {
  try {
    const { serverId, filename, base64Data, modName, modDescription, isOptional } = req.body;
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

    const db = await getDb();
    await db.run("DELETE FROM modpack_files WHERE server_id = ? AND filepath = ?", [targetServerId, relativePath]);
    await db.run(`
      INSERT INTO modpack_files (server_id, filepath, sha256, size_bytes, is_optional, mod_name, mod_description, download_url)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      targetServerId,
      relativePath,
      sha256,
      buffer.length,
      isOptional ? 1 : 0,
      name,
      desc,
      downloadUrl
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
    const response = await fetch(`https://api.modrinth.com/v2/search?query=${encodeURIComponent(query)}&limit=15&facets=[["categories:neoforge"],["versions:1.21.1"]]`);
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
    if (!projectId) return res.status(400).json({ error: 'projectId обязателен' });

    const response = await fetch(`https://api.modrinth.com/v2/project/${projectId}/version?loaders=["neoforge"]&game_versions=["1.21.1"]`);
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

export default router;
