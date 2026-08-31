import { getDb } from './dist/db.js';

async function run() {
  const db = await getDb();
  await db.run("UPDATE project_config SET value = '1.0.1' WHERE key = 'launcher_version'");
  const conf = await db.get("SELECT value FROM project_config WHERE key = 'launcher_version'");
  console.log('[UPDATER] Новая системная версия лаунчера на бэкенде:', conf);
  process.exit(0);
}

run();
