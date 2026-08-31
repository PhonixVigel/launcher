#if defined(__APPLE__)
#import <Cocoa/Cocoa.h>
#include <mach-o/dyld.h>
#endif

#define WEBVIEW_IMPLEMENTATION
#include "../include/webview.h"
#include "../include/json.hpp"
#include "launcher_engine.hpp"
#include "downloader.hpp"
#include <iostream>
#include <fstream>
#include <sstream>
#include <filesystem>
#include <thread>
#include <memory>
#include <cstdlib>

namespace fs = std::filesystem;
using json = nlohmann::json;

static std::unique_ptr<LauncherEngine> g_launcherEngine;
static std::unique_ptr<webview::webview> g_webview;

// Безопасное экранирование JS строк для выполнения в WebView
std::string escapeJs(const std::string& str) {
    std::ostringstream o;
    for (char c : str) {
        if (c == '"') o << "\\\"";
        else if (c == '\\') o << "\\\\";
        else if (c == '\b') o << "\\b";
        else if (c == '\f') o << "\\f";
        else if (c == '\n') o << "\\n";
        else if (c == '\r') o << "\\r";
        else if (c == '\t') o << "\\t";
        else o << c;
    }
    return o.str();
}

std::string getExecutableDir() {
#if defined(__APPLE__)
    char path[1024];
    uint32_t size = sizeof(path);
    if (_NSGetExecutablePath(path, &size) == 0) {
        return fs::path(path).parent_path().string();
    }
#endif
    return fs::current_path().string();
}

std::string findIndexPath() {
    std::string exeDir = getExecutableDir();
    std::string curDir = fs::current_path().string();

    std::vector<std::string> candidates = {
        exeDir + "/../Resources/ui/index.html",
        exeDir + "/../Resources/index.html",
        exeDir + "/player-launcher/index.html",
        exeDir + "/../../player-launcher/index.html",
        curDir + "/player-launcher/index.html",
        curDir + "/../player-launcher/index.html",
        "/Users/maksimzaika/Desktop/vozducraft/player-launcher/index.html"
    };

    for (const auto& candidate : candidates) {
        if (fs::exists(candidate)) {
            return fs::canonical(candidate).string();
        }
    }
    return "";
}

