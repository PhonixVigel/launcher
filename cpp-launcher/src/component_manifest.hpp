#ifndef COMPONENT_MANIFEST_HPP
#define COMPONENT_MANIFEST_HPP

#include <string>
#include <vector>
#include "../include/json.hpp"

struct LibraryEntry {
    std::string name;
    std::string path;
    std::string url;
    std::string sha1;
    int64_t size = 0;
    bool isNative = false;
    bool isModule = false; // Для --module-path
};

class ComponentManifest {
public:
    ComponentManifest();

    // Загрузка манифеста из JSON файла или строки
    bool loadFromFile(const std::string& filePath);
    bool loadFromString(const std::string& jsonString);

    // Получение списка библиотек с фильтрацией под текущую ОС и архитектуру
    std::vector<LibraryEntry> getResolvedLibraries(const std::string& osName = "osx", 
                                                  const std::string& arch = "arm64") const;

    // Главный класс и аргументы
    std::string getMainClass() const;
    std::string getMinecraftArguments() const;
    std::string getVersion() const;

    // Преобразование Maven координат (group:artifact:version:classifier) в относительный путь
    static std::string mavenCoordinateToPath(const std::string& mavenCoord, 
                                             const std::string& osName = "osx", 
                                             const std::string& arch = "arm64");

    static bool isRuleAllowed(const nlohmann::json& rulesJson, 
                              const std::string& osName = "osx", 
                              const std::string& arch = "arm64");

private:
    nlohmann::json manifestJson;
    bool loaded = false;
};

#endif // COMPONENT_MANIFEST_HPP
