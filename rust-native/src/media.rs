/*
 * Vesktop Rust Preview
 * Copyright (c) 2026 Vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

use std::{
    collections::BTreeMap,
    env,
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::{Mutex, OnceLock},
    time::Duration,
};

use reqwest::{Client, StatusCode};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

const VENMIC_PORT: u16 = 17_591;
const VENMIC_BASE: &str = "http://127.0.0.1:17591";

pub type PipeWireNode = BTreeMap<String, String>;

#[derive(Default)]
pub struct VenmicRuntime {
    child: Mutex<Option<Child>>,
}

impl Drop for VenmicRuntime {
    fn drop(&mut self) {
        if let Ok(child) = self.child.get_mut() {
            if let Some(mut child) = child.take() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioSourcesResponse {
    pub targets: Vec<PipeWireNode>,
    pub has_pipewire_pulse: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioLinkRequest {
    #[serde(default)]
    pub include: Vec<PipeWireNode>,
    #[serde(default)]
    pub exclude: Vec<PipeWireNode>,
    #[serde(default = "default_true")]
    pub ignore_devices: bool,
    #[serde(default = "default_true")]
    pub ignore_input_media: bool,
    #[serde(default)]
    pub ignore_virtual: bool,
    #[serde(default = "default_true")]
    pub only_speakers: bool,
    #[serde(default = "default_true")]
    pub only_default_speakers: bool,
    #[serde(default)]
    pub workaround: bool,
}

#[derive(Serialize)]
struct VenmicLinkPayload {
    include: Vec<PipeWireNode>,
    exclude: Vec<PipeWireNode>,
    mute: bool,
    ignore_devices: bool,
    only_speakers: bool,
    only_default_speakers: bool,
    workaround: Vec<PipeWireNode>,
}

fn default_true() -> bool {
    true
}

fn http_client() -> &'static Client {
    static CLIENT: OnceLock<Client> = OnceLock::new();

    CLIENT.get_or_init(|| {
        Client::builder()
            .connect_timeout(Duration::from_secs(2))
            .timeout(Duration::from_secs(4))
            .build()
            .expect("static venmic HTTP client configuration is valid")
    })
}

fn endpoint(path: &str) -> String {
    format!("{VENMIC_BASE}{path}")
}

async fn server_is_ready() -> bool {
    http_client()
        .get(endpoint("/has-pipewire-pulse"))
        .send()
        .await
        .is_ok_and(|response| response.status().is_success())
}

fn find_server_executable(app: &AppHandle) -> Option<PathBuf> {
    if let Some(path) = env::var_os("VESKTOP_VENMIC_SERVER").map(PathBuf::from) {
        if path.is_file() {
            return Some(path);
        }
    }

    let mut candidates = Vec::new();

    if let Ok(resource_dir) = app.path().resource_dir() {
        candidates.push(resource_dir.join("vesktop-venmic-server"));
        candidates.push(resource_dir.join("binaries").join("vesktop-venmic-server"));
    }

    candidates.push(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("binaries")
            .join("vesktop-venmic-server"),
    );

    for directory in env::split_paths(&env::var_os("PATH").unwrap_or_default()) {
        candidates.push(directory.join("vesktop-venmic-server"));
    }

    candidates.into_iter().find(|candidate| candidate.is_file())
}

fn start_server_process(app: &AppHandle) -> Result<(), String> {
    let runtime = app.state::<VenmicRuntime>();
    let mut child_slot = runtime
        .child
        .lock()
        .map_err(|_| "The audio helper process lock is unavailable.".to_owned())?;

    if let Some(child) = child_slot.as_mut() {
        match child.try_wait() {
            Ok(None) => return Ok(()),
            Ok(Some(_)) | Err(_) => {
                *child_slot = None;
            }
        }
    }

    let executable = find_server_executable(app).ok_or_else(|| {
        "The PipeWire helper is not installed. On Arch Linux, run rust-native/scripts/build-venmic.sh first.".to_owned()
    })?;

    let child = Command::new(&executable)
        .arg(VENMIC_PORT.to_string())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::inherit())
        .spawn()
        .map_err(|error| {
            format!(
                "Could not start the PipeWire helper at {}: {error}",
                executable.display()
            )
        })?;

    *child_slot = Some(child);
    Ok(())
}

async fn ensure_server(app: &AppHandle) -> Result<(), String> {
    if !cfg!(target_os = "linux") {
        return Err("PipeWire audio routing is currently supported on Linux only.".to_owned());
    }

    if server_is_ready().await {
        return Ok(());
    }

    // The companion server is built with a loopback-only listener. Do not substitute
    // the upstream unmodified server, which listens on all network interfaces.
    start_server_process(app)?;

    for _ in 0..40 {
        if server_is_ready().await {
            return Ok(());
        }

        {
            let runtime = app.state::<VenmicRuntime>();
            let mut child_slot = runtime
                .child
                .lock()
                .map_err(|_| "The audio helper process lock is unavailable.".to_owned())?;

            if let Some(child) = child_slot.as_mut() {
                match child.try_wait() {
                    Ok(Some(status)) => {
                        *child_slot = None;
                        return Err(format!(
                            "The PipeWire helper exited during startup ({status})."
                        ));
                    }
                    Err(error) => {
                        *child_slot = None;
                        return Err(format!(
                            "Could not inspect the PipeWire helper process: {error}"
                        ));
                    }
                    Ok(None) => {}
                }
            }
        }

        tokio::time::sleep(Duration::from_millis(100)).await;
    }

    Err("The PipeWire helper did not start listening on 127.0.0.1:17591.".to_owned())
}

pub async fn list_audio_sources(
    app: AppHandle,
    granular: bool,
) -> Result<AudioSourcesResponse, String> {
    ensure_server(&app).await?;

    let properties: Vec<&str> = if granular {
        Vec::new()
    } else {
        vec!["application.name", "node.name"]
    };

    let targets = http_client()
        .post(endpoint("/list"))
        .json(&properties)
        .send()
        .await
        .map_err(|error| format!("Could not query PipeWire sources: {error}"))?
        .error_for_status()
        .map_err(|error| format!("PipeWire source listing failed: {error}"))?
        .json::<Vec<PipeWireNode>>()
        .await
        .map_err(|error| format!("PipeWire returned an invalid source list: {error}"))?;

    let has_pipewire_pulse = http_client()
        .get(endpoint("/has-pipewire-pulse"))
        .send()
        .await
        .map_err(|error| format!("Could not check pipewire-pulse: {error}"))?
        .error_for_status()
        .map_err(|error| format!("pipewire-pulse check failed: {error}"))?
        .json::<bool>()
        .await
        .map_err(|error| format!("PipeWire returned an invalid capability response: {error}"))?;

    Ok(AudioSourcesResponse {
        targets,
        has_pipewire_pulse,
    })
}

pub async fn start_audio_routing(app: AppHandle, request: AudioLinkRequest) -> Result<(), String> {
    ensure_server(&app).await?;

    let process_ids = own_process_tree_ids();
    let mut exclude = request.exclude;

    if request.ignore_input_media {
        exclude.push(node_filter("media.class", "Stream/Input/Audio"));
    }

    if request.ignore_virtual {
        exclude.push(node_filter("node.virtual", "true"));
    }

    for pid in &process_ids {
        exclude.push(node_filter("application.process.id", pid));
    }

    let workaround = if request.workaround {
        process_ids
            .iter()
            .skip(1)
            .take(1)
            .map(|pid| {
                let mut node = node_filter("application.process.id", pid);
                node.insert("media.name".to_owned(), "RecordStream".to_owned());
                node
            })
            .collect()
    } else {
        Vec::new()
    };

    let payload = VenmicLinkPayload {
        include: request.include,
        exclude,
        mute: true,
        ignore_devices: request.ignore_devices,
        only_speakers: request.only_speakers,
        only_default_speakers: request.only_default_speakers,
        workaround,
    };

    let response = http_client()
        .post(endpoint("/link"))
        .json(&payload)
        .send()
        .await
        .map_err(|error| format!("Could not configure PipeWire audio routing: {error}"))?;

    if response.status() != StatusCode::OK {
        return Err(format!(
            "PipeWire refused the audio-routing configuration (HTTP {}).",
            response.status()
        ));
    }

    Ok(())
}

pub async fn unmute_audio_routing(app: AppHandle) -> Result<(), String> {
    ensure_server(&app).await?;

    let response = http_client()
        .get(endpoint("/unmute"))
        .send()
        .await
        .map_err(|error| format!("Could not unmute the virtual microphone: {error}"))?;

    response
        .error_for_status()
        .map_err(|error| format!("PipeWire could not unmute the virtual microphone: {error}"))?;

    Ok(())
}

pub async fn stop_audio_routing(_app: AppHandle) -> Result<(), String> {
    if !server_is_ready().await {
        return Ok(());
    }

    let response = http_client()
        .get(endpoint("/unlink"))
        .send()
        .await
        .map_err(|error| format!("Could not stop PipeWire audio routing: {error}"))?;

    response
        .error_for_status()
        .map_err(|error| format!("PipeWire could not stop audio routing: {error}"))?;

    Ok(())
}

fn node_filter(key: &str, value: &str) -> PipeWireNode {
    BTreeMap::from([(key.to_owned(), value.to_owned())])
}

#[cfg(target_os = "linux")]
fn own_process_tree_ids() -> Vec<String> {
    fn walk(pid: u32, depth: u8, found: &mut Vec<String>) {
        if depth >= 5 {
            return;
        }

        let path = format!("/proc/{pid}/task/{pid}/children");
        let Ok(children) = std::fs::read_to_string(path) else {
            return;
        };

        for child in children.split_whitespace() {
            let Ok(child_pid) = child.parse::<u32>() else {
                continue;
            };

            found.push(child.to_owned());
            walk(child_pid, depth + 1, found);
        }
    }

    let mut ids = vec![std::process::id().to_string()];
    walk(std::process::id(), 0, &mut ids);
    ids
}

#[cfg(not(target_os = "linux"))]
fn own_process_tree_ids() -> Vec<String> {
    Vec::new()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pipewire_filter_contains_only_the_requested_property() {
        let filter = node_filter("application.name", "Firefox");

        assert_eq!(filter.len(), 1);
        assert_eq!(
            filter.get("application.name").map(String::as_str),
            Some("Firefox")
        );
    }

    #[test]
    fn default_audio_settings_are_conservative() {
        let request: AudioLinkRequest = serde_json::from_value(serde_json::json!({})).unwrap();

        assert!(request.ignore_devices);
        assert!(request.ignore_input_media);
        assert!(request.only_speakers);
        assert!(request.only_default_speakers);
        assert!(!request.ignore_virtual);
        assert!(!request.workaround);
        assert!(request.include.is_empty());
        assert!(request.exclude.is_empty());
    }
}
