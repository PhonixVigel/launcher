#include "downloader.hpp"
#include "../include/json.hpp"
#include <curl/curl.h>
#include <CommonCrypto/CommonDigest.h>
#include <iostream>
#include <fstream>
#include <sstream>
#include <iomanip>
#include <thread>
#include <mutex>
#include <queue>
#include <future>
#include <filesystem>
#include <regex>

namespace fs = std::filesystem;
using json = nlohmann::json;

Downloader::Downloader() {
    curl_global_init(CURL_GLOBAL_ALL);
}

Downloader::~Downloader() {
    curl_global_cleanup();
}

size_t Downloader::writeDataCallback(void* ptr, size_t size, size_t nmemb, void* stream) {
    std::ofstream* file = static_cast<std::ofstream*>(stream);
    file->write(static_cast<const char*>(ptr), size * nmemb);
    return size * nmemb;
}

size_t Downloader::writeStringCallback(void* contents, size_t size, size_t nmemb, void* userp) {
    size_t totalSize = size * nmemb;
    std::string* str = static_cast<std::string*>(userp);
    str->append(static_cast<char*>(contents), totalSize);
    return totalSize;
}

struct ProgressPayload {
    std::function<void(int64_t current, int64_t total)> callback;
};

static int curlXferInfoCallback(void* clientp, curl_off_t dltotal, curl_off_t dlnow, curl_off_t ultotal, curl_off_t ulnow) {
    if (!clientp) return 0;
    ProgressPayload* payload = static_cast<ProgressPayload*>(clientp);
    if (payload->callback && dltotal > 0) {
        payload->callback(static_cast<int64_t>(dlnow), static_cast<int64_t>(dltotal));
    }
    return 0;
}

bool Downloader::downloadFile(const std::string& url, 
                              const std::string& destPath, 
                              std::function<void(int64_t current, int64_t total)> progressCallback) {
    if (url.empty()) return false;

    // Создаем директорию назначения если не существует
    fs::path p(destPath);
    if (p.has_parent_path()) {
        fs::create_directories(p.parent_path());
    }

    std::string tempPath = destPath + ".tmp";
    std::ofstream outFile(tempPath, std::ios::binary);
    if (!outFile.is_open()) {
        std::cerr << "[Downloader] Failed to open file for writing: " << tempPath << std::endl;
        return false;
    }

    CURL* curl = curl_easy_init();
    if (!curl) {
        outFile.close();
        return false;
    }

    ProgressPayload payload{ progressCallback };

    curl_easy_setopt(curl, CURLOPT_URL, url.c_str());
    curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, writeDataCallback);
    curl_easy_setopt(curl, CURLOPT_WRITEDATA, &outFile);
    curl_easy_setopt(curl, CURLOPT_FOLLOWLOCATION, 1L);
    curl_easy_setopt(curl, CURLOPT_AUTOREFERER, 1L);
    curl_easy_setopt(curl, CURLOPT_MAXREDIRS, 10L);
    curl_easy_setopt(curl, CURLOPT_USERAGENT, "VozduCraft-Launcher/1.0 (PrismEngine-CPP)");
    curl_easy_setopt(curl, CURLOPT_CONNECTTIMEOUT, 15L);
    curl_easy_setopt(curl, CURLOPT_TIMEOUT, 300L);
    curl_easy_setopt(curl, CURLOPT_SSL_VERIFYPEER, 0L);
    curl_easy_setopt(curl, CURLOPT_SSL_VERIFYHOST, 0L);

    if (progressCallback) {
        curl_easy_setopt(curl, CURLOPT_NOPROGRESS, 0L);
        curl_easy_setopt(curl, CURLOPT_XFERINFOFUNCTION, curlXferInfoCallback);
        curl_easy_setopt(curl, CURLOPT_XFERINFODATA, &payload);
    } else {
        curl_easy_setopt(curl, CURLOPT_NOPROGRESS, 1L);
    }

    CURLcode res = curl_easy_perform(curl);
    long httpCode = 0;
    curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &httpCode);
    curl_easy_cleanup(curl);
    outFile.close();

    if (res == CURLE_OK && httpCode >= 200 && httpCode < 400) {
        // Переименовываем временный файл в итоговый
        std::error_code ec;
        fs::rename(tempPath, destPath, ec);
        if (ec) {
            fs::copy_file(tempPath, destPath, fs::copy_options::overwrite_existing, ec);
            fs::remove(tempPath, ec);
        }
        return true;
    } else {
        std::cerr << "[Downloader] Download error (" << url << "): " 
                  << curl_easy_strerror(res) << " HTTP status: " << httpCode << std::endl;
        fs::remove(tempPath);
        return false;
    }
}

