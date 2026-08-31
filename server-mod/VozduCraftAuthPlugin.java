package ru.vozducraft.auth;

import java.io.OutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/**
 * VozduCraft Minecraft Server Verification Plugin / Mod
 * Проверяет авторизацию сессий и HWID игроков при входе на сервер.
 */
public class VozduCraftAuthPlugin {

    private static final String BACKEND_URL = "http://185.221.213.43:3000/api/v1/auth/verify-session";

    /**
     * Вызывается при подключении игрока к Minecraft-серверу.
     * @param username Никнейм игрока
     * @param accessToken Одноразовый сессионный токен из лаунчера
     * @param hwid Анонимный цифровой отпечаток ПК
     * @return VerificationResult (разрешен ли вход и причина)
     */
    public static VerificationResult verifyPlayer(String username, String accessToken, String hwid) {
        try {
            URL url = new URL(BACKEND_URL);
            HttpURLConnection conn = (HttpURLConnection) url.openConnection();
            conn.setRequestMethod("POST");
            conn.setRequestProperty("Content-Type", "application/json");
            conn.setDoOutput(true);
            conn.setConnectTimeout(5000);
            conn.setReadTimeout(5000);

            String jsonInput = String.format(
                "{\"username\":\"%s\", \"accessToken\":\"%s\", \"hwid\":\"%s\"}",
                username, accessToken, hwid
            );

            try (OutputStream os = conn.getOutputStream()) {
                byte[] input = jsonInput.getBytes(StandardCharsets.UTF_8);
                os.write(input, 0, input.length);
            }

            int responseCode = conn.getResponseCode();
            if (responseCode == 200) {
                try (InputStream is = conn.getInputStream()) {
                    String responseStr = new String(is.readAllBytes(), StandardCharsets.UTF_8);
                    if (responseStr.contains("\"valid\":true")) {
                        boolean isAdminBypass = responseStr.contains("\"isAdminBypass\":true");
                        return new VerificationResult(true, "OK", isAdminBypass);
                    }
                }
            } else if (responseCode == 403) {
                return new VerificationResult(false, "Ваш компьютер (HWID) заблокирован на сервере VozduCraft.", false);
            }

            return new VerificationResult(false, "Пожалуйста, заходите на сервер через официальный лаунчер VozduCraft!", false);

        } catch (Exception e) {
            e.printStackTrace();
            return new VerificationResult(false, "Ошибка верификации бэкенда. Попробуйте позже.", false);
        }
    }

    public static class VerificationResult {
        public final boolean allowed;
        public final String reason;
        public final boolean isAdminBypass;

        public VerificationResult(boolean allowed, String reason, boolean isAdminBypass) {
            this.allowed = allowed;
            this.reason = reason;
            this.isAdminBypass = isAdminBypass;
        }
    }
}
