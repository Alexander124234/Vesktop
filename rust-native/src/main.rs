/*
 * Vesktop Rust Preview
 * Copyright (c) 2026 Vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

mod media;

use std::{fs, io::Write, path::PathBuf};

use media::{AudioLinkRequest, VenmicRuntime};
use serde_json::{Value, json};
use tauri::{
    AppHandle, Manager, WebviewUrl, WebviewWindow,
    webview::{PermissionKind, PermissionResponse, WebviewWindowBuilder},
};
use tauri_plugin_opener::OpenerExt;
use tauri_runtime_cef::Cef;
use url::Url;

const DISCORD_APP_URL: &str = "https://discord.com/app";
const MAX_SETTINGS_BYTES: usize = 1024 * 1024;
const INIT_BRIDGE: &str = include_str!("../assets/bridge.js");

fn settings_file(app: &AppHandle) -> Result<PathBuf, String> {
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Could not resolve Vesktop data directory: {error}"))?;

    Ok(directory.join("settings.json"))
}

fn default_settings() -> Value {
    json!({
        "discordBranch": "stable",
        "hardwareAcceleration": true,
        "hardwareVideoAcceleration": false,
        "hardwareVideoEncoding": false,
        "nativeTitleBar": false,
        "staticTitle": false,
        "enableMenu": false,
        "enableShadow": true,
        "enableRoundedCorners": true,
        "tray": true,
        "minimizeToTray": true,
        "disableMinSize": false,
        "disableSmoothScroll": false,
        "appBadge": true,
        "openLinksWithElectron": false,
        "webRTCIPHandlingPolicy": "default"
    })
}

#[tauri::command]
fn get_version() -> String {
    env!("CARGO_PKG_VERSION").to_owned()
}

#[tauri::command]
fn get_settings(app: AppHandle) -> Result<Value, String> {
    let path = settings_file(&app)?;

    match fs::read_to_string(&path) {
        Ok(contents) => {
            let value: Value = serde_json::from_str(&contents)
                .map_err(|error| format!("Settings file is invalid JSON: {error}"))?;

            if !value.is_object() {
                return Err("Settings file must contain a JSON object.".to_owned());
            }

            Ok(value)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(default_settings()),
        Err(error) => Err(format!("Could not read settings: {error}")),
    }
}

#[tauri::command]
fn save_settings(app: AppHandle, settings: Value) -> Result<(), String> {
    if !settings.is_object() {
        return Err("Settings must be a JSON object.".to_owned());
    }

    let contents = serde_json::to_vec_pretty(&settings)
        .map_err(|error| format!("Could not encode settings: {error}"))?;

    if contents.len() > MAX_SETTINGS_BYTES {
        return Err("Settings exceed the 1 MiB safety limit.".to_owned());
    }

    let path = settings_file(&app)?;
    let parent = path
        .parent()
        .ok_or_else(|| "Settings path has no parent directory.".to_owned())?;

    fs::create_dir_all(parent)
        .map_err(|error| format!("Could not create settings directory: {error}"))?;

    let mut temporary = tempfile::NamedTempFile::new_in(parent)
        .map_err(|error| format!("Could not create temporary settings file: {error}"))?;

    temporary
        .write_all(&contents)
        .map_err(|error| format!("Could not write settings: {error}"))?;

    temporary
        .persist(&path)
        .map_err(|error| format!("Could not replace settings file: {}", error.error))?;

    Ok(())
}

#[tauri::command]
fn minimize_window(window: WebviewWindow) -> Result<(), String> {
    window.minimize().map_err(|error| error.to_string())
}

#[tauri::command]
fn toggle_maximize_window(window: WebviewWindow) -> Result<(), String> {
    if window.is_maximized().map_err(|error| error.to_string())? {
        window.unmaximize().map_err(|error| error.to_string())
    } else {
        window.maximize().map_err(|error| error.to_string())
    }
}

#[tauri::command]
fn close_window(window: WebviewWindow) -> Result<(), String> {
    window.close().map_err(|error| error.to_string())
}

#[tauri::command]
fn focus_window(window: WebviewWindow) -> Result<(), String> {
    window.set_focus().map_err(|error| error.to_string())
}

#[tauri::command]
fn open_external_url(app: AppHandle, url: String) -> Result<(), String> {
    let parsed = Url::parse(&url).map_err(|error| format!("Invalid URL: {error}"))?;

    if !matches!(parsed.scheme(), "https" | "http" | "mailto") {
        return Err("Only HTTP, HTTPS, and mailto links can be opened externally.".to_owned());
    }

    app.opener()
        .open_url(parsed.as_str(), None::<&str>)
        .map_err(|error| format!("Could not open external link: {error}"))
}

#[tauri::command]
async fn media_list_audio_sources(
    app: AppHandle,
    granular: Option<bool>,
) -> Result<media::AudioSourcesResponse, String> {
    media::list_audio_sources(app, granular.unwrap_or(false)).await
}

#[tauri::command]
async fn media_start_audio_routing(
    app: AppHandle,
    request: AudioLinkRequest,
) -> Result<(), String> {
    media::start_audio_routing(app, request).await
}

#[tauri::command]
async fn media_unmute_audio_routing(app: AppHandle) -> Result<(), String> {
    media::unmute_audio_routing(app).await
}

#[tauri::command]
async fn media_stop_audio_routing(app: AppHandle) -> Result<(), String> {
    media::stop_audio_routing(app).await
}

fn is_discord_navigation(url: &Url) -> bool {
    if url.scheme() != "https" {
        return false;
    }

    let Some(host) = url.host_str() else {
        return false;
    };

    let host = host.to_ascii_lowercase();
    host == "discord.com"
        || host.ends_with(".discord.com")
        || host == "discordapp.com"
        || host.ends_with(".discordapp.com")
}

#[tauri_runtime_cef::cef_entry_point]
fn main() {
    let cef_runtime = Cef::default()
        // Keep Chromium's real Chrome/platform UA tokens and add Vesktop's product
        // token. Replacing the whole UA would make browser feature detection fail.
        .user_agent_product(format!("Vesktop/{}", env!("CARGO_PKG_VERSION")))
        // Discord should remain signed in when the app is restarted.
        .persist_session_cookies(true);

    let app = tauri::Builder::default()
        .runtime(cef_runtime)
        .manage(VenmicRuntime::default())
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .on_permission_request(|webview, kind| {
            let is_trusted_discord = webview
                .url()
                .ok()
                .is_some_and(|url| is_discord_navigation(&url));

            match (kind, is_trusted_discord) {
                // CEF's DisplayCapture Allow response can grant the entire
                // desktop without showing the source picker. Default hands
                // the request back to Chromium's own picker.
                (PermissionKind::DisplayCapture, true) => PermissionResponse::Default,
                // Camera and microphone use Chromium's origin permission UI.
                (PermissionKind::Camera | PermissionKind::Microphone, true) => {
                    PermissionResponse::Default
                }
                // Do not grant capture permission to any other embedded site.
                (
                    PermissionKind::DisplayCapture
                    | PermissionKind::Camera
                    | PermissionKind::Microphone,
                    false,
                ) => PermissionResponse::Deny,
                _ => PermissionResponse::Default,
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_version,
            get_settings,
            save_settings,
            minimize_window,
            toggle_maximize_window,
            close_window,
            focus_window,
            open_external_url,
            media_list_audio_sources,
            media_start_audio_routing,
            media_unmute_audio_routing,
            media_stop_audio_routing
        ])
        .setup(|app| {
            let opener_handle = app.handle().clone();
            let discord_url = Url::parse(DISCORD_APP_URL)?;

            WebviewWindowBuilder::new(app, "main", WebviewUrl::External(discord_url))
                .title("Vesktop Rust Preview")
                .inner_size(1280.0, 800.0)
                .min_inner_size(940.0, 500.0)
                .initialization_script(INIT_BRIDGE)
                .on_navigation(move |url| {
                    if is_discord_navigation(url) {
                        return true;
                    }

                    if matches!(url.scheme(), "https" | "http" | "mailto") {
                        let _ = opener_handle.opener().open_url(url.as_str(), None::<&str>);
                    }

                    false
                })
                .build()?;

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("Vesktop Chromium runtime failed to build");

    app.run(|_app, _event| {});
}