std::string Downloader::downloadToString(const std::string& url, const std::vector<std::string>& headers) {
    CURL* curl = curl_easy_init();
    if (!curl) return "";

    std::string responseString;
    struct curl_slist* chunk = nullptr;
    for (const auto& h : headers) {
        chunk = curl_slist_append(chunk, h.c_str());
    }

    curl_easy_setopt(curl, CURLOPT_URL, url.c_str());
    curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, writeStringCallback);
    curl_easy_setopt(curl, CURLOPT_WRITEDATA, &responseString);
    curl_easy_setopt(curl, CURLOPT_HTTPHEADER, chunk);
    curl_easy_setopt(curl, CURLOPT_FOLLOWLOCATION, 1L);
    curl_easy_setopt(curl, CURLOPT_USERAGENT, "VozduCraft-Launcher/1.0 (PrismEngine-CPP)");
    curl_easy_setopt(curl, CURLOPT_TIMEOUT, 15L);
    curl_easy_setopt(curl, CURLOPT_SSL_VERIFYPEER, 0L);
    curl_easy_setopt(curl, CURLOPT_SSL_VERIFYHOST, 0L);

    CURLcode res = curl_easy_perform(curl);
    if (chunk) curl_slist_free_all(chunk);
    curl_easy_cleanup(curl);

    if (res == CURLE_OK) {
        return responseString;
    }
    return "";
}

std::string Downloader::postJson(const std::string& url, const std::string& jsonBody, const std::vector<std::string>& headers) {
    CURL* curl = curl_easy_init();
    if (!curl) return "";

    std::string responseString;
    struct curl_slist* chunk = nullptr;
    chunk = curl_slist_append(chunk, "Content-Type: application/json");
    for (const auto& h : headers) {
        chunk = curl_slist_append(chunk, h.c_str());
    }

    curl_easy_setopt(curl, CURLOPT_URL, url.c_str());
    curl_easy_setopt(curl, CURLOPT_POST, 1L);
    curl_easy_setopt(curl, CURLOPT_POSTFIELDS, jsonBody.c_str());
    curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, writeStringCallback);
    curl_easy_setopt(curl, CURLOPT_WRITEDATA, &responseString);
    curl_easy_setopt(curl, CURLOPT_HTTPHEADER, chunk);
    curl_easy_setopt(curl, CURLOPT_FOLLOWLOCATION, 1L);
    curl_easy_setopt(curl, CURLOPT_USERAGENT, "VozduCraft-Launcher/1.0 (PrismEngine-CPP)");
    curl_easy_setopt(curl, CURLOPT_TIMEOUT, 15L);
    curl_easy_setopt(curl, CURLOPT_SSL_VERIFYPEER, 0L);
    curl_easy_setopt(curl, CURLOPT_SSL_VERIFYHOST, 0L);

    CURLcode res = curl_easy_perform(curl);
    if (chunk) curl_slist_free_all(chunk);
    curl_easy_cleanup(curl);

    if (res == CURLE_OK) {
        return responseString;
    }
    return "";
}

