/*
 * Vesktop Rust Preview
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Keep this bridge small. Only the official Discord web application receives it.
 * The native side validates all values before touching local resources.
 */
(() => {
    if (window.top !== window) return;

    const host = window.location.hostname.toLowerCase();
    const isDiscordHost =
        host === "discord.com" ||
        host.endsWith(".discord.com") ||
        host === "discordapp.com" ||
        host.endsWith(".discordapp.com");

    if (!isDiscordHost) return;

    const tauri = window.__TAURI__;
    const invoke = tauri?.core?.invoke?.bind(tauri.core);
    if (typeof invoke !== "function") {
        console.error("[Vesktop Rust] Tauri IPC bridge is unavailable.");
        return;
    }

    const api = Object.freeze({
        getVersion: () => invoke("get_version"),
        getSettings: () => invoke("get_settings"),
        saveSettings: settings => invoke("save_settings", { settings }),
        minimize: () => invoke("minimize_window"),
        toggleMaximize: () => invoke("toggle_maximize_window"),
        close: () => invoke("close_window"),
        focus: () => invoke("focus_window"),
        openExternal: url => invoke("open_external_url", { url })
    });

    Object.defineProperty(window, "VesktopRust", {
        configurable: false,
        enumerable: false,
        writable: false,
        value: api
    });

    // Prevent Discord page code from depending directly on the full Tauri JS API.
    // The captured invoke function remains available only through the narrow bridge above.
    try {
        delete window.__TAURI__;
    } catch {
        // Some WebView implementations expose a non-configurable global.
    }
})();