int main(int argc, char** argv) {
    g_launcherEngine = std::make_unique<LauncherEngine>();

    // Инициализация WebView окна (1160x720) с поддержкой изменения размера (Resizable)
    g_webview = std::make_unique<webview::webview>(true, nullptr);
    g_webview->set_title("VozduCraft Launcher");
    g_webview->set_size(1160, 720, WEBVIEW_HINT_NONE);

#if defined(__APPLE__)
    // Настройка кастомного окна macOS без системной рамки с поддержкой Resizing и Dragging
    NSWindow* nsWindow = (NSWindow*)g_webview->window();
    if (nsWindow) {
        [nsWindow setStyleMask:NSWindowStyleMaskTitled | NSWindowStyleMaskFullSizeContentView | NSWindowStyleMaskClosable | NSWindowStyleMaskMiniaturizable | NSWindowStyleMaskResizable];
        [nsWindow setTitleVisibility:NSWindowTitleHidden];
        [nsWindow setTitlebarAppearsTransparent:YES];
        [nsWindow setMovableByWindowBackground:YES];
        [nsWindow setMinSize:NSMakeSize(1000, 640)];
        [nsWindow setBackgroundColor:[NSColor colorWithCalibratedRed:0.035 green:0.04 blue:0.07 alpha:1.0]];
        [[nsWindow standardWindowButton:NSWindowCloseButton] setHidden:YES];
        [[nsWindow standardWindowButton:NSWindowMiniaturizeButton] setHidden:YES];
        [[nsWindow standardWindowButton:NSWindowZoomButton] setHidden:YES];
    }
#endif

    // 0. Управление окном (Свернуть / Закрыть / Перетаскивание)
    g_webview->bind("nativeCloseWindow", [](const std::string&) -> std::string {
#if defined(__APPLE__)
        NSWindow* nsWindow = (NSWindow*)g_webview->window();
        if (nsWindow) {
            [nsWindow performClose:nil];
        }
        exit(0);
#endif
        return "{}";
    });

    g_webview->bind("nativeMinimizeWindow", [](const std::string&) -> std::string {
#if defined(__APPLE__)
        NSWindow* nsWindow = (NSWindow*)g_webview->window();
        if (nsWindow) {
            [nsWindow miniaturize:nil];
        }
#endif
        return "{}";
    });

    // Нативное перетаскивание окна macOS без рывков
    g_webview->bind("nativeDragWindow", [](const std::string&) -> std::string {
#if defined(__APPLE__)
        dispatch_async(dispatch_get_main_queue(), ^{
            NSWindow* nsWindow = (NSWindow*)g_webview->window();
            if (nsWindow) {
                NSEvent* event = [NSApp currentEvent];
                if (event) {
                    [nsWindow performWindowDragWithEvent:event];
                }
            }
        });
#endif
        return "{}";
    });

    // Получение списка игровых скриншотов
    g_webview->bind("nativeGetScreenshots", [](const std::string&) -> std::string {
        std::string homeDir = getenv("HOME") ? getenv("HOME") : "/tmp";
        std::vector<std::string> searchDirs = {
            homeDir + "/.vozducraft/screenshots",
            homeDir + "/Library/Application Support/PrismLauncher/instances/VozduCraft Season #2/minecraft/screenshots"
        };
        json result = json::array();
        for (const auto& dir : searchDirs) {
            if (fs::exists(dir) && fs::is_directory(dir)) {
                for (const auto& entry : fs::directory_iterator(dir)) {
                    if (entry.is_regular_file()) {
                        std::string ext = entry.path().extension().string();
                        if (ext == ".png" || ext == ".jpg" || ext == ".jpeg") {
                            std::ifstream f(entry.path().string(), std::ios::binary);
                            if (f) {
                                std::vector<unsigned char> buf((std::istreambuf_iterator<char>(f)), std::istreambuf_iterator<char>());
                                // Конвертация в base64
                                static const char b64table[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
                                std::string b64;
                                int val = 0, valb = -6;
                                for (unsigned char c : buf) {
                                    val = (val << 8) + c;
                                    valb += 8;
                                    while (valb >= 0) {
                                        b64.push_back(b64table[(val >> valb) & 0x3F]);
                                        valb -= 6;
                                    }
                                }
                                if (valb > -6) b64.push_back(b64table[((val << 8) >> (valb + 8)) & 0x3F]);
                                while (b64.size() % 4) b64.push_back('=');

                                json item;
                                item["filename"] = entry.path().filename().string();
                                item["path"] = entry.path().string();
                                item["data"] = "data:image/png;base64," + b64;
                                result.push_back(item);
                            }
                        }
                    }
                }
            }
        }
        return result.dump();
    });

    // Копирование скриншота в буфер обмена macOS
    g_webview->bind("nativeCopyImageToClipboard", [](const std::string& req) -> std::string {
#if defined(__APPLE__)
        try {
            auto parsed = json::parse(req);
            std::string filePath = parsed.is_array() && !parsed.empty() ? parsed[0].get<std::string>() : parsed.value("path", "");
            if (!filePath.empty() && fs::exists(filePath)) {
                dispatch_async(dispatch_get_main_queue(), ^{
                    NSString* nsPath = [NSString stringWithUTF8String:filePath.c_str()];
                    NSImage* image = [[NSImage alloc] initWithContentsOfFile:nsPath];
                    if (image) {
                        NSPasteboard* pasteboard = [NSPasteboard generalPasteboard];
                        [pasteboard clearContents];
                        [pasteboard writeObjects:@[image]];
                    }
                });
            }
        } catch (...) {}
#endif
        return "{}";
    });

    // 1. Привязка нативного метода launchGame (C++ -> JS)
    g_webview->bind("nativeLaunchGame", [](const std::string& req) -> std::string {
        std::thread([req]() {
            try {
                auto parsed = json::parse(req);
                auto configObj = parsed.is_array() && !parsed.empty() ? parsed[0] : parsed;

                LaunchConfig config;
                config.username = configObj.value("username", "Player");
                config.ramGb = configObj.value("ram", 6);
                config.accessToken = configObj.value("token", "");
                config.disableCustomFlags = configObj.value("disableJvmFlags", false);
                config.neoForgeVersion = configObj.value("neoForgeVersion", "21.1.248");
                config.minecraftVersion = configObj.value("minecraftVersion", "1.21.1");
                config.serverId = configObj.value("serverId", 1);
                config.serverIp = configObj.value("serverIp", "89.248.236.145");
                config.serverPort = configObj.value("serverPort", 27123);
                config.apiBaseUrl = configObj.value("apiBaseUrl", "http://localhost:3000/api/v1");
                config.customJvmFlags = configObj.value("customJvmFlags", "");
                config.gameArgs = configObj.value("gameArgs", "");
                config.autoJoinServer = configObj.value("autoJoinServer", 1);

                if (configObj.contains("selectedOptionalMods") && configObj["selectedOptionalMods"].is_array()) {
                    for (const auto& opt : configObj["selectedOptionalMods"]) {
                        config.optionalMods.push_back(opt.get<std::string>());
                    }
                }

                g_launcherEngine->launchGame(
                    config,
                    [](int percent, const std::string& text) {
                        std::string js = "if(window.__VOZDUCRAFT_ON_STATUS) window.__VOZDUCRAFT_ON_STATUS(" + 
                                         std::to_string(percent) + ", \"" + escapeJs(text) + "\");";
                        if (g_webview) g_webview->dispatch([js]() { g_webview->eval(js); });
                    },
                    [](const std::string& logLine) {
                        std::string js = "if(window.__VOZDUCRAFT_ON_LOG) window.__VOZDUCRAFT_ON_LOG(\"" + 
                                         escapeJs(logLine) + "\");";
                        if (g_webview) g_webview->dispatch([js]() { g_webview->eval(js); });
                    },
                    [](int exitCode) {
                        std::string js = "if(window.__VOZDUCRAFT_ON_GAME_CLOSED) window.__VOZDUCRAFT_ON_GAME_CLOSED(" + 
                                         std::to_string(exitCode) + ");";
                        if (g_webview) g_webview->dispatch([js]() { g_webview->eval(js); });
                    }
                );

            } catch (const std::exception& e) {
                std::string errJs = "if(window.__VOZDUCRAFT_ON_STATUS) window.__VOZDUCRAFT_ON_STATUS(0, \"Ошибка: " + 
                                    escapeJs(e.what()) + "\");";
                if (g_webview) g_webview->dispatch([errJs]() { g_webview->eval(errJs); });
            }
        }).detach();

        return "{\"status\":\"starting\"}";
    });

    // 2. Открытие системных папок в проводнике/Finder
    g_webview->bind("nativeOpenFolder", [](const std::string& req) -> std::string {
        try {
            auto parsed = json::parse(req);
            std::string folderType = parsed.is_array() && !parsed.empty() ? parsed[0].get<std::string>() : "root";
            
            std::string homeDir = getenv("HOME") ? getenv("HOME") : "/tmp";
            std::string targetPath = homeDir + "/.vozducraft";

            if (folderType == "screenshots") targetPath += "/screenshots";
            else if (folderType == "config") targetPath += "/config";
            else if (folderType == "logs") targetPath += "/logs";
            else if (folderType == "mods") targetPath += "/mods";

            fs::create_directories(targetPath);

#if defined(__APPLE__)
            std::string cmd = "open \"" + targetPath + "\"";
#elif defined(_WIN32)
            std::string cmd = "explorer \"" + targetPath + "\"";
#else
            std::string cmd = "xdg-open \"" + targetPath + "\"";
#endif
            system(cmd.c_str());
            return "{\"success\":true}";
        } catch (...) {
            return "{\"success\":false}";
        }
    });

    // 3. Загрузка модпака с Яндекс.Диска / Google Drive / Modrinth / Прямой ссылки
    g_webview->bind("nativeDownloadModpack", [](const std::string& req) -> std::string {
        std::thread([req]() {
            try {
                auto parsed = json::parse(req);
                std::string url = parsed.is_array() && !parsed.empty() ? parsed[0].get<std::string>() : "";
                
                Downloader dl;
                std::string directUrl = url;

                if (url.find("yadi.sk") != std::string::npos || url.find("disk.yandex.ru") != std::string::npos) {
                    directUrl = dl.resolveYandexDiskUrl(url);
                } else if (url.find("drive.google.com") != std::string::npos) {
                    directUrl = dl.resolveGoogleDriveUrl(url);
                }

                std::string homeDir = getenv("HOME") ? getenv("HOME") : "/tmp";
                std::string tempZip = homeDir + "/.vozducraft/temp_modpack.zip";
                std::string gameDir = homeDir + "/.vozducraft";

                bool ok = dl.downloadFile(directUrl, tempZip, [](int64_t cur, int64_t total) {
                    if (total > 0) {
                        int pct = static_cast<int>((static_cast<double>(cur) / total) * 100);
                        std::string js = "if(window.__VOZDUCRAFT_ON_STATUS) window.__VOZDUCRAFT_ON_STATUS(" + 
                                         std::to_string(pct) + ", \"Загрузка сборки: " + 
                                         std::to_string(cur/1024/1024) + "/" + std::to_string(total/1024/1024) + " МБ\");";
                        if (g_webview) g_webview->dispatch([js]() { g_webview->eval(js); });
                    }
                });

                if (ok) {
                    Downloader::extractZip(tempZip, gameDir);
                    fs::remove(tempZip);
                    std::string js = "if(window.__VOZDUCRAFT_ON_STATUS) window.__VOZDUCRAFT_ON_STATUS(100, \"Сборка успешно установлена!\");";
                    if (g_webview) g_webview->dispatch([js]() { g_webview->eval(js); });
                }
            } catch (...) {}
        }).detach();

        return "{\"status\":\"downloading\"}";
    });

    // 4. Информация о системе
    g_webview->bind("nativeGetSystemInfo", [](const std::string&) -> std::string {
        json info;
        info["os"] = "macOS";
        info["arch"] = "arm64";
        info["javaPath"] = LauncherEngine::detectJava21();
        return info.dump();
    });

    // Определение пути к HTML UI
    std::string indexPath = findIndexPath();

    if (!indexPath.empty()) {
        std::cout << "[Main] Loading UI from: " << indexPath << std::endl;
        g_webview->navigate("file://" + indexPath);
    } else {
        std::cerr << "[Main] Error: index.html not found." << std::endl;
        g_webview->set_html("<h1>Error: UI not found. Please check bundle resources.</h1>");
    }

    // Запуск главного цикла событий
    g_webview->run();

    return 0;
}
