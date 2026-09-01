#include "launcher_engine.hpp"
#include "../include/json.hpp"
#include <iostream>
#include <fstream>
#include <sstream>
#include <filesystem>
#include <chrono>
#include <thread>
#include <unistd.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <signal.h>
#include <fcntl.h>
#include <unordered_set>
#include <CommonCrypto/CommonDigest.h>

namespace fs = std::filesystem;
using json = nlohmann::json;

LauncherEngine::LauncherEngine() {}

LauncherEngine::~LauncherEngine() {
    terminateRunningGame();
    if (processMonitorThread.joinable()) {
        processMonitorThread.join();
    }
}

std::string LauncherEngine::getOsName() const {
#if defined(__APPLE__)
    return "osx";
#elif defined(_WIN32)
    return "windows";
#else
    return "linux";
#endif
}

std::string LauncherEngine::getArch() const {
#if defined(__arm64__) || defined(__aarch64__)
    return "arm64";
#else
    return "x86_64";
#endif
}

std::string LauncherEngine::generateOfflineUuid(const std::string& username) const {
    std::string input = "OfflinePlayer:" + username;
    unsigned char digest[CC_MD5_DIGEST_LENGTH];
    CC_MD5(input.c_str(), static_cast<CC_LONG>(input.length()), digest);

    // Установка версии 3 (MD5 UUID) и IETF варианта
    digest[6] = (digest[6] & 0x0f) | 0x30;
    digest[8] = (digest[8] & 0x3f) | 0x80;

    std::ostringstream ss;
    for (int i = 0; i < 16; ++i) {
        if (i == 4 || i == 6 || i == 8 || i == 10) ss << "-";
        ss << std::hex << std::setw(2) << std::setfill('0') << static_cast<int>(digest[i]);
    }
    return ss.str();
}

std::string LauncherEngine::detectJava21() {
    // 1. Попытка через macOS /usr/libexec/java_home
    FILE* pipe = popen("/usr/libexec/java_home -v 21 2>/dev/null", "r");
    if (pipe) {
        char buffer[512];
        std::string result = "";
        while (fgets(buffer, sizeof(buffer), pipe) != nullptr) {
            result += buffer;
        }
        pclose(pipe);
        // Trim newline
        while (!result.empty() && (result.back() == '\n' || result.back() == '\r')) {
            result.pop_back();
        }
        if (!result.empty()) {
            std::string javaExec = result + "/bin/java";
            if (fs::exists(javaExec)) return javaExec;
        }
    }

    // 2. Проверка стандартных путей JVM на macOS
    std::vector<std::string> knownPaths = {
        "/Library/Java/JavaVirtualMachines/temurin-21.jre/Contents/Home/bin/java",
        "/Library/Java/JavaVirtualMachines/temurin-21.jdk/Contents/Home/bin/java",
        "/Library/Java/JavaVirtualMachines/liberica-jdk-21.jdk/Contents/Home/bin/java",
        "/Library/Java/JavaVirtualMachines/zulu-21.jdk/Contents/Home/bin/java",
        "/opt/homebrew/opt/openjdk@21/bin/java",
        "/usr/local/opt/openjdk@21/bin/java"
    };

    for (const auto& p : knownPaths) {
        if (fs::exists(p)) return p;
    }

    // 3. Fallback на JAVA_HOME или системную java
    const char* envHome = getenv("JAVA_HOME");
    if (envHome) {
        std::string path = std::string(envHome) + "/bin/java";
        if (fs::exists(path)) return path;
    }

    return "java";
}

bool LauncherEngine::prepareGameDirectories(const std::string& gameDir) {
    try {
        fs::create_directories(gameDir);
        fs::create_directories(gameDir + "/libraries");
        fs::create_directories(gameDir + "/assets");
        fs::create_directories(gameDir + "/assets/indexes");
        fs::create_directories(gameDir + "/assets/objects");
        fs::create_directories(gameDir + "/mods");
        fs::create_directories(gameDir + "/config");
        fs::create_directories(gameDir + "/logs");
        return true;
    } catch (const std::exception& e) {
        std::cerr << "[LauncherEngine] Error creating game directories: " << e.what() << std::endl;
        return false;
    }
}

