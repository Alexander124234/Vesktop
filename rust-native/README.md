# Vesktop Rust Preview

This directory contains an experimental Rust/Tauri desktop runtime. It is kept separate from the existing Electron application so the current Vesktop build remains usable while the native port is developed.

## Run

Install Rust 1.90 or newer, then install the native WebView build dependencies for your operating system.

On Debian/Ubuntu:

```sh
sudo apt install build-essential curl wget file libssl-dev libgtk-3-dev \
  libwebkit2gtk-4.1-dev librsvg2-dev
```

On Windows, install the Visual Studio C++ build tools and ensure the WebView2 Runtime is installed. On macOS, install the Xcode command-line tools.

From the repository root:

```sh
cargo run --manifest-path rust-native/Cargo.toml
```

The preview opens the official Discord web app in a native Tauri window. It stores a separate settings file in the operating system's application-data directory.

## What is implemented

- Rust/Tauri owns application startup and the desktop window.
- A single-instance guard focuses the existing window.
- Window sizing and the minimum dimensions are set in Rust.
- Settings are loaded and saved as JSON with an atomic file replacement.
- Discord-domain navigation stays in the app; ordinary web links are opened externally.
- A small asynchronous `window.VesktopRust` bridge exposes version, settings, window controls, and external-link opening.

## What is not ported yet

This is **not yet a feature-complete Vesktop replacement**. The current Electron application remains the full implementation.

- Vencord's desktop preload/renderer injection and the existing Vesktop React settings UI are not wired into this runtime.
- The custom screen-share picker, Linux virtual microphone / system-audio path, and the Electron-specific WebRTC patches are not ported.
- Discord Rich Presence / arRPC, tray behavior, autostart, updater, popout windows, and the existing command-line options still need Rust implementations.
- The Rust app uses the system WebView: WebView2 on Windows, WebKitGTK on Linux, and WKWebView on macOS. These engines are not interchangeable with Electron's bundled Chromium. In particular, Linux screen-sharing and media behavior must be validated before this can replace the current app.
- The Rust preview uses a different application identifier and data directory; it does not automatically reuse the Electron profile or login session.

The next migration milestone is to port the Vencord preload contract and Discord media-capture pipeline, then add platform-specific integration tests before making this runtime the default.
