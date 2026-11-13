# Vesktop Rust Preview

This directory contains an experimental Rust/Tauri desktop runtime. It is kept separate from the existing Electron application so the current Vesktop build remains usable while the native port is developed.

## Run

Install Rust 1.90 or newer, then install the native WebView build dependencies for your operating system.

On Arch Linux:

\`\`\`sh
sudo pacman -S --needed webkit2gtk-4.1 base-devel curl wget file openssl \\
  appmenu-gtk-module libappindicator-gtk3 librsvg
\`\`\`

On Debian/Ubuntu:

\`\`\`sh
sudo apt install build-essential curl wget file libssl-dev libgtk-3-dev \\
  libwebkit2gtk-4.1-dev libayatana-appindicator3-dev libxdo-dev librsvg2-dev
\`\`\`

On Windows, install the Visual Studio C++ build tools and ensure the WebView2 Runtime is installed. On macOS, install the Xcode command-line tools.

From the repository root:

\`\`\`sh
cargo run --manifest-path rust-native/Cargo.toml
\`\`\`

The preview opens the official Discord web app in a native Tauri window. It stores a separate settings file in the operating system's application-data directory.

## Screen sharing and Linux audio

The Rust runtime now has a custom stream-options dialog. It lets the user choose resolution, frame rate, motion/detail preference, and (on Linux) which PipeWire application audio to include or exclude.

The actual screen or window selection is still performed by the system WebView / desktop portal. This is deliberate: Wayland capture is mediated by the compositor's xdg-desktop-portal, which owns source selection and capture permission. The app does not silently enumerate or capture windows behind the user's back.

On Linux, application/system audio is routed through Vencord's PipeWire helper, \`venmic-server\`. Build the pinned helper with the local-only listener patch:

\`\`\`sh
rust-native/scripts/build-venmic.sh
\`\`\`

Install the Arch Linux build prerequisites first:

\`\`\`sh
sudo pacman -S --needed git cmake pkgconf base-devel pipewire libpulse
\`\`\`

The build helper pins the upstream venmic source revision and patches its REST listener from \`0.0.0.0\` to \`127.0.0.1\` before compiling. This matters because the helper's \`/link\`, \`/unlink\`, and \`/unmute\` endpoints control the local audio graph and must not be exposed to other computers on the network.

The Rust runtime starts the helper on demand at \`127.0.0.1:17591\`, and stops the child process when Vesktop exits. To use a custom binary path, set \`VESKTOP_VENMIC_SERVER=/absolute/path/to/vesktop-venmic-server\`.

## What is implemented

- Rust/Tauri owns application startup and the desktop window.
- A single-instance guard focuses the existing window.
- Window sizing and the minimum dimensions are set in Rust.
- Settings are loaded and saved as JSON with an atomic file replacement.
- Discord-domain navigation stays in the app; ordinary web links are opened externally.
- A small asynchronous \`window.VesktopRust\` bridge exposes version, settings, window controls, external-link opening, and media commands.
- Display-capture permission is handled by Tauri only for the official Discord origin; actual capture is still selected through the WebView's platform capture UI.
- The custom stream-options dialog applies capture track constraints and tunes screen-share sender bitrate/frame rate without changing camera streams.
- Linux audio can select individual PipeWire sources or all eligible speaker outputs using the local \`venmic-server\` helper. The virtual mic starts muted, is attached as the outgoing stream's audio track, and is unlinked when the share ends.

## Known limitations

This is **not yet a feature-complete Vesktop replacement**. The current Electron application remains the full implementation.

- The stream-options dialog is custom, but the final screen/window chooser is the system WebView / xdg-desktop-portal picker. A portable custom thumbnail picker cannot replace the Wayland portal's source-selection flow through Tauri's public WebView API.
- The audio route helper requires PipeWire and pipewire-pulse. If it is missing or cannot enumerate sources, video sharing can still proceed without application audio.
- The old Discord-internal Webpack patches cannot be carried over directly because this Rust runtime does not yet load Vencord. The Rust bridge applies standards-based media constraints and sender bitrate/frame-rate limits instead; Discord-internal stereo experiments and receiver-specific sink scaling are not replicated.
- Windows/macOS system loopback audio, Rich Presence / arRPC, tray behavior, autostart, updater, popout windows, and existing Vesktop settings UI still need platform-specific implementations.
- The Rust app uses the system WebView: WebView2 on Windows, WebKitGTK on Linux, and WKWebView on macOS. These engines are not interchangeable with Electron's bundled Chromium.
- The Rust preview uses a different application identifier and data directory; it does not automatically reuse the Electron profile or login session.