std::string Downloader::resolveYandexDiskUrl(const std::string& publicUrl) {
    // API Яндекс.Диска: https://cloud-api.yandex.net/v1/disk/public/resources/download?public_key=...
    CURL* curl = curl_easy_init();
    char* encodedUrl = curl_easy_escape(curl, publicUrl.c_str(), static_cast<int>(publicUrl.length()));
    std::string apiUrl = "https://cloud-api.yandex.net/v1/disk/public/resources/download?public_key=" + std::string(encodedUrl);
    curl_free(encodedUrl);
    curl_easy_cleanup(curl);

    std::string jsonResponse = downloadToString(apiUrl);
    if (jsonResponse.empty()) return "";

    try {
        auto parsed = json::parse(jsonResponse);
        if (parsed.contains("href") && parsed["href"].is_string()) {
            return parsed["href"].get<std::string>();
        }
    } catch (const std::exception& e) {
        std::cerr << "[Downloader] Yandex Disk parse error: " << e.what() << std::endl;
    }
    return "";
}

std::string Downloader::resolveGoogleDriveUrl(const std::string& shareUrlOrId) {
    std::string fileId = shareUrlOrId;
    std::regex idRegex(R"((?:/d/|id=)([a-zA-Z0-9_-]{25,}))");
    std::smatch match;
    if (std::regex_search(shareUrlOrId, match, idRegex) && match.size() > 1) {
        fileId = match[1].str();
    }
    // Прямой экспортный endpoint Google Drive
    return "https://drive.google.com/uc?export=download&id=" + fileId + "&confirm=t";
}

std::string Downloader::resolveModrinthModUrl(const std::string& projectId, 
                                              const std::string& gameVersion, 
                                              const std::string& loader) {
    std::string url = "https://api.modrinth.com/v2/project/" + projectId + 
                      "/version?loaders=%5B%22" + loader + "%22%5D&game_versions=%5B%22" + gameVersion + "%22%5D";
    
    std::string resp = downloadToString(url);
    if (resp.empty()) return "";

    try {
        auto versions = json::parse(resp);
        if (versions.is_array() && !versions.empty()) {
            auto firstVer = versions[0];
            if (firstVer.contains("files") && firstVer["files"].is_array() && !firstVer["files"].empty()) {
                for (const auto& f : firstVer["files"]) {
                    if (f.value("primary", false) || firstVer["files"].size() == 1) {
                        return f.value("url", "");
                    }
                }
                return firstVer["files"][0].value("url", "");
            }
        }
    } catch (...) {}
    return "";
}

bool Downloader::downloadBatch(const std::vector<DownloadTask>& tasks,
                               int maxConcurrency,
                               std::function<void(size_t completed, size_t total, const std::string& currentFile)> batchProgressCallback) {
    if (tasks.empty()) return true;

    std::atomic<size_t> completedCount{0};
    std::atomic<bool> allSuccess{true};
    size_t totalTasks = tasks.size();

    std::queue<DownloadTask> taskQueue;
    for (const auto& t : tasks) {
        taskQueue.push(t);
    }
    std::mutex queueMutex;

    int threadCount = std::min(static_cast<int>(tasks.size()), std::max(1, maxConcurrency));
    std::vector<std::thread> workers;

    for (int i = 0; i < threadCount; ++i) {
        workers.emplace_back([&]() {
            Downloader localDownloader;
            while (true) {
                DownloadTask currentTask;
                {
                    std::lock_guard<std::mutex> lock(queueMutex);
                    if (taskQueue.empty()) break;
                    currentTask = taskQueue.front();
                    taskQueue.pop();
                }

                // Проверка существующего файла и хэша
                if (fs::exists(currentTask.destPath)) {
                    bool valid = true;
                    if (!currentTask.expectedSha1.empty()) {
                        valid = verifySha1(currentTask.destPath, currentTask.expectedSha1);
                    } else if (!currentTask.expectedSha256.empty()) {
                        valid = verifySha256(currentTask.destPath, currentTask.expectedSha256);
                    } else if (fs::file_size(currentTask.destPath) < 100) {
                        valid = false;
                    }
                    if (valid) {
                        size_t c = ++completedCount;
                        if (batchProgressCallback) {
                            batchProgressCallback(c, totalTasks, fs::path(currentTask.destPath).filename().string());
                        }
                        continue;
                    }
                }

                // Скачивание с 3 попытками при сбое
                bool downloaded = false;
                for (int attempt = 0; attempt < 3 && !downloaded; ++attempt) {
                    if (localDownloader.downloadFile(currentTask.url, currentTask.destPath, nullptr)) {
                        downloaded = true;
                    } else {
                        std::this_thread::sleep_for(std::chrono::milliseconds(500));
                    }
                }

                if (!downloaded) {
                    std::cerr << "[Downloader] Failed to download after 3 attempts: " << currentTask.url << std::endl;
                    allSuccess = false;
                }

                size_t c = ++completedCount;
                if (batchProgressCallback) {
                    batchProgressCallback(c, totalTasks, fs::path(currentTask.destPath).filename().string());
                }
            }
        });
    }

    for (auto& w : workers) {
        if (w.joinable()) w.join();
    }

    return allSuccess;
}

