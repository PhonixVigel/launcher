const fs = require('fs');
const path = require('path');

const forgeJson = JSON.parse(fs.readFileSync('player-launcher/meta/neoforge.json', 'utf8'));
const mcJson = JSON.parse(fs.readFileSync('player-launcher/meta/minecraft.json', 'utf8'));
let lwjglJson = {};
if (fs.existsSync('player-launcher/meta/lwjgl.json')) {
    lwjglJson = JSON.parse(fs.readFileSync('player-launcher/meta/lwjgl.json', 'utf8'));
}

let allLibs = [];
if (mcJson.libraries) allLibs.push(...mcJson.libraries);
if (forgeJson.libraries) allLibs.push(...forgeJson.libraries);
if (lwjglJson.libraries) allLibs.push(...lwjglJson.libraries);

const convertArtifactToPath = (name) => {
    let extension = 'jar';
    if (name.includes('@')) {
        const extSplit = name.split('@');
        extension = extSplit[1];
        name = extSplit[0];
    }
    const parts = name.split(':');
    const groupId = parts[0].replace(/\./g, '/');
    const artifactId = parts[1];
    let version = parts[2];
    let classifier = parts[3] ? `-${parts[3]}` : '';
    return `${groupId}/${artifactId}/${version}/${artifactId}-${version}${classifier}.${extension}`;
};

let modulePathEntries = [];
let jvmCpEntries = [];

for (const lib of allLibs) {
  let p = null;
  if (lib.downloads && lib.downloads.artifact && lib.downloads.artifact.path) {
    p = lib.downloads.artifact.path;
  } else if (lib.name) {
    p = convertArtifactToPath(lib.name);
  }
  if (!p) continue;
  
  const pLower = p.toLowerCase().replace(/\\/g, '/');
  
  // КРИТИЧЕСКИ ВАЖНО: исключаем из classpath утилиты установщика, патчеры и сырой ванильный клиент!
  // ForgeWrapper сам обрабатывает minecraft.jar через свой флаг!
  if (
    pLower.includes('universal') ||
    pLower.includes('installer') ||
    pLower.includes('net/neoforged/neoforge/') ||
    pLower.includes('net/minecraft/client/') ||
    pLower.includes('binarypatcher') || 
    pLower.includes('autorenamingtool') || 
    pLower.includes('installertools') || 
    pLower.includes('jarsplitter') || 
    pLower.includes('cli-utils') || 
    pLower.includes('specialsource') || 
    pLower.includes('srgutils') || 
    pLower.includes('neoform') ||
    pLower.includes('gson-2.8.9')
  ) {
    continue;
  }
  
  const tokenPath = '${game_directory}/libraries/' + p;
  
  if (
    pLower.includes('cpw/mods/bootstraplauncher') || 
    pLower.includes('cpw/mods/securejarhandler') || 
    pLower.includes('org/ow2/asm') || 
    pLower.includes('jarjarfilesystem')
  ) {
    modulePathEntries.push(tokenPath);
  } else {
    jvmCpEntries.push(tokenPath);
  }
}

jvmCpEntries.push('${game_directory}/libraries/io/github/zekerzhayard/ForgeWrapper/prism-2026-08-01/ForgeWrapper-prism-2026-08-01.jar');

const sep = '${cp_separator}';
const uniqueModulePath = [...new Set(modulePathEntries)].join(sep);
const uniqueClasspath = [...new Set(jvmCpEntries)].join(sep);

const targetNeoForgeVer = '21.1.248';

const profile = {
  mainClass: "io.github.zekerzhayard.forgewrapper.installer.Main",
  jvmArgs: [
    "-Dforgewrapper.minecraft=${game_directory}/libraries/net/minecraft/client/1.21.1/minecraft-1.21.1-client.jar",
    "-Dforgewrapper.librariesDir=${game_directory}/libraries",
    "-DlegacyClassPath=" + uniqueClasspath,
    "-DlibraryDirectory=${game_directory}/libraries",
    "-Dforgewrapper.installer=${game_directory}/libraries/net/neoforged/neoforge/21.1.248/neoforge-21.1.248-installer.jar",
    "-DmergeModules=jna-5.14.0.jar,jna-platform-5.14.0.jar;minecraft-1.21.1-client.jar,neoforge-" + targetNeoForgeVer + "-client.jar",
    "-Xms1G",
    "-Xmx${max_memory}M",
    "-Djava.net.preferIPv4Stack=true",
    "--module-path", uniqueModulePath,
    "--add-modules", "ALL-SYSTEM",
    "--add-modules", "ALL-MODULE-PATH",
    "--add-modules", "jdk.naming.dns",
    "--add-opens", "java.base/java.lang=cpw.mods.securejarhandler,ALL-UNNAMED",
    "--add-opens", "java.base/java.lang.invoke=cpw.mods.securejarhandler,ALL-UNNAMED",
    "--add-opens", "java.base/java.util=ALL-UNNAMED",
    "--add-opens", "java.base/java.util.jar=ALL-UNNAMED",
    "--add-opens", "java.base/java.io=ALL-UNNAMED",
    "--add-opens", "java.base/java.nio.channels=ALL-UNNAMED",
    "--add-opens", "java.base/sun.net.www.protocol.jar=ALL-UNNAMED",
    "-Dnet.neoforged.mappedNaming=official",
    "-Dneoforge.stage=client",
    "-Dneoforge.version=" + targetNeoForgeVer,
    "-Dneoforge.modsDir=${game_directory}/mods",
    "-Djava.library.path=${natives_directory}",
    "-cp", uniqueClasspath
  ],
  gameArgs: [
    "--username", "${auth_player_name}",
    "--version", "1.21.1",
    "--gameDir", "${game_directory}",
    "--assetsDir", "${assets_root}",
    "--assetIndex", "17",
    "--uuid", "${auth_uuid}",
    "--accessToken", "${auth_access_token}",
    "--userType", "offline",
    "--versionType", "release",
    "--neoForgeVersion", targetNeoForgeVer,
    "--fml.neoForgeVersion", targetNeoForgeVer,
    "--fmlVersion", "4.0.43",
    "--fml.fmlVersion", "4.0.43",
    "--mcVersion", "1.21.1",
    "--fml.mcVersion", "1.21.1",
    "--neoFormVersion", "20240808.144430",
    "--fml.neoFormVersion", "20240808.144430",
    "--launchTarget", "forgeclient"
  ]
};

fs.writeFileSync('player-launcher/meta/launch-profile.json', JSON.stringify(profile, null, 2));
console.log('PERFECT launch-profile.json generated successfully!');
