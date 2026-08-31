CXX = clang++
CXXFLAGS = -std=c++17 -x objective-c++ -O2 -Iinclude -Isrc -Wall
LDFLAGS = -framework WebKit -framework Cocoa -lcurl -pthread

SRCS = src/main.cpp src/downloader.cpp src/component_manifest.cpp src/launcher_engine.cpp
OBJS = $(SRCS:.cpp=.o)
TARGET = build/VozduCraft-Launcher
APP_BUNDLE = build/VozduCraft.app

all: $(TARGET) app

$(TARGET): $(OBJS)
	@mkdir -p build
	$(CXX) $(OBJS) $(LDFLAGS) -o $(TARGET)
	@echo "Build successful: $(TARGET)"

%.o: %.cpp
	$(CXX) $(CXXFLAGS) -c $< -o $@

app: $(TARGET)
	@mkdir -p $(APP_BUNDLE)/Contents/MacOS
	@mkdir -p $(APP_BUNDLE)/Contents/Resources/ui
	@mkdir -p $(APP_BUNDLE)/Contents/Resources/meta
	@cp $(TARGET) $(APP_BUNDLE)/Contents/MacOS/VozduCraft-Launcher
	@cp -R ../player-launcher/*.html ../player-launcher/*.css ../player-launcher/*.js $(APP_BUNDLE)/Contents/Resources/ui/ 2>/dev/null || true
	@cp -R ../player-launcher/meta/* $(APP_BUNDLE)/Contents/Resources/meta/ 2>/dev/null || true
	@echo '<?xml version="1.0" encoding="UTF-8"?>' > $(APP_BUNDLE)/Contents/Info.plist
	@echo '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">' >> $(APP_BUNDLE)/Contents/Info.plist
	@echo '<plist version="1.0"><dict>' >> $(APP_BUNDLE)/Contents/Info.plist
	@echo '  <key>CFBundleExecutable</key><string>VozduCraft-Launcher</string>' >> $(APP_BUNDLE)/Contents/Info.plist
	@echo '  <key>CFBundleIdentifier</key><string>ru.vozducraft.launcher</string>' >> $(APP_BUNDLE)/Contents/Info.plist
	@echo '  <key>CFBundleName</key><string>VozduCraft Launcher</string>' >> $(APP_BUNDLE)/Contents/Info.plist
	@echo '  <key>CFBundlePackageType</key><string>APPL</string>' >> $(APP_BUNDLE)/Contents/Info.plist
	@echo '  <key>CFBundleShortVersionString</key><string>2.0.0</string>' >> $(APP_BUNDLE)/Contents/Info.plist
	@echo '  <key>NSHighResolutionCapable</key><true/>' >> $(APP_BUNDLE)/Contents/Info.plist
	@echo '</dict></plist>' >> $(APP_BUNDLE)/Contents/Info.plist
	@chmod +x $(APP_BUNDLE)/Contents/MacOS/VozduCraft-Launcher
	@echo "macOS App Bundle successfully built with UI resources: $(APP_BUNDLE)"

clean:
	rm -rf src/*.o build

.PHONY: all clean app