bool LauncherEngine::prepareLibrariesAndAssets(const LaunchConfig& config, 
                                              const std::string& gameDir,
                                              std::function<void(int, const std::string&)> progressCallback) {
    std::string libsDir = gameDir + "/libraries";
    std::string osName = getOsName();
    std::string arch = getArch();

    progressCallback(15, "Чтение манифестов компонентов Prism...");

    std::vector<DownloadTask> downloadTasks;

    resolvedRuntimeLibraries.clear();
    std::vector<std::string> metaNames = { "neoforge.json", "minecraft.json", "lwjgl.json" };
    std::string curDir = fs::current_path().string();

    for (const auto& mName : metaNames) {
        ComponentManifest manifest;
        std::vector<std::string> searchPaths = {
            curDir + "/player-launcher/meta/" + mName,
            curDir + "/../player-launcher/meta/" + mName,
            "/Users/maksimzaika/Desktop/vozducraft/player-launcher/meta/" + mName,
            "player-launcher/meta/" + mName
        };

        bool loaded = false;
        for (const auto& sp : searchPaths) {
            if (fs::exists(sp) && manifest.loadFromFile(sp)) {
                loaded = true;
                break;
            }
        }

        if (loaded) {
            auto libs = manifest.getResolvedLibraries(osName, arch);
            for (const auto& l : libs) {
                resolvedRuntimeLibraries.push_back(l);
                if (!l.url.empty() && !l.path.empty()) {
                    DownloadTask t;
                    t.url = l.url;
                    t.destPath = libsDir + "/" + l.path;
                    t.expectedSha1 = l.sha1;
                    t.sizeBytes = l.size;
                    downloadTasks.push_back(t);
                }
            }
        }
    }

    // Добавление клиента Minecraft 1.21.1
    DownloadTask mcClientTask;
    mcClientTask.url = "https://piston-data.mojang.com/v1/objects/30c73b1c5da787909b2f73340419fdf13b9def88/client.jar";
    mcClientTask.destPath = libsDir + "/net/minecraft/client/1.21.1/minecraft-1.21.1-client.jar";
    mcClientTask.expectedSha1 = "30c73b1c5da787909b2f73340419fdf13b9def88";
    downloadTasks.push_back(mcClientTask);

    // Добавление NeoForge 21.1.248 Universal
    DownloadTask nfUniversalTask;
    nfUniversalTask.url = "https://maven.neoforged.net/releases/net/neoforged/neoforge/21.1.248/neoforge-21.1.248-universal.jar";
    nfUniversalTask.destPath = libsDir + "/net/neoforged/neoforge/21.1.248/neoforge-21.1.248-universal.jar";
    downloadTasks.push_back(nfUniversalTask);

    // Добавление NeoForge 21.1.248 Client
    DownloadTask nfClientTask;
    nfClientTask.url = "http://185.221.213.43:3000/files/launchers/neoforge-21.1.248-client.jar";
    nfClientTask.destPath = gameDir + "/neoforge-21.1.248-client.jar";
    downloadTasks.push_back(nfClientTask);

    // Добавление ForgeWrapper Prism 2026-08-01
    DownloadTask fwTask;
    fwTask.url = "https://files.prismlauncher.org/maven/io/github/zekerzhayard/ForgeWrapper/prism-2026-08-01/ForgeWrapper-prism-2026-08-01.jar";
    fwTask.destPath = libsDir + "/io/github/zekerzhayard/ForgeWrapper/prism-2026-08-01/ForgeWrapper-prism-2026-08-01.jar";
    downloadTasks.push_back(fwTask);

    // Синхронизация библиотек и ассетов из локального PrismLauncher кэша при наличии
    std::string homeDir = getenv("HOME") ? getenv("HOME") : "";
    std::string prismLibs = homeDir + "/Library/Application Support/PrismLauncher/libraries";
    if (fs::exists(prismLibs) && fs::is_directory(prismLibs)) {
        progressCallback(25, "Копирование библиотек из Prism Launcher...");
        std::string cmd = "cp -R -n \"" + prismLibs + "/\" \"" + libsDir + "/\" 2>/dev/null";
        system(cmd.c_str());
    }

    // Загрузка всех библиотек параллельно
    progressCallback(30, "Многопоточная синхронизация библиотек...");
    bool batchOk = downloader.downloadBatch(downloadTasks, 8, [&](size_t completed, size_t total, const std::string& fileName) {
        int pct = 30 + static_cast<int>((static_cast<double>(completed) / total) * 45);
        progressCallback(pct, "Загрузка: " + fileName + " (" + std::to_string(completed) + "/" + std::to_string(total) + ")");
    });

    std::string prismAssets = homeDir + "/Library/Application Support/PrismLauncher/assets";
    std::string gameAssets = gameDir + "/assets";
    if (fs::exists(prismAssets) && fs::is_directory(prismAssets)) {
        progressCallback(78, "Синхронизация игровых ассетов...");
        std::string cmd = "cp -R -n \"" + prismAssets + "/\" \"" + gameAssets + "/\" 2>/dev/null";
        system(cmd.c_str());
    }

    return batchOk;
}