std::string Downloader::calculateSha1(const std::string& filePath) {
    std::ifstream file(filePath, std::ios::binary);
    if (!file.is_open()) return "";

    CC_SHA1_CTX ctx;
    CC_SHA1_Init(&ctx);

    char buffer[16384];
    while (file.read(buffer, sizeof(buffer))) {
        CC_SHA1_Update(&ctx, buffer, static_cast<CC_LONG>(file.gcount()));
    }
    if (file.gcount() > 0) {
        CC_SHA1_Update(&ctx, buffer, static_cast<CC_LONG>(file.gcount()));
    }

    unsigned char digest[CC_SHA1_DIGEST_LENGTH];
    CC_SHA1_Final(digest, &ctx);

    std::ostringstream result;
    for (int i = 0; i < CC_SHA1_DIGEST_LENGTH; ++i) {
        result << std::hex << std::setw(2) << std::setfill('0') << static_cast<int>(digest[i]);
    }
    return result.str();
}

std::string Downloader::calculateSha256(const std::string& filePath) {
    std::ifstream file(filePath, std::ios::binary);
    if (!file.is_open()) return "";

    CC_SHA256_CTX ctx;
    CC_SHA256_Init(&ctx);

    char buffer[16384];
    while (file.read(buffer, sizeof(buffer))) {
        CC_SHA256_Update(&ctx, buffer, static_cast<CC_LONG>(file.gcount()));
    }
    if (file.gcount() > 0) {
        CC_SHA256_Update(&ctx, buffer, static_cast<CC_LONG>(file.gcount()));
    }

    unsigned char digest[CC_SHA256_DIGEST_LENGTH];
    CC_SHA256_Final(digest, &ctx);

    std::ostringstream result;
    for (int i = 0; i < CC_SHA256_DIGEST_LENGTH; ++i) {
        result << std::hex << std::setw(2) << std::setfill('0') << static_cast<int>(digest[i]);
    }
    return result.str();
}

bool Downloader::verifySha1(const std::string& filePath, const std::string& expectedSha1) {
    if (expectedSha1.empty()) return true;
    std::string actual = calculateSha1(filePath);
    return strcasecmp(actual.c_str(), expectedSha1.c_str()) == 0;
}

bool Downloader::verifySha256(const std::string& filePath, const std::string& expectedSha256) {
    if (expectedSha256.empty()) return true;
    std::string actual = calculateSha256(filePath);
    return strcasecmp(actual.c_str(), expectedSha256.c_str()) == 0;
}

bool Downloader::extractZip(const std::string& zipPath, const std::string& destDir) {
    fs::create_directories(destDir);
    std::string cmd = "/usr/bin/unzip -o -q \"" + zipPath + "\" -d \"" + destDir + "\"";
    return system(cmd.c_str()) == 0;
}
