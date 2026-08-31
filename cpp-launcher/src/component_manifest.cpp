#include "component_manifest.hpp"
#include <fstream>
#include <sstream>
#include <iostream>
#include <algorithm>

using json = nlohmann::json;

ComponentManifest::ComponentManifest() {}

bool ComponentManifest::loadFromFile(const std::string& filePath) {
    std::ifstream f(filePath);
    if (!f.is_open()) return false;
    try {
        manifestJson = json::parse(f);
        loaded = true;
        return true;
    } catch (...) {
        return false;
    }
}

bool ComponentManifest::loadFromString(const std::string& jsonString) {
    try {
        manifestJson = json::parse(jsonString);
        loaded = true;
        return true;
    } catch (...) {
        return false;
    }
}

std::string ComponentManifest::getMainClass() const {
    if (!loaded) return "";
    return manifestJson.value("mainClass", "");
}

std::string ComponentManifest::getMinecraftArguments() const {
    if (!loaded) return "";
    return manifestJson.value("minecraftArguments", "");
}

std::string ComponentManifest::getVersion() const {
    if (!loaded) return "";
    return manifestJson.value("version", "");
}

bool ComponentManifest::isRuleAllowed(const json& rulesJson, const std::string& osName, const std::string& arch) {
    if (!rulesJson.is_array() || rulesJson.empty()) return true;

    bool allow = false;
    for (const auto& rule : rulesJson) {
        std::string action = rule.value("action", "allow");
        bool matches = true;

        if (rule.contains("os")) {
            const auto& osObj = rule["os"];
            if (osObj.contains("name")) {
                std::string reqOs = osObj["name"].get<std::string>();
                if (reqOs != osName) matches = false;
            }
            if (osObj.contains("arch")) {
                std::string reqArch = osObj["arch"].get<std::string>();
                if (reqArch != arch) matches = false;
            }
        }

        if (matches) {
            allow = (action == "allow");
        }
    }
    return allow;
}

std::string ComponentManifest::mavenCoordinateToPath(const std::string& mavenCoord, 
                                                     const std::string& osName, 
                                                     const std::string& arch) {
    // group:artifact:version[:classifier][@ext]
    std::vector<std::string> parts;
    std::stringstream ss(mavenCoord);
    std::string item;
    while (std::getline(ss, item, ':')) {
        parts.push_back(item);
    }
    if (parts.size() < 3) return "";

    std::string group = parts[0];
    std::replace(group.begin(), group.end(), '.', '/');
    std::string artifact = parts[1];
    std::string version = parts[2];
    std::string classifier = "";
    std::string ext = "jar";

    if (parts.size() >= 4) {
        classifier = parts[3];
        size_t atPos = classifier.find('@');
        if (atPos != std::string::npos) {
            ext = classifier.substr(atPos + 1);
            classifier = classifier.substr(0, atPos);
        }
    }

    size_t atPos = version.find('@');
    if (atPos != std::string::npos) {
        ext = version.substr(atPos + 1);
        version = version.substr(0, atPos);
    }

    // Поддержка нативных суффиксов LWJGL для macOS ARM64 / x86_64
    if (!classifier.empty()) {
        if (classifier.find("natives") != std::string::npos) {
            if (osName == "osx") {
                if (arch == "arm64") classifier = "natives-macos-arm64";
                else classifier = "natives-macos";
            } else if (osName == "windows") {
                classifier = (arch == "arm64") ? "natives-windows-arm64" : "natives-windows";
            } else if (osName == "linux") {
                classifier = (arch == "arm64") ? "natives-linux-arm64" : "natives-linux";
            }
        }
        return group + "/" + artifact + "/" + version + "/" + artifact + "-" + version + "-" + classifier + "." + ext;
    }

    return group + "/" + artifact + "/" + version + "/" + artifact + "-" + version + "." + ext;
}

std::vector<LibraryEntry> ComponentManifest::getResolvedLibraries(const std::string& osName, 
                                                                  const std::string& arch) const {
    std::vector<LibraryEntry> result;
    if (!loaded) return result;

    auto processLibList = [&](const json& list) {
        if (!list.is_array()) return;

        for (const auto& lib : list) {
            if (lib.contains("rules")) {
                if (!isRuleAllowed(lib["rules"], osName, arch)) continue;
            }

            LibraryEntry entry;
            entry.name = lib.value("name", "");

            if (lib.contains("downloads") && lib["downloads"].contains("artifact")) {
                const auto& art = lib["downloads"]["artifact"];
                entry.url = art.value("url", "");
                entry.sha1 = art.value("sha1", "");
                entry.size = art.value("size", 0);
                entry.path = art.value("path", "");
            }

            if (entry.path.empty() && !entry.name.empty()) {
                entry.path = mavenCoordinateToPath(entry.name, osName, arch);
            }

            if (entry.url.empty() && !entry.path.empty()) {
                // Если URL пустой, собираем fallback Maven ссылки
                if (entry.name.find("net.neoforged") != std::string::npos || entry.name.find("cpw.mods") != std::string::npos) {
                    entry.url = "https://maven.neoforged.net/releases/" + entry.path;
                } else if (entry.name.find("org.lwjgl") != std::string::npos) {
                    entry.url = "https://libraries.minecraft.net/" + entry.path;
                } else {
                    entry.url = "https://libraries.minecraft.net/" + entry.path;
                }
            }

            // Определение флагов модулей Java 21 / NeoForge (JPMS)
            std::string nameLower = entry.name;
            std::transform(nameLower.begin(), nameLower.end(), nameLower.begin(), ::tolower);
            if (nameLower.find("cpw.mods:bootstraplauncher") != std::string::npos ||
                nameLower.find("cpw.mods:securejarhandler") != std::string::npos ||
                nameLower.find("org.ow2.asm") != std::string::npos ||
                nameLower.find("net.neoforged:jarjarfilesystem") != std::string::npos) {
                entry.isModule = true;
            }

            if (entry.path.find("natives") != std::string::npos) {
                entry.isNative = true;
            }

            if (!entry.path.empty()) {
                result.push_back(entry);
            }
        }
    };

    // Для запуска игры используются только runtime libraries
    if (manifestJson.contains("libraries")) {
        processLibList(manifestJson["libraries"]);
    }

    return result;
}
