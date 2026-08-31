import fs from 'fs';
import path from 'path';

async function run() {
  console.log('[START] Скачивание 100% манифеста библиотек 1.21.1 Mojang...');
  const metaUrl = 'https://piston-meta.mojang.com/v1/packages/6d257dcfa9d74cdd9a83b4f5984674004decfa81/1.21.1.json';
  const meta = await (await fetch(metaUrl)).json();
  const libs = meta.libraries;

  const libsDir = path.join(process.cwd(), 'public/files/launchers/full_libs');
  if (!fs.existsSync(libsDir)) fs.mkdirSync(libsDir, { recursive: true });

  let count = 0;
  for (const lib of libs) {
    if (lib.downloads && lib.downloads.artifact && lib.downloads.artifact.url) {
      count++;
      const url = lib.downloads.artifact.url;
      const filename = path.basename(url);
      const dest = path.join(libsDir, filename);

      if (!fs.existsSync(dest)) {
        try {
          const res = await fetch(url);
          const buf = Buffer.from(await res.arrayBuffer());
          fs.writeFileSync(dest, buf);
          console.log(`[LIB ${count}/${libs.length}] ${filename}`);
        } catch (e) {
          console.error('[LIB ERR]', filename, e.message);
        }
      }
    }
  }

  console.log('[COMPLETED] Создание архива full_libs.tar.gz...');
  const outArchive = path.join(process.cwd(), 'public/files/launchers/full_libs.tar.gz');
  const { execSync } = await import('child_process');
  execSync(`tar -czf "${outArchive}" -C "${libsDir}" .`);
  console.log('FULL_LIBS_ARCHIVE_SIZE:', fs.statSync(outArchive).size);
  process.exit(0);
}

run();
