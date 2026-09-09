"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const db_1 = require("../db");
const router = (0, express_1.Router)();
// GET /api/v1/manifest/servers - Получение списка активных серверов с IP и версиями для лаунчера
router.get('/servers', async (req, res) => {
    try {
        const db = await (0, db_1.getDb)();
        const servers = await db.all("SELECT * FROM servers WHERE is_active = 1 ORDER BY is_default DESC, id ASC");
        const mirrors = await db.all("SELECT id, name, url, region, is_primary, priority FROM api_mirrors WHERE is_active = 1 ORDER BY is_primary DESC, priority DESC");
        return res.json({ servers: servers || [], mirrors: mirrors || [] });
    }
    catch (error) {
        return res.status(500).json({ error: 'Ошибка сервера при получении списка серверов' });
    }
});
// GET /api/v1/manifest/mirrors - Получение списка активных зеркал API и резервных IP
router.get('/mirrors', async (req, res) => {
    try {
        const db = await (0, db_1.getDb)();
        const mirrors = await db.all("SELECT id, name, url, region, is_primary, priority FROM api_mirrors WHERE is_active = 1 ORDER BY is_primary DESC, priority DESC");
        return res.json({ mirrors: mirrors || [] });
    }
    catch (error) {
        return res.status(500).json({ error: 'Ошибка получения списка зеркал' });
    }
});
// GET /api/v1/manifest - Prism Component Manifest Specification для выбранного сервера
router.get('/', async (req, res) => {
    try {
        const db = await (0, db_1.getDb)();
        const serverIdParam = req.query.serverId ? parseInt(req.query.serverId, 10) : null;
        const username = (req.query.username || '').trim();
        let targetServer = null;
        if (serverIdParam) {
            targetServer = await db.get("SELECT * FROM servers WHERE id = ? AND is_active = 1", [serverIdParam]);
        }
        if (!targetServer) {
            targetServer = await db.get("SELECT * FROM servers WHERE is_default = 1 AND is_active = 1") ||
                await db.get("SELECT * FROM servers WHERE is_active = 1 LIMIT 1");
        }
        const serverId = targetServer ? targetServer.id : 1;
        // Функция проверки персонального доступа к моду/ресурспаку
        const isUserAllowed = (allowedUsersStr, user) => {
            if (!allowedUsersStr || allowedUsersStr === 'ALL' || allowedUsersStr === '*' || allowedUsersStr.trim() === '') {
                return true;
            }
            if (!user)
                return false;
            try {
                const list = JSON.parse(allowedUsersStr);
                if (Array.isArray(list)) {
                    if (list.length === 0 || list.includes('ALL'))
                        return true;
                    return list.some((u) => String(u).trim().toLowerCase() === user.toLowerCase());
                }
            }
            catch (_) {
                const list = allowedUsersStr.split(',').map(s => s.trim().toLowerCase());
                if (list.includes('all'))
                    return true;
                return list.includes(user.toLowerCase());
            }
            return false;
        };
        // Обязательные и опциональные моды
        const files = await db.all("SELECT * FROM modpack_files WHERE server_id = ? AND is_optional = 0 ORDER BY mod_name ASC", [serverId]);
        const rawOptionalFiles = await db.all("SELECT * FROM modpack_files WHERE server_id = ? AND is_optional = 1 ORDER BY group_name ASC, mod_name ASC", [serverId]);
        // Фильтруем опциональные моды по правам доступа игрока (например, Freecam только ютуберу)
        const filteredOptionalFiles = (rawOptionalFiles || []).filter(f => isUserAllowed(f.allowed_users, username));
        // Обязательные и опциональные ресурспаки
        const rawReqResourcePacks = await db.all("SELECT * FROM resource_packs WHERE server_id = ? AND (is_optional = 0 OR is_required = 1) ORDER BY name ASC", [serverId]);
        const rawOptResourcePacks = await db.all("SELECT * FROM resource_packs WHERE server_id = ? AND is_optional = 1 ORDER BY group_name ASC, name ASC", [serverId]);
        const filteredOptResourcePacks = (rawOptResourcePacks || []).filter(rp => isUserAllowed(rp.allowed_users, username));
        // Клиентские серверы для генерации servers.dat
        const clientServers = await db.all("SELECT name, address, icon_base64 FROM client_servers WHERE server_id = ? AND is_active = 1 ORDER BY sort_order ASC, id ASC", [serverId]);
        const baseHost = `${req.protocol}://${req.get('host') || '185.221.213.43:3000'}`;
        const normalizeFile = (f) => {
            let downloadUrl = f.download_url || '';
            if (!downloadUrl) {
                downloadUrl = `${baseHost}/files/${f.filepath.replace(/^\/+/, '')}`;
            }
            else if (downloadUrl.includes('localhost:3000') || downloadUrl.includes('127.0.0.1:3000')) {
                downloadUrl = downloadUrl.replace(/https?:\/\/(localhost|127\.0\.0\.1):3000/, baseHost);
            }
            else if (downloadUrl.startsWith('/')) {
                downloadUrl = `${baseHost}${downloadUrl}`;
            }
            return {
                ...f,
                group_name: f.group_name || 'Общие',
                download_url: downloadUrl
            };
        };
        const normalizedFiles = (files || []).map(normalizeFile);
        const normalizedOptionalFiles = filteredOptionalFiles.map(normalizeFile);
        const normalizedReqResourcePacks = (rawReqResourcePacks || []).map(normalizeFile);
        const normalizedOptResourcePacks = filteredOptResourcePacks.map(normalizeFile);
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
            optionalFiles: normalizedOptionalFiles,
            resourcePacks: normalizedReqResourcePacks,
            optionalResourcePacks: normalizedOptResourcePacks,
            clientServers: clientServers && clientServers.length > 0 ? clientServers : [
                { name: targetServer?.name || 'VozduCraft Server', address: `${targetServer?.server_ip || '89.248.236.145'}:${targetServer?.server_port || 27123}` }
            ]
        });
    }
    catch (error) {
        return res.status(500).json({ error: 'Ошибка сервера при получении манифеста' });
    }
});
exports.default = router;
