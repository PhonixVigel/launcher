#ifndef LAUNCHER_ENGINE_HPP
#define LAUNCHER_ENGINE_HPP

#include <string>
#include <vector>
#include <functional>
#include <atomic>
#include <thread>
#include "downloader.hpp"
#include "component_manifest.hpp"

struct LaunchConfig {
    std::string username = "Player";
    std::string uuid;
    std::string accessToken;
    int ramGb = 6;
    std::string gameDir;
    std::string customJavaPath;
    std::string customJvmFlags;
    bool disableCustomFlags = false;
    std::vector<std::string> optionalMods;
    std::string neoForgeVersion = "21.1.248";
    std::string minecraftVersion = "1.21.1";
    int serverId = 1;
    std::string serverIp = "89.248.236.145";
    int serverPort = 27123;
    std::string apiBaseUrl = "http://localhost:3000/api/v1";
    std::string gameArgs;
    int autoJoinServer = 1;
};

class LauncherEngine {
public:
    LauncherEngine();
    ~LauncherEngine();

    // Поиск установленного Java 21 на системе
    static std::string detectJava21();

    // Запуск процесса подготовки и запуска игры
    bool launchGame(const LaunchConfig& config,
                    std::function<void(int percent, const std::string& status)> progressCallback,
                    std::function<void(const std::string& logLine)> logCallback,
                    std::function<void(int exitCode)> exitCallback);

    // Завершение работающего процесса игры при необходимости
    void terminateRunningGame();

    bool isGameRunning() const { return gameRunning.load(); }

private:
    Downloader downloader;
    std::atomic<bool> gameRunning{false};
    std::atomic<int> runningPid{-1};
    std::thread processMonitorThread;

    std::string getOsName() const;
    std::string getArch() const;
    std::string generateOfflineUuid(const std::string& username) const;

    bool prepareGameDirectories(const std::string& gameDir);
    bool prepareLibrariesAndAssets(const LaunchConfig& config, 
                                   const std::string& gameDir,
                                   std::function<void(int, const std::string&)> progressCallback);
    bool syncModpackFiles(const LaunchConfig& config,
                          const std::string& gameDir,
                          std::function<void(int, const std::string&)> progressCallback);

    std::vector<LibraryEntry> resolvedRuntimeLibraries;
};

#endif // LAUNCHER_ENGINE_HPP
