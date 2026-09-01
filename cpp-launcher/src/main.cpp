#if defined(__APPLE__)
#import <Cocoa/Cocoa.h>
#include <mach-o/dyld.h>
#endif

#define WEBVIEW_IMPLEMENTATION
#include "../include/webview.h"
#include "../include/json.hpp"
#include "launcher_engine.hpp"
#include "downloader.hpp"
#include <curl/curl.h>
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
static std::mutex g_logMutex;

void logToDebugFile(const std::string& tag, const std::string& msg) {
    std::lock_guard<std::mutex> lock(g_logMutex);
    std::string homeDir = getenv("HOME") ? getenv("HOME") : "/tmp";
    std::string logPath = homeDir + "/Desktop/vozducraft_debug.log";
    
    std::ofstream out(logPath, std::ios::app);
    if (out.is_open()) {
        auto now = std::chrono::system_clock::now();
        auto in_time_t = std::chrono::system_clock::to_time_t(now);
        std::stringstream ss;
        ss << std::put_time(std::localtime(&in_time_t), "%Y-%m-%d %H:%M:%S");
        out << "[" << ss.str() << "] [" << tag << "] " << msg << "\n";
        out.flush();
    }
    std::cout << "[" << tag << "] " << msg << std::endl;
}

// Универсальный парсер аргументов из JS bindings (поддерживает stringified JSON, raw objects и массивы)
json extractJsonArg(const std::string& req) {
    try {
        json parsed = json::parse(req);
        if (parsed.is_array() && !parsed.empty()) {
            if (parsed[0].is_string()) {
                try { return json::parse(parsed[0].get<std::string>()); } catch (...) { return json::object(); }
            }
            if (parsed[0].is_object()) {
                return parsed[0];
            }
        }
        if (parsed.is_string()) {
            try { return json::parse(parsed.get<std::string>()); } catch (...) { return json::object(); }
        }
        if (parsed.is_object()) {
            return parsed;
        }
    } catch (...) {}
    return json::object();
}

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
    curl_global_init(CURL_GLOBAL_ALL);
    g_launcherEngine = std::make_unique<LauncherEngine>();

#if defined(__APPLE__)
    // Создание стандартного главного меню macOS для поддержки горячих клавиш (Cmd+Q, Cmd+H, Cmd+M, Cmd+C, Cmd+V, etc.)
    NSMenu* menubar = [[NSMenu alloc] init];
    
    // Меню приложения
    NSMenuItem* appMenuItem = [[NSMenuItem alloc] init];
    [menubar addItem:appMenuItem];
    NSMenu* appMenu = [[NSMenu alloc] init];
    [appMenu addItemWithTitle:@"О программе VozduCraft" action:nil keyEquivalent:@""];
    [appMenu addItem:[NSMenuItem separatorItem]];
    [appMenu addItemWithTitle:@"Скрыть VozduCraft" action:@selector(hide:) keyEquivalent:@"h"];
    [appMenu addItemWithTitle:@"Скрыть остальные" action:@selector(hideOtherApplications:) keyEquivalent:@"h"];
    [[appMenu itemAtIndex:3] setKeyEquivalentModifierMask:NSEventModifierFlagCommand | NSEventModifierFlagOption];
    [appMenu addItemWithTitle:@"Показать все" action:@selector(unhideAllApplications:) keyEquivalent:@""];
    [appMenu addItem:[NSMenuItem separatorItem]];
    [appMenu addItemWithTitle:@"Завершить VozduCraft" action:@selector(terminate:) keyEquivalent:@"q"];
    [appMenuItem setSubmenu:appMenu];

    // Меню Правка (Cmd+C, Cmd+V, Cmd+A, Cmd+X, Cmd+Z)
    NSMenuItem* editMenuItem = [[NSMenuItem alloc] init];
    [menubar addItem:editMenuItem];
    NSMenu* editMenu = [[NSMenu alloc] initWithTitle:@"Правка"];
    [editMenu addItemWithTitle:@"Отменить" action:@selector(undo:) keyEquivalent:@"z"];
    [editMenu addItemWithTitle:@"Повторить" action:@selector(redo:) keyEquivalent:@"Z"];
    [editMenu addItem:[NSMenuItem separatorItem]];
    [editMenu addItemWithTitle:@"Вырезать" action:@selector(cut:) keyEquivalent:@"x"];
    [editMenu addItemWithTitle:@"Копировать" action:@selector(copy:) keyEquivalent:@"c"];
    [editMenu addItemWithTitle:@"Вставить" action:@selector(paste:) keyEquivalent:@"v"];
    [editMenu addItemWithTitle:@"Выбрать всё" action:@selector(selectAll:) keyEquivalent:@"a"];
    [editMenuItem setSubmenu:editMenu];

    // Меню Окно (Cmd+M, Cmd+W)
    NSMenuItem* windowMenuItem = [[NSMenuItem alloc] init];
    [menubar addItem:windowMenuItem];
    NSMenu* windowMenu = [[NSMenu alloc] initWithTitle:@"Окно"];
    [windowMenu addItemWithTitle:@"Убрать в Dock" action:@selector(performMiniaturize:) keyEquivalent:@"m"];
    [windowMenu addItemWithTitle:@"Закрыть окно" action:@selector(performClose:) keyEquivalent:@"w"];
    [windowMenuItem setSubmenu:windowMenu];

    [NSApp setMainMenu:menubar];