bool LauncherEngine::syncModpackFiles(const LaunchConfig& config,
                                     const std::string& gameDir,
                                     std::function<void(int, const std::string&)> progressCallback) {
    progressCallback(80, "Синхронизация файлов модпака для сервера #" + std::to_string(config.serverId) + "...");

    std::string modsDir = (config.serverId <= 1) ? (gameDir + "/mods") : (gameDir + "/mods_server_" + std::to_string(config.serverId));
    fs::create_directories(modsDir);

    std::string homeDir = getenv("HOME") ? getenv("HOME") : "";
    std::string prismMods = homeDir + "/Library/Application Support/PrismLauncher/instances/VozduCraft Season #2/minecraft/mods";
    if (config.serverId <= 1 && fs::exists(prismMods) && fs::is_directory(prismMods)) {
        progressCallback(82, "Интеграция модов сборки VozduCraft Season #2...");
        std::string cmd = "cp -R -n \"" + prismMods + "/\"* \"" + modsDir + "/\" 2>/dev/null";
        system(cmd.c_str());
    }

    std::string manifestUrl = config.apiBaseUrl + "/manifest?serverId=" + std::to_string(config.serverId);
    std::string manifestJsonStr = downloader.downloadToString(manifestUrl);
    if (manifestJsonStr.empty()) {
        manifestJsonStr = downloader.downloadToString("http://185.221.213.43:3000/api/v1/manifest?serverId=" + std::to_string(config.serverId));
    }

    if (manifestJsonStr.empty()) {
        std::cout << "[LauncherEngine] Offline mode or backend unreachable, using local mods in " << modsDir << std::endl;
        return true;
    }

    try {
        auto manifest = json::parse(manifestJsonStr);
        std::vector<DownloadTask> modTasks;

        auto addModFiles = [&](const json& filesArray, bool isOptional) {
            if (!filesArray.is_array()) return;
            for (const auto& fileItem : filesArray) {
                std::string relPath = fileItem.value("filepath", "");
                std::string sha256 = fileItem.value("sha256", "");
                std::string downloadUrl = fileItem.value("download_url", "");

                if (isOptional) {
                    // Проверяем, выбран ли этот опциональный мод
                    bool isSelected = false;
                    for (const auto& opt : config.optionalMods) {
                        if (opt == relPath) { isSelected = true; break; }
                    }
                    if (!isSelected) {
                        // Если опциональный мод не выбран, удаляем если был
                        std::string target = modsDir + "/" + fs::path(relPath).filename().string();
                        if (fs::exists(target)) fs::remove(target);
                        continue;
                    }
                }

                if (!relPath.empty()) {
                    std::string fileName = fs::path(relPath).filename().string();
                    std::string targetPath = modsDir + "/" + fileName;

                    if (!downloadUrl.empty()) {
                        DownloadTask task;
                        task.url = downloadUrl;
                        task.destPath = targetPath;
                        task.expectedSha1 = "";
                        modTasks.push_back(task);
                    }
                }
            }
        };

        if (manifest.contains("files")) addModFiles(manifest["files"], false);
        if (manifest.contains("optionalFiles")) addModFiles(manifest["optionalFiles"], true);

        if (!modTasks.empty()) {
            progressCallback(85, "Загрузка обновленных модов сборки (" + std::to_string(modTasks.size()) + " файлов)...");
            downloader.downloadBatch(modTasks, 6, [&](size_t completed, size_t total, const std::string& name) {
                int pct = 85 + static_cast<int>((static_cast<double>(completed) / total) * 10);
                progressCallback(pct, "Синхронизация мода: " + name);
            });
        }

        // 🛡️ АНТИЧИТ: Очистка папки mods от любых посторонних/читерских jar-файлов
        std::unordered_set<std::string> allowedJarNames;
        auto collectAllowed = [&](const json& filesArray, bool isOptional) {
            if (!filesArray.is_array()) return;
            for (const auto& fileItem : filesArray) {
                std::string relPath = fileItem.value("filepath", "");
                if (isOptional) {
                    bool isSelected = false;
                    for (const auto& opt : config.optionalMods) {
                        if (opt == relPath) { isSelected = true; break; }
                    }
                    if (!isSelected) continue;
                }
                if (!relPath.empty()) {
                    allowedJarNames.insert(fs::path(relPath).filename().string());
                }
            }
        };

        if (manifest.contains("files")) collectAllowed(manifest["files"], false);
        if (manifest.contains("optionalFiles")) collectAllowed(manifest["optionalFiles"], true);

        if (!allowedJarNames.empty() && fs::exists(modsDir)) {
            for (const auto& entry : fs::directory_iterator(modsDir)) {
                if (entry.is_regular_file() && entry.path().extension() == ".jar") {
                    std::string fName = entry.path().filename().string();
                    if (allowedJarNames.find(fName) == allowedJarNames.end()) {
                        std::cout << "[Security] 🛡️ Удален посторонний мод: " << fName << std::endl;
                        try { fs::remove(entry.path()); } catch (...) {}
                    }
                }
            }
        }
    } catch (...) {}
    return true;
}

