#ifndef DOWNLOADER_HPP
#define DOWNLOADER_HPP

#include <string>
#include <vector>
#include <functional>
#include <cstdint>

struct DownloadTask {
    std::string url;
    std::string destPath;
    std::string expectedSha1;
    std::string expectedSha256;
    int64_t sizeBytes = 0;
};

class Downloader {
public:
    Downloader();
    ~Downloader();

    // Прямое скачивание одного файла с поддержкой редиректов и прогресса
    bool downloadFile(const std::string& url, 
                      const std::string& destPath, 
                      std::function<void(int64_t current, int64_t total)> progressCallback = nullptr);

    // Скачивание ответа в строку (для API запросов)
    std::string downloadToString(const std::string& url, const std::vector<std::string>& headers = {});

    // Отправка POST JSON запроса (для телеметрии и краш-репортов)
    std::string postJson(const std::string& url, const std::string& jsonBody, const std::vector<std::string>& headers = {});

    // Получение прямой ссылки на скачивание с Яндекс.Диска
    std::string resolveYandexDiskUrl(const std::string& publicUrl);

    // Получение прямой ссылки на скачивание с Google Drive
    std::string resolveGoogleDriveUrl(const std::string& shareUrlOrId);

    // Поиск и получение прямой ссылки на мод с Modrinth API
    std::string resolveModrinthModUrl(const std::string& projectId, 
                                      const std::string& gameVersion = "1.21.1", 
                                      const std::string& loader = "neoforge");

    // Пакетное параллельное скачивание списка файлов
    bool downloadBatch(const std::vector<DownloadTask>& tasks,
                       int maxConcurrency,
                       std::function<void(size_t completed, size_t total, const std::string& currentFile)> batchProgressCallback);

    // Проверка контрольных сумм файлов
    static bool verifySha1(const std::string& filePath, const std::string& expectedSha1);
    static bool verifySha256(const std::string& filePath, const std::string& expectedSha256);
    static std::string calculateSha1(const std::string& filePath);
    static std::string calculateSha256(const std::string& filePath);

    // Извлечение архивов
    static bool extractZip(const std::string& zipPath, const std::string& destDir);

private:
    static size_t writeDataCallback(void* ptr, size_t size, size_t nmemb, void* stream);
    static size_t writeStringCallback(void* contents, size_t size, size_t nmemb, void* userp);
};

#endif // DOWNLOADER_HPP
