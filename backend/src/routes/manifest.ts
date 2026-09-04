import { Router, Request, Response } from 'express';
import { getDb } from '../db';

const router = Router();

// GET /api/v1/manifest/servers - Получение списка активных серверов с IP и версиями для лаунчера
router.get('/servers', async (req: Request, res: Response) => {
  try {
    const db = await getDb();
    const servers = await db.all("SELECT * FROM servers WHERE is_active = 1 ORDER BY is_default DESC, id ASC");
    const mirrors = await db.all("SELECT id, name, url, region, is_primary, priority FROM api_mirrors WHERE is_active = 1 ORDER BY is_primary DESC, priority DESC");
    return res.json({ servers: servers || [], mirrors: mirrors || [] });
  } catch (error) {
    return res.status(500).json({ error: 'Ошибка сервера при получении списка серверов' });
  }
});

// GET /api/v1/manifest/mirrors - Получение списка активных зеркал API и резервных IP
router.get('/mirrors', async (req: Request, res: Response) => {
  try {
    const db = await getDb();
    const mirrors = await db.all("SELECT id, name, url, region, is_primary, priority FROM api_mirrors WHERE is_active = 1 ORDER BY is_primary DESC, priority DESC");
    return res.json({ mirrors: mirrors || [] });
  } catch (error) {
    return res.status(500).json({ error: 'Ошибка получения списка зеркал' });
  }
});

// GET /api/v1/manifest - Prism Component Manifest Specification для выбранного сервера
router.get('/', async (req: Request, res: Response) => {
  try {
    const db = await getDb();
    const serverIdParam = req.query.serverId ? parseInt(req.query.serverId as string, 10) : null;

    let targetServer = null;
    if (serverIdParam) {
      targetServer = await db.get("SELECT * FROM servers WHERE id = ? AND is_active = 1", [serverIdParam]);
    }
    if (!targetServer) {
      targetServer = await db.get("SELECT * FROM servers WHERE is_default = 1 AND is_active = 1") ||
                     await db.get("SELECT * FROM servers WHERE is_active = 1 LIMIT 1");
    }

    const serverId = targetServer ? targetServer.id : 1;

    const files = await db.all("SELECT * FROM modpack_files WHERE server_id = ? AND is_optional = 0 ORDER BY mod_name ASC", [serverId]);
    const optionalFiles = await db.all("SELECT * FROM modpack_files WHERE server_id = ? AND is_optional = 1 ORDER BY mod_name ASC", [serverId]);

    const baseHost = `${req.protocol}://${req.get('host') || '185.221.213.43:3000'}`;

    const normalizeFile = (f: any) => {
      let downloadUrl = f.download_url || '';
      if (!downloadUrl) {
        downloadUrl = `${baseHost}/files/${f.filepath.replace(/^\/+/, '')}`;
      } else if (downloadUrl.includes('localhost:3000') || downloadUrl.includes('127.0.0.1:3000')) {
        downloadUrl = downloadUrl.replace(/https?:\/\/(localhost|127\.0\.0\.1):3000/, baseHost);
      } else if (downloadUrl.startsWith('/')) {
        downloadUrl = `${baseHost}${downloadUrl}`;
      }
      return {
        ...f,
        download_url: downloadUrl
      };
    };

    const normalizedFiles = (files || []).map(normalizeFile);
    const normalizedOptionalFiles = (optionalFiles || []).map(normalizeFile);

    const jvmConfig = await db.get("SELECT value FROM project_config WHERE key = 'jvm_flags'");

    return res.json({
      server: targetServer || {
        id: 1,
        name: 'VozduCraft Season #2',
        server_ip: '89.248.236.145',
        server_port: 27123,
        minecraft_version: '1.21.1',
        neoforge_version: '21.1.248',
        modloader: 'neoforge',
        modloader_version: '21.1.248'
      },
      minecraftVersion: targetServer?.minecraft_version || '1.21.1',
      neoForgeVersion: targetServer?.neoforge_version || '21.1.248',
      modloader: targetServer?.modloader || 'neoforge',
      modloaderVersion: targetServer?.modloader_version || targetServer?.neoforge_version || '21.1.248',
      javaVersion: targetServer?.java_version || 21,
      minRamGb: targetServer?.min_ram_gb || 4,
      recommendedRamGb: targetServer?.recommended_ram_gb || 6,
      jvmFlags: targetServer?.jvm_flags || jvmConfig?.value || '-XX:+UnlockExperimentalVMOptions -XX:+UseG1GC -XX:G1NewSizePercent=20 -XX:G1ReservePercent=20 -XX:MaxGCPauseMillis=50 -XX:G1HeapRegionSize=32M -XX:+DisableExplicitGC -XX:+AlwaysPreTouch -XX:+PerfDisableSharedMem',
      gameArgs: targetServer?.game_args || '',
      autoJoinServer: targetServer?.auto_join_server !== undefined ? targetServer.auto_join_server : 1,
      files: normalizedFiles,
      optionalFiles: normalizedOptionalFiles
    });
  } catch (error) {
    return res.status(500).json({ error: 'Ошибка сервера при получении манифеста' });
  }
});

export default router;