bool LauncherEngine::launchGame(const LaunchConfig& config,
                               std::function<void(int percent, const std::string& status)> progressCallback,
                               std::function<void(const std::string& logLine)> logCallback,
                               std::function<void(int exitCode)> exitCallback) {
    if (gameRunning.load()) {
        std::cerr << "[LauncherEngine] Game is already running!" << std::endl;
        return false;
    }

    std::string homeDir = getenv("HOME") ? getenv("HOME") : "/tmp";
    std::string gameDir = config.gameDir.empty() ? (homeDir + "/.vozducraft") : config.gameDir;

    progressCallback(5, "Подготовка игровых директорий...");
    prepareGameDirectories(gameDir);

    // 1. Поиск Java 21
    progressCallback(10, "Определение среды исполнения Java 21...");
    std::string javaExec = config.customJavaPath.empty() ? detectJava21() : config.customJavaPath;
    std::cout << "[LauncherEngine] Using Java binary: " << javaExec << std::endl;

    // 2. Скачивание библиотек и ассетов
    if (!prepareLibrariesAndAssets(config, gameDir, progressCallback)) {
        std::cerr << "[LauncherEngine] Warning: Some libraries could not be downloaded." << std::endl;
    }

    // 3. Синхронизация файлов модпака
    syncModpackFiles(config, gameDir, progressCallback);

    // 4. Построение аргументов запуска
    progressCallback(92, "Формирование аргументов JVM и Classpath...");

    std::string libsDir = gameDir + "/libraries";
    std::string modsDir = (config.serverId <= 1) ? (gameDir + "/mods") : (gameDir + "/mods_server_" + std::to_string(config.serverId));
    std::string mcJarPath = libsDir + "/net/minecraft/client/1.21.1/minecraft-1.21.1-client.jar";
    std::string neoForgeClientJar = gameDir + "/neoforge-21.1.234-client.jar";

    std::vector<std::string> modulePathEntries;
    std::vector<std::string> classpathEntries;

    // Формирование module-path и classpath исключительно из манифестов компонентов
    for (const auto& l : resolvedRuntimeLibraries) {
        std::string p = libsDir + "/" + l.path;
        if (!fs::exists(p)) continue;

        if (l.isModule) {
            modulePathEntries.push_back(p);
        } else {
            classpathEntries.push_back(p);
        }
    }

    // Добавление ForgeWrapper в classpath
    std::string fwJar = libsDir + "/io/github/zekerzhayard/ForgeWrapper/prism-2026-08-01/ForgeWrapper-prism-2026-08-01.jar";
    if (!fs::exists(fwJar)) {
        fwJar = libsDir + "/io/github/zekerzhayard/ForgeWrapper/prism-2025-12-07/ForgeWrapper-prism-2025-12-07.jar";
    }
    if (fs::exists(fwJar)) {
        classpathEntries.push_back(fwJar);
    }

    // Дедупликация записей с сохранением порядка (предотвращает Duplicate key exception в Java)
    std::vector<std::string> uniqueModulePathEntries;
    std::unordered_set<std::string> seenModules;
    for (const auto& p : modulePathEntries) {
        if (seenModules.insert(p).second) {
            uniqueModulePathEntries.push_back(p);
        }
    }

    std::vector<std::string> uniqueClasspathEntries;
    std::unordered_set<std::string> seenCp;
    for (const auto& p : classpathEntries) {
        if (seenCp.insert(p).second) {
            uniqueClasspathEntries.push_back(p);
        }
    }

    char pathSep = ':';
    std::string modulePathStr = "";
    for (size_t i = 0; i < uniqueModulePathEntries.size(); ++i) {
        if (i > 0) modulePathStr += pathSep;
        modulePathStr += uniqueModulePathEntries[i];
    }

    std::string classpathStr = "";
    for (size_t i = 0; i < uniqueClasspathEntries.size(); ++i) {
        if (i > 0) classpathStr += pathSep;
        classpathStr += uniqueClasspathEntries[i];
    }

    std::string userUuid = config.uuid.empty() ? generateOfflineUuid(config.username) : config.uuid;
    std::string accessToken = config.accessToken.empty() ? ("VOZDUCRAFT-" + std::to_string(std::chrono::system_clock::now().time_since_epoch().count())) : config.accessToken;

    std::vector<std::string> args;
    args.push_back(javaExec);

    // JVM флаги
    args.push_back("-Xms2G");
    args.push_back("-Xmx" + std::to_string(config.ramGb) + "G");

#if defined(__APPLE__)
    args.push_back("-XstartOnFirstThread");
#endif

    if (!config.disableCustomFlags) {
        args.push_back("-XX:+UnlockExperimentalVMOptions");
        args.push_back("-XX:+UseG1GC");
        args.push_back("-XX:G1NewSizePercent=20");
        args.push_back("-XX:G1ReservePercent=20");
        args.push_back("-XX:MaxGCPauseMillis=50");
        args.push_back("-XX:G1HeapRegionSize=32M");
        args.push_back("-XX:+DisableExplicitGC");
        args.push_back("-XX:+AlwaysPreTouch");
        args.push_back("-XX:+PerfDisableSharedMem");
    }

    // Java Module System аргументы
    if (!modulePathStr.empty()) {
        args.push_back("--module-path");
        args.push_back(modulePathStr);
        args.push_back("--add-modules");
        args.push_back("ALL-SYSTEM");
        args.push_back("--add-modules");
        args.push_back("ALL-MODULE-PATH");
        args.push_back("--add-modules");
        args.push_back("jdk.naming.dns");
    }

    args.push_back("--add-opens"); args.push_back("java.base/java.lang=cpw.mods.securejarhandler,ALL-UNNAMED");
    args.push_back("--add-opens"); args.push_back("java.base/java.lang.invoke=cpw.mods.securejarhandler,ALL-UNNAMED");
    args.push_back("--add-opens"); args.push_back("java.base/java.util=ALL-UNNAMED");
    args.push_back("--add-opens"); args.push_back("java.base/java.util.jar=ALL-UNNAMED");
    args.push_back("--add-opens"); args.push_back("java.base/java.io=ALL-UNNAMED");
    args.push_back("--add-opens"); args.push_back("java.base/java.nio.channels=ALL-UNNAMED");
    args.push_back("--add-opens"); args.push_back("java.base/sun.net.www.protocol.jar=ALL-UNNAMED");

    // NeoForge / ForgeWrapper системные свойства
    std::string fwInstaller = libsDir + "/net/neoforged/neoforge/" + config.neoForgeVersion + "/neoforge-" + config.neoForgeVersion + "-installer.jar";
    std::string mergeModules = "jna-5.14.0.jar,jna-platform-5.14.0.jar;minecraft-1.21.1-client.jar,neoforge-" + config.neoForgeVersion + "-client.jar";

    args.push_back("-Dforgewrapper.minecraft=" + mcJarPath);
    args.push_back("-Dforgewrapper.librariesDir=" + libsDir);
    args.push_back("-DlegacyClassPath=" + classpathStr);
    args.push_back("-DlibraryDirectory=" + libsDir);
    args.push_back("-Dforgewrapper.installer=" + fwInstaller);
    args.push_back("-DmergeModules=" + mergeModules);
    args.push_back("-Dnet.neoforged.mappedNaming=official");
    args.push_back("-DignoreList=bootstraplauncher,securejarhandler");
    args.push_back("-Dneoforge.stage=client");
    args.push_back("-Dneoforge.version=" + config.neoForgeVersion);
    args.push_back("-Dneoforge.modsDir=" + modsDir);

    args.push_back("-cp");
    args.push_back(classpathStr);

    // Главный класс запуска
    args.push_back("io.github.zekerzhayard.forgewrapper.installer.Main");

    std::string fmlVer = (config.neoForgeVersion == "21.1.248") ? "4.0.43" : "4.0.42";

    // Кастомные JVM-флаги из панели управления админа
    if (!config.disableCustomFlags && !config.customJvmFlags.empty()) {
        std::stringstream ss(config.customJvmFlags);
        std::string flag;
        while (ss >> flag) {
            args.push_back(flag);
        }
    }

    // Параметры игры
    args.push_back("--username"); args.push_back(config.username);
    args.push_back("--version"); args.push_back(config.minecraftVersion);
    args.push_back("--gameDir"); args.push_back(gameDir);
    args.push_back("--assetsDir"); args.push_back(gameDir + "/assets");
    args.push_back("--assetIndex"); args.push_back("17");
    args.push_back("--uuid"); args.push_back(userUuid);
    args.push_back("--accessToken"); args.push_back(accessToken);
    args.push_back("--userType"); args.push_back("msa");
    args.push_back("--versionType"); args.push_back("release");
    args.push_back("--neoForgeVersion"); args.push_back(config.neoForgeVersion);
    args.push_back("--fml.neoForgeVersion"); args.push_back(config.neoForgeVersion);
    args.push_back("--fmlVersion"); args.push_back(fmlVer);
    args.push_back("--fml.fmlVersion"); args.push_back(fmlVer);
    args.push_back("--mcVersion"); args.push_back(config.minecraftVersion);
    args.push_back("--fml.mcVersion"); args.push_back(config.minecraftVersion);
    args.push_back("--neoFormVersion"); args.push_back("20240808.144430");
    args.push_back("--fml.neoFormVersion"); args.push_back("20240808.144430");
    args.push_back("--launchTarget"); args.push_back("forgeclient");

    // Авто-вход на сервер при запуске (из настроек админки)
    if (config.autoJoinServer == 1 && !config.serverIp.empty()) {
        args.push_back("--quickPlayMultiplayer");
        args.push_back(config.serverIp + ":" + std::to_string(config.serverPort));
    }

    // Дополнительные параметры игры (Game arguments) из настроек админки
    if (!config.gameArgs.empty()) {
        std::stringstream ss(config.gameArgs);
        std::string gArg;
        while (ss >> gArg) {
            args.push_back(gArg);
        }
    }

    progressCallback(98, "Запуск процесса Minecraft...");

    // Создание каналов IPC (Pipes) для перехвата логов
    int stdoutPipe[2];
    int stderrPipe[2];
    if (pipe(stdoutPipe) < 0 || pipe(stderrPipe) < 0) {
        std::cerr << "[LauncherEngine] Failed to create pipes" << std::endl;
        return false;
    }

    pid_t pid = fork();
    if (pid < 0) {
        std::cerr << "[LauncherEngine] Fork failed!" << std::endl;
        return false;
    }

    if (pid == 0) {
        // Дочерний процесс: настраиваем вывод и запускаем Java
        close(stdoutPipe[0]);
        close(stderrPipe[0]);
        dup2(stdoutPipe[1], STDOUT_FILENO);
        dup2(stderrPipe[1], STDERR_FILENO);
        close(stdoutPipe[1]);
        close(stderrPipe[1]);

        chdir(gameDir.c_str());

        std::vector<char*> c_args;
        for (const auto& a : args) {
            c_args.push_back(const_cast<char*>(a.c_str()));
        }
        c_args.push_back(nullptr);

        execvp(c_args[0], c_args.data());
        _exit(127);
    }

    // Родительский процесс
    close(stdoutPipe[1]);
    close(stderrPipe[1]);

    runningPid = pid;
    gameRunning = true;
    progressCallback(100, "Minecraft успешно запущен!");

    std::string logFilePath = gameDir + "/game_output.log";

    if (processMonitorThread.joinable()) {
        processMonitorThread.join();
    }

    processMonitorThread = std::thread([this, pid, stdoutFd = stdoutPipe[0], stderrFd = stderrPipe[0], logFilePath, logCallback, exitCallback, gameDir, config]() {
        std::ofstream logFile(logFilePath, std::ios::app);
        auto now = std::chrono::system_clock::to_time_t(std::chrono::system_clock::now());
        logFile << "\n=== СТАРТ VOZDUCRAFT C++ LAUNCHER LOG [" << std::ctime(&now) << "] ===\n";

        // Читаем логи из дескрипторов
        auto readStream = [&](int fd, const std::string& prefix) {
            char buf[1024];
            std::string lineBuf = "";
            ssize_t bytesRead;
            while ((bytesRead = read(fd, buf, sizeof(buf) - 1)) > 0) {
                buf[bytesRead] = '\0';
                for (ssize_t i = 0; i < bytesRead; ++i) {
                    if (buf[i] == '\n') {
                        std::string fullLine = prefix + lineBuf;
                        logFile << fullLine << "\n";
                        logFile.flush();
                        if (logCallback) logCallback(fullLine);
                        lineBuf.clear();
                    } else if (buf[i] != '\r') {
                        lineBuf += buf[i];
                    }
                }
            }
            if (!lineBuf.empty()) {
                std::string fullLine = prefix + lineBuf;
                logFile << fullLine << "\n";
                if (logCallback) logCallback(fullLine);
            }
            close(fd);
        };

        std::thread stdoutReader([&]() { readStream(stdoutFd, "[GAME OUT] "); });
        std::thread stderrReader([&]() { readStream(stderrFd, "[GAME ERR] "); });

        int status;
        waitpid(pid, &status, 0);

        if (stdoutReader.joinable()) stdoutReader.join();
        if (stderrReader.joinable()) stderrReader.join();

        int exitCode = WIFEXITED(status) ? WEXITSTATUS(status) : -1;
        logFile << "\n=== ПРОЦЕСС ЗАВЕРШИЛСЯ С КОДОМ: " << exitCode << " ===\n";
        logFile.close();

        // Автоматическая проверка и отправка краш-репортов из папки /crash-reports
        try {
            std::string crashReportsDir = gameDir + "/crash-reports";
            if (fs::exists(crashReportsDir) && fs::is_directory(crashReportsDir)) {
                std::string latestCrashFile = "";
                fs::file_time_type latestTime{};
                for (const auto& entry : fs::directory_iterator(crashReportsDir)) {
                    if (entry.is_regular_file() && entry.path().extension() == ".txt") {
                        auto ftime = fs::last_write_time(entry);
                        if (latestCrashFile.empty() || ftime > latestTime) {
                            latestCrashFile = entry.path().string();
                            latestTime = ftime;
                        }
                    }
                }
                if (!latestCrashFile.empty()) {
                    std::ifstream crStream(latestCrashFile);
                    if (crStream.is_open()) {
                        std::stringstream crBuffer;
                        crBuffer << crStream.rdbuf();
                        std::string crContent = crBuffer.str();
                        std::string fname = fs::path(latestCrashFile).filename().string();

                        json payload;
                        payload["username"] = config.username;
                        payload["os"] = "macOS";
#if defined(_WIN32)
                        payload["os"] = "Windows";
#endif
                        payload["server_id"] = config.serverId;
                        payload["crash_filename"] = fname;
                        payload["report_content"] = crContent;

                        std::string uploadUrl = config.apiBaseUrl + "/launcher/crash-report";
                        downloader.postJson(uploadUrl, payload.dump());
                    }
                }
            }
        } catch (...) {}

        this->gameRunning = false;
        this->runningPid = -1;

        if (exitCallback) {
            exitCallback(exitCode);
        }
    });

    return true;
}

void LauncherEngine::terminateRunningGame() {
    int pid = runningPid.load();
    if (pid > 0) {
        kill(pid, SIGTERM);
        std::this_thread::sleep_for(std::chrono::milliseconds(500));
        if (gameRunning.load()) {
            kill(pid, SIGKILL);
        }
    }
}