#endif

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

    // Нативное открытие внешней ссылки
    g_webview->bind("nativeOpenUrl", [](const std::string& reqJson) -> std::string {
        try {
            std::string url = "";
            try {
                auto j = json::parse(reqJson);
                if (j.is_array() && !j.empty()) {
                    if (j[0].is_string()) url = j[0].get<std::string>();
                    else if (j[0].is_object()) url = j[0].value("url", "");
                } else if (j.is_string()) url = j.get<std::string>();
                else if (j.is_object()) url = j.value("url", "");
            } catch (...) {
                url = reqJson;
            }

            if (!url.empty()) {
#if defined(__APPLE__)
                NSString* nsUrlStr = [NSString stringWithUTF8String:url.c_str()];
                NSURL* nsUrl = [NSURL URLWithString:nsUrlStr];
                [[NSWorkspace sharedWorkspace] openURL:nsUrl];
#elif defined(_WIN32)
                ShellExecuteA(NULL, "open", url.c_str(), NULL, NULL, SW_SHOWNORMAL);
#endif
            }
        } catch (...) {}
        return "{}";
    });

    // Нативное логирование из JS UI в файл на Рабочем столе
    g_webview->bind("nativeLog", [](const std::string& req) -> std::string {
        try {
            auto j = json::parse(req);
            std::string msg = j.is_array() && !j.empty() ? j[0].get<std::string>() : req;
            logToDebugFile("JS-UI", msg);
        } catch (...) {
            logToDebugFile("JS-UI", req);
        }
        return "{}";
    });

    // Нативное скачивание и запуск обновления лаунчера прямо в приложении
    g_webview->bind("nativeAutoUpdateLauncher", [](const std::string& reqJson) -> std::string {
        logToDebugFile("AutoUpdater", "Received nativeAutoUpdateLauncher call: " + reqJson);
        std::thread([](std::string params) {
            try {
                std::string downloadUrl = "";
                try {
                    auto j = json::parse(params);
                    if (j.is_array() && !j.empty()) {
                        if (j[0].is_string()) {
                            std::string s = j[0].get<std::string>();
                            if (s.rfind("http", 0) == 0) downloadUrl = s;
                            else {
                                try {
                                    auto inner = json::parse(s);
                                    downloadUrl = inner.value("url", "");
                                } catch (...) {
                                    downloadUrl = s;
                                }
                            }
                        } else if (j[0].is_object()) {
                            downloadUrl = j[0].value("url", "");
                        }
                    } else if (j.is_object()) {
                        downloadUrl = j.value("url", "");
                    } else if (j.is_string()) {
                        downloadUrl = j.get<std::string>();
                    }
                } catch (...) {
                    downloadUrl = params;
                }

                if (downloadUrl.empty()) {
                    logToDebugFile("AutoUpdater", "ERROR: Empty download URL from params: " + params);
                    return;
                }

                std::string homeDir = getenv("HOME") ? getenv("HOME") : "/tmp";
                std::string destFile = homeDir + "/Downloads/VozduCraft-Update.dmg";
#if defined(_WIN32)
                destFile = homeDir + "/Downloads/VozduCraft-Update.zip";
#endif

                std::string username = "Player";
                try {
                    auto j = json::parse(params);
                    if (j.is_object() && j.contains("username")) username = j["username"].get<std::string>();
                    else if (j.is_array() && !j.empty() && j[0].is_object() && j[0].contains("username")) username = j[0]["username"].get<std::string>();
                } catch (...) {}

                logToDebugFile("AutoUpdater", "Starting download from: " + downloadUrl + " to: " + destFile);

                Downloader dl;

                std::string jsStart = "if(window.onLauncherUpdateProgress) window.onLauncherUpdateProgress(1, 0.1, 15.4);";
#if defined(__APPLE__)
                dispatch_async(dispatch_get_main_queue(), ^{
                    if (g_webview) g_webview->eval(jsStart);
                });
#else
                if (g_webview) g_webview->eval(jsStart);
#endif

                bool ok = dl.downloadFile(downloadUrl, destFile, [](int64_t dlNow, int64_t dlTotal) {
                    if (dlTotal > 0) {
                        int pct = static_cast<int>((static_cast<double>(dlNow) / dlTotal) * 100);
                        if (pct < 1) pct = 1;
                        double mbNow = static_cast<double>(dlNow) / (1024.0 * 1024.0);
                        double mbTotal = static_cast<double>(dlTotal) / (1024.0 * 1024.0);
                        std::string js = "if(window.onLauncherUpdateProgress) window.onLauncherUpdateProgress(" + 
                                         std::to_string(pct) + ", " + 
                                         std::to_string(mbNow) + ", " + 
                                         std::to_string(mbTotal) + ");";
#if defined(__APPLE__)
                        dispatch_async(dispatch_get_main_queue(), ^{
                            if (g_webview) g_webview->eval(js);
                        });
#else
                        if (g_webview) g_webview->eval(js);
#endif
                    }
                });

                if (ok) {
                    logToDebugFile("AutoUpdater", "SUCCESS: Download complete! Launching: " + destFile);

                    try {
                        json successPayload;
                        successPayload["username"] = username;
                        successPayload["os"] = "macOS";
                        successPayload["launcher_version"] = "3.0.2";
                        successPayload["event_type"] = "UPDATE_SUCCESS";
                        successPayload["log_content"] = "[C++ AutoUpdater] Загрузка 100% завершена! Запуск установщика: " + destFile;
                        dl.postJson("http://185.221.213.43:3000/api/v1/launcher/debug-log", successPayload.dump());
                    } catch (...) {}

                    std::string js = "if(window.onLauncherUpdateComplete) window.onLauncherUpdateComplete();";
#if defined(__APPLE__)
                    dispatch_async(dispatch_get_main_queue(), ^{
                        if (g_webview) g_webview->eval(js);
                    });
#else
                    if (g_webview) g_webview->eval(js);
#endif

                    std::this_thread::sleep_for(std::chrono::milliseconds(1200));

#if defined(__APPLE__)
                    std::string updateScript = 
                        "(sleep 1 && "
                        "hdiutil detach /tmp/VozduCraftMount 2>/dev/null || true; "
                        "hdiutil detach /Volumes/VozduCraft 2>/dev/null || true; "
                        "mkdir -p /tmp/VozduCraftMount && "
                        "hdiutil attach \"" + destFile + "\" -nobrowse -mountpoint /tmp/VozduCraftMount && "
                        "rm -rf /Applications/VozduCraft.app 2>/dev/null || true && "
                        "cp -R /tmp/VozduCraftMount/VozduCraft.app /Applications/ && "
                        "hdiutil detach /tmp/VozduCraftMount 2>/dev/null || true && "
                        "open -n /Applications/VozduCraft.app) &";
                    logToDebugFile("AutoUpdater", "Running macOS seamless update script: " + updateScript);
                    system(updateScript.c_str());
                    exit(0);
#elif defined(_WIN32)
                    ShellExecuteA(NULL, "open", destFile.c_str(), "/S", NULL, SW_SHNORMAL);
                    exit(0);
#endif
                } else {
                    logToDebugFile("AutoUpdater", "ERROR: Download failed for URL: " + downloadUrl);

                    try {
                        json errPayload;
                        errPayload["username"] = username;
                        errPayload["os"] = "macOS";
                        errPayload["launcher_version"] = "3.0.2";
                        errPayload["event_type"] = "UPDATE_ERROR";
                        errPayload["log_content"] = "[C++ AutoUpdater] Ошибка скачивания по URL: " + downloadUrl;
                        dl.postJson("http://185.221.213.43:3000/api/v1/launcher/debug-log", errPayload.dump());
                    } catch (...) {}

                    std::string errJs = "if(window.onLauncherUpdateError) window.onLauncherUpdateError('Не удалось скачать файл обновления. Проверьте сеть или ссылку.');";
#if defined(__APPLE__)
                    dispatch_async(dispatch_get_main_queue(), ^{
                        if (g_webview) g_webview->eval(errJs);
                    });
#else
                    if (g_webview) g_webview->eval(errJs);
#endif
                }
            } catch (const std::exception& e) {
                logToDebugFile("AutoUpdater", "EXCEPTION: " + std::string(e.what()));
            }
        }, reqJson).detach();
        return "{\"status\":\"started\"}";
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

    // Нативный libcurl мост для выполнения HTTP запросов в обход любых CORS / ATS ограничений
    g_webview->bind("nativeApiFetch", [](const std::string& req) -> std::string {
        try {
            json pObj = extractJsonArg(req);

            std::string url = pObj.value("url", "");
            std::string method = pObj.value("method", "GET");
            std::string body = pObj.value("body", "");

            if (url.empty()) return "{\"__curl_error\":\"Empty URL provided\"}";

            CURL* curl = curl_easy_init();
            if (!curl) return "{\"__curl_error\":\"Curl initialization failed\"}";

            std::string responseData;
            struct curl_slist* headers = NULL;

            if (pObj.contains("headers") && pObj["headers"].is_object()) {
                for (auto& [key, val] : pObj["headers"].items()) {
                    std::string h = key + ": " + val.get<std::string>();
                    headers = curl_slist_append(headers, h.c_str());
                }
            } else {
                headers = curl_slist_append(headers, "Content-Type: application/json");
            }

            curl_easy_setopt(curl, CURLOPT_URL, url.c_str());
            curl_easy_setopt(curl, CURLOPT_HTTPHEADER, headers);
            curl_easy_setopt(curl, CURLOPT_TIMEOUT, 6L);
            curl_easy_setopt(curl, CURLOPT_CONNECTTIMEOUT, 4L);
            curl_easy_setopt(curl, CURLOPT_NOSIGNAL, 1L);
            curl_easy_setopt(curl, CURLOPT_SSL_VERIFYPEER, 0L);
            curl_easy_setopt(curl, CURLOPT_SSL_VERIFYHOST, 0L);
            curl_easy_setopt(curl, CURLOPT_FOLLOWLOCATION, 1L);

            if (method == "POST") {
                curl_easy_setopt(curl, CURLOPT_POST, 1L);
                if (!body.empty()) {
                    curl_easy_setopt(curl, CURLOPT_POSTFIELDS, body.c_str());
                }
            }

            curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, +[](void* contents, size_t size, size_t nmemb, void* userp) -> size_t {
                size_t total = size * nmemb;
                static_cast<std::string*>(userp)->append(static_cast<char*>(contents), total);
                return total;
            });
            curl_easy_setopt(curl, CURLOPT_WRITEDATA, &responseData);

            CURLcode res = curl_easy_perform(curl);
            curl_slist_free_all(headers);
            curl_easy_cleanup(curl);

            if (res != CURLE_OK) {
                return "{\"__curl_error\":\"" + escapeJs(curl_easy_strerror(res)) + "\"}";
            }

            return responseData.empty() ? "{}" : responseData;
        } catch (const std::exception& e) {
            return "{\"__curl_error\":\"" + escapeJs(e.what()) + "\"}";
        }
    });

    // 1. Привязка нативного метода launchGame (C++ -> JS)
    g_webview->bind("nativeLaunchGame", [](const std::string& req) -> std::string {
        std::thread([req]() {
            try {
                json configObj = extractJsonArg(req);

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
