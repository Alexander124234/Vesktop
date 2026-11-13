# Vesktop Rust Preview

This directory contains an experimental Rust/Tauri desktop runtime. It is kept separate from the existing Electron application so the current Vesktop build remains usable while the native port is developed.

## Browser runtime

The runtime is platform-specific:

- **Windows:** Tauri's standard Wry runtime uses the installed **Microsoft Edge WebView2 Evergreen Runtime**. WebView2 embeds Edge's Chromium engine, receives browser updates through Microsoft's runtime updater, and is not bundled again inside the Vesktop installer. This is the preferred Windows path because it avoids shipping a separate ~1 GB CEF distribution.
- **Linux:** The preview retains **Chromium Embedded Framework (CEF)**. Tauri's default Linux WebKitGTK view is not a reliable Discord voice/video environment, so replacing CEF with the default Linux webview would risk bringing back Discord's unsupported-browser/call problem.
- **macOS:** Tauri's standard runtime uses WKWebView; Discord call compatibility has not been validated there.

On Windows, WebView2 does not launch the full Edge browser. It embeds the installed Edge browser engine in the Rust app. Windows 11 normally includes the Evergreen Runtime; machines without it need the WebView2 Runtime installed.

On Linux, CEF remains an alpha runtime, and the first build downloads approximately 1 GB of Chromium binaries. Its browser profile is kept in the application cache directory, and session cookies are persisted so Discord stays signed in across restarts.

## Run on Arch Linux

The Linux preview uses CEF; Windows builds use WebView2 automatically through Tauri/Wry.

Install the GTK4/X11 and build dependencies:

```sh
sudo pacman -S --needed gtk4 base-devel curl wget file openssl \
  librsvg libx11 libxcb libxkbcommon libxkbcommon-x11 mesa alsa-lib libdbus xdotool
```

Build the PipeWire audio helper once:

```sh
bash rust-native/scripts/build-venmic.sh
```

Then launch the preview from the repository root:

```sh
cargo run --manifest-path rust-native/Cargo.toml
```

The first Linux Cargo build fetches CEF (about 1 GB). Without `CEF_PATH`, the CEF crate stores the download under Cargo's build output. Set `CEF_PATH` to a persistent folder to share and reuse the download across clean builds:

```sh
mkdir -p "$HOME/.cache/tauri-cef"
CEF_PATH="$HOME/.cache/tauri-cef" cargo run --manifest-path rust-native/Cargo.toml
```

Use Rust 1.95 or newer. The existing Electron Vesktop app and its profile are not modified; the Rust preview continues to use a separate application identifier and data directory.

## Screen sharing and Linux audio

The Rust runtime has a custom stream-options dialog. It lets the user choose resolution, frame rate, motion/detail preference, and (on Linux) which PipeWire application audio to include or exclude.

The actual screen or window selection is handed to the embedded browser's display-capture picker. The permission callback returns `Default` for display capture rather than auto-granting the entire desktop.

On Linux, application/system audio is routed through Vencord's PipeWire helper, `venmic-server`. Build the pinned helper with the local-only listener patch:

```sh
bash rust-native/scripts/build-venmic.sh
```

Install the Arch Linux build prerequisites first:

```sh
sudo pacman -S --needed git cmake pkgconf base-devel pipewire pipewire-pulse libpulse
```

The build helper pins the upstream venmic source revision and patches its REST listener from `0.0.0.0` to `127.0.0.1` before compiling. This matters because the helper's `/link`, `/unlink`, and `/unmute` endpoints control the local audio graph and must not be exposed to other computers on the network.

The Rust runtime starts the helper on demand at `127.0.0.1:17591`, and stops the child process when Vesktop exits. To use a custom binary path, set `VESKTOP_VENMIC_SERVER=/absolute/path/to/vesktop-venmic-server`.

### Wayland screen-share limitation

CEF currently uses the X11 backend on Linux. The upstream CEF/WebRTC build does not enable its PipeWire desktop capturer by default, so voice/video calls should use Chromium's WebRTC stack, but **screen sharing on a Wayland desktop may still produce a blank capture**. For screen sharing, an X11 session is the reliable test target until the CEF build is patched to enable PipeWire capture. This is a separate issue from Discord's unsupported-browser block.

## What is implemented

- Windows uses Tauri/Wry with the installed Microsoft Edge WebView2 runtime; Linux uses Tauri 3 with CEF rather than WebKitGTK.
- Linux CEF keeps its genuine Chrome and platform user-agent tokens, with a Vesktop product token appended. Windows uses WebView2's Edge Chromium user agent.
- Linux CEF's helper-process entry point is enabled; Chromium renderer, GPU, network, and utility processes relaunch through the same executable. Windows delegates browser processes to the installed WebView2 runtime.
- Discord-domain navigation stays in the app; ordinary web links are opened externally.
- The custom stream-options dialog applies capture track constraints and tunes screen-share sender bitrate/frame rate without changing camera streams.
- Linux audio can select individual PipeWire sources or all eligible speaker outputs using the local `venmic-server` helper. The virtual mic starts muted, is attached as the outgoing stream's audio track, and is unlinked when the share ends.
- PipeWire routing failures fall back to video-only sharing.

## Known limitations

This is **not yet a feature-complete Vesktop replacement**. The current Electron application remains the full implementation.

- Linux CEF is an alpha runtime. Its public APIs and packaging integration may change before Tauri 3 stabilizes. Windows WebView2 uses Tauri's standard Wry backend.
- Linux CEF currently uses X11. Wayland screen sharing may need a CEF build with PipeWire desktop capture enabled.
- The old Discord-internal Webpack patches cannot be carried over directly because this Rust runtime does not yet load Vencord. The Rust bridge applies standards-based media constraints and sender bitrate/frame-rate limits instead; Discord-internal stereo experiments and receiver-specific sink scaling are not replicated.
- Windows/macOS system loopback audio, Rich Presence / arRPC, tray behavior, autostart, updater, popout windows, and existing Vesktop settings UI still need platform-specific implementations.
- The Rust preview uses a different application identifier and data directory; it does not automatically reuse the Electron profile or login session. On Windows, the WebView2 runtime is shared with other WebView2 apps but the Vesktop browser profile remains separate.
