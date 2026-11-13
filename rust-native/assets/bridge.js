/*
 * Vesktop Rust Preview
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * The bridge only runs on the official Discord web application. It deliberately
 * exposes a small API instead of exposing Tauri's full invoke surface to Discord.
 */
(() => {
    if (window.top !== window) return;

    const host = window.location.hostname.toLowerCase();
    const isDiscordHost =
        host === "discord.com" ||
        host.endsWith(".discord.com") ||
        host === "discordapp.com" ||
        host.endsWith(".discordapp.com");

    if (!isDiscordHost || window.location.protocol !== "https:") return;

    const tauri = window.__TAURI__;
    const invoke = tauri?.core?.invoke?.bind(tauri.core);
    if (typeof invoke !== "function") {
        console.error("[Vesktop Rust] Tauri IPC bridge is unavailable.");
        return;
    }

    const isLinux = navigator.platform.toLowerCase().includes("linux");
    const media = Object.freeze({
        listAudioSources: (granular = false) => invoke("media_list_audio_sources", { granular }),
        startAudioRouting: request => invoke("media_start_audio_routing", { request }),
        unmuteAudio: () => invoke("media_unmute_audio_routing"),
        stopAudio: () => invoke("media_stop_audio_routing")
    });

    const api = Object.freeze({
        getVersion: () => invoke("get_version"),
        getSettings: () => invoke("get_settings"),
        saveSettings: settings => invoke("save_settings", { settings }),
        minimize: () => invoke("minimize_window"),
        toggleMaximize: () => invoke("toggle_maximize_window"),
        close: () => invoke("close_window"),
        focus: () => invoke("focus_window"),
        openExternal: url => invoke("open_external_url", { url }),
        media
    });

    Object.defineProperty(window, "VesktopRust", {
        configurable: false,
        enumerable: false,
        writable: false,
        value: api
    });

    const originalGetDisplayMedia = navigator.mediaDevices?.getDisplayMedia;
    const originalGetUserMedia = navigator.mediaDevices?.getUserMedia;

    if (typeof originalGetDisplayMedia === "function") {
        installScreenShareEnhancements(originalGetDisplayMedia.bind(navigator.mediaDevices));
    } else {
        console.warn("[Vesktop Rust] This system WebView does not expose getDisplayMedia().");
    }

    if (typeof originalGetUserMedia === "function") {
        installConstraintCompatibility(originalGetUserMedia.bind(navigator.mediaDevices));
    }

    function installConstraintCompatibility(original) {
        const devices = navigator.mediaDevices;

        devices.getUserMedia = function (constraints) {
            try {
                normalizeDeviceConstraints(constraints);
            } catch (error) {
                console.warn("[Vesktop Rust] Could not normalize media constraints.", error);
            }

            return original(constraints);
        };

        const applyConstraints = MediaStreamTrack.prototype.applyConstraints;
        MediaStreamTrack.prototype.applyConstraints = function (constraints) {
            try {
                const wrapper = {
                    audio: this.kind === "audio" ? constraints : false,
                    video: this.kind === "video" ? constraints : false
                };
                normalizeDeviceConstraints(wrapper);
            } catch (error) {
                console.warn("[Vesktop Rust] Could not normalize track constraints.", error);
            }

            return applyConstraints.call(this, constraints);
        };
    }

    function normalizeDeviceConstraints(constraints) {
        if (!constraints || typeof constraints !== "object") return;

        for (const kind of ["audio", "video"]) {
            const value = constraints[kind];
            if (value === true) {
                constraints[kind] = {};
                continue;
            }

            if (!value || typeof value !== "object") continue;

            const deviceId = value.deviceId;
            if (typeof deviceId === "string" && deviceId !== "default") {
                value.deviceId = { exact: deviceId };
            }
        }
    }

    function installScreenShareEnhancements(originalGetDisplayMedia) {
        const mediaDevices = navigator.mediaDevices;
        const screenTracks = new WeakSet();
        let lastQuality = { resolution: 720, frameRate: 30 };

        mediaDevices.getDisplayMedia = function (options = {}) {
            // The custom dialog ends with a deliberate click. The original capture
            // call is made synchronously in that click handler, preserving activation.
            return new Promise((resolve, reject) => {
                openShareOptions(selection => {
                    beginCapture(options, selection, resolve, reject);
                }, reject);
            });
        };

        async function openShareOptions(onStart, reject) {
            let audioInfo = { targets: [], hasPipewirePulse: false };
            let audioError = null;

            if (isLinux) {
                try {
                    audioInfo = await media.listAudioSources(true);
                } catch (error) {
                    audioError = String(error?.message || error);
                }
            }

            const host = document.createElement("div");
            host.id = "vesktop-rust-share-options";
            const shadow = host.attachShadow({ mode: "closed" });
            const style = document.createElement("style");
            style.textContent = pickerCss;
            shadow.appendChild(style);

            const dialog = document.createElement("section");
            dialog.className = "dialog";
            dialog.setAttribute("role", "dialog");
            dialog.setAttribute("aria-modal", "true");
            dialog.setAttribute("aria-labelledby", "title");
            dialog.innerHTML =
                '<header>' +
                    '<div class="eyebrow">VESKTOP RUST</div>' +
                    '<h1 id="title">Share your screen</h1>' +
                    '<p class="subtitle">Choose stream quality and audio. Your desktop will then ask which screen or window to share.</p>' +
                '</header>' +
                '<div class="section">' +
                    '<div class="section-heading">Video quality</div>' +
                    '<div class="two-columns">' +
                        '<label>Resolution<select id="resolution">' +
                            '<option value="480">480p</option><option value="720" selected>720p</option>' +
                            '<option value="1080">1080p</option><option value="1440">1440p</option>' +
                            '<option value="2160">2160p</option><option value="0">Source</option>' +
                        '</select></label>' +
                        '<label>Frame rate<select id="fps">' +
                            '<option value="15">15 FPS</option><option value="30" selected>30 FPS</option>' +
                            '<option value="60">60 FPS</option>' +
                        '</select></label>' +
                    '</div>' +
                    '<div class="section-heading spaced">Content preference</div>' +
                    '<div class="choice-row">' +
                        '<label class="choice"><input type="radio" name="content" value="motion" checked><span><b>Smoothness</b><small>Prioritize motion and frame rate</small></span></label>' +
                        '<label class="choice"><input type="radio" name="content" value="detail"><span><b>Clarity</b><small>Prioritize sharper text and detail</small></span></label>' +
                    '</div>' +
                '</div>' +
                (isLinux ?
                    '<div class="section audio-section">' +
                        '<div class="section-heading">Share audio</div>' +
                        '<div class="choice-row audio-modes">' +
                            '<label class="choice"><input type="radio" name="audio-mode" value="none" checked><span><b>No audio</b><small>Video only</small></span></label>' +
                            '<label class="choice"><input type="radio" name="audio-mode" value="apps"><span><b>Selected apps</b><small>Choose what to include</small></span></label>' +
                            '<label class="choice"><input type="radio" name="audio-mode" value="system"><span><b>Entire system</b><small>Exclude selected apps</small></span></label>' +
                        '</div>' +
                        '<div id="audio-status" class="status"></div>' +
                        '<div id="audio-sources" class="sources"></div>' +
                        '<div class="audio-toggles">' +
                            '<label><input id="only-speakers" type="checkbox" checked> Only speaker output</label>' +
                            '<label><input id="only-default" type="checkbox" checked> Only default output</label>' +
                            '<label><input id="ignore-devices" type="checkbox" checked> Ignore physical audio devices</label>' +
                        '</div>' +
                    '</div>' : "") +
                '<footer><button class="cancel" id="cancel">Cancel</button>' +
                '<button class="start" id="start">Continue to display picker</button></footer>';

            shadow.appendChild(dialog);
            document.documentElement.appendChild(host);

            const close = () => host.remove();
            const cancel = () => {
                close();
                reject(new DOMException("Screen sharing was cancelled.", "AbortError"));
            };

            shadow.getElementById("cancel").addEventListener("click", cancel);
            host.addEventListener("keydown", event => {
                if (event.key === "Escape") cancel();
            });

            if (isLinux) {
                const status = shadow.getElementById("audio-status");
                const list = shadow.getElementById("audio-sources");

                if (audioError) {
                    status.textContent = "PipeWire audio is unavailable. Video sharing can continue without app audio. " + audioError;
                } else if (!audioInfo.hasPipewirePulse) {
                    status.textContent = "pipewire-pulse was not detected. Only PipeWire-connected app audio may be available.";
                } else {
                    status.textContent = "Select apps, or choose Entire system to capture eligible speaker outputs.";
                }

                const targets = (audioInfo.targets || []).filter(node => {
                    const mediaClass = node["media.class"] || "";
                    if (mediaClass.includes("Video") || mediaClass.includes("Midi")) return false;
                    if (node["device.id"] && shadow.getElementById("ignore-devices").checked) return false;
                    return Boolean(node["application.name"] || node["node.description"] || node["node.name"]);
                });

                const unique = new Map();
                for (const node of targets) {
                    const label = node["application.name"] || node["node.description"] || node["node.name"];
                    const key = JSON.stringify({
                        application: node["application.name"],
                        process: node["application.process.id"],
                        media: node["media.name"],
                        node: node["node.name"]
                    });
                    if (!unique.has(key)) unique.set(key, { label, node });
                }

                for (const entry of unique.values()) {
                    const row = document.createElement("label");
                    row.className = "source-row";
                    const checkbox = document.createElement("input");
                    checkbox.type = "checkbox";
                    checkbox.dataset.node = JSON.stringify(entry.node);
                    const name = document.createElement("span");
                    name.textContent = entry.label || "Unnamed audio source";
                    row.append(checkbox, name);
                    list.appendChild(row);
                }

                const updateSources = () => {
                    const mode = shadow.querySelector('input[name="audio-mode"]:checked')?.value;
                    list.classList.toggle("visible", mode === "apps" || mode === "system");
                };
                shadow.querySelectorAll('input[name="audio-mode"]').forEach(input => {
                    input.addEventListener("change", updateSources);
                });
                updateSources();

                if (audioError) {
                    shadow.querySelectorAll('input[name="audio-mode"]').forEach(input => {
                        if (input.value !== "none") input.disabled = true;
                    });
                }
            }

            shadow.getElementById("start").addEventListener("click", () => {
                const resolution = Number(shadow.getElementById("resolution").value);
                const frameRate = Number(shadow.getElementById("fps").value);
                const contentHint = shadow.querySelector('input[name="content"]:checked')?.value || "motion";
                let audio = null;

                if (isLinux) {
                    const mode = shadow.querySelector('input[name="audio-mode"]:checked')?.value || "none";
                    const selected = [...shadow.querySelectorAll("#audio-sources input:checked")]
                        .map(input => JSON.parse(input.dataset.node));

                    audio = {
                        mode,
                        selected,
                        onlySpeakers: shadow.getElementById("only-speakers").checked,
                        onlyDefaultSpeakers: shadow.getElementById("only-default").checked,
                        ignoreDevices: shadow.getElementById("ignore-devices").checked
                    };
                }

                const selection = { resolution, frameRate, contentHint, audio };
                lastQuality = { resolution, frameRate };
                close();
                onStart(selection);
            });

            shadow.getElementById("resolution").focus();
        }

        function beginCapture(originalOptions, selection, resolve, reject) {
            // Call getDisplayMedia before any await; it requires transient user activation.
            let capturePromise;
            try {
                const captureOptions = { ...originalOptions };
                if (isLinux) captureOptions.audio = false;
                capturePromise = originalGetDisplayMedia.call(mediaDevices, captureOptions);
            } catch (error) {
                reject(error);
                return;
            }

            const wantsAudio = isLinux && selection.audio?.mode !== "none";
            const routePromise = wantsAudio
                ? configureLinuxAudio(selection.audio)
                      .then(() => true)
                      .catch(async error => {
                          console.warn("[Vesktop Rust] PipeWire audio setup failed; continuing with video only.", error);
                          await media.stopAudio().catch(() => {});
                          return false;
                      })
                : Promise.resolve(false);

            Promise.all([capturePromise, routePromise])
                .then(async ([stream, audioRouteReady]) => {
                    try {
                        await applyVideoQuality(stream, selection);
                        if (audioRouteReady) await replaceAudioWithVirtualMic(stream);
                        resolve(stream);
                    } catch (error) {
                        stream.getTracks().forEach(track => track.stop());
                        if (isLinux) void media.stopAudio().catch(() => {});
                        reject(error);
                    }
                })
                .catch(error => {
                    if (isLinux) void media.stopAudio().catch(() => {});
                    reject(error);
                });
        }

        async function configureLinuxAudio(audio) {
            if (!audio || audio.mode === "none") {
                await media.stopAudio();
                return;
            }

            await media.startAudioRouting({
                include: audio.mode === "apps" ? audio.selected : [],
                exclude: audio.mode === "system" ? audio.selected : [],
                ignoreDevices: audio.ignoreDevices,
                ignoreInputMedia: true,
                ignoreVirtual: false,
                onlySpeakers: audio.onlySpeakers,
                onlyDefaultSpeakers: audio.onlyDefaultSpeakers,
                workaround: false
            });
        }

        async function applyVideoQuality(stream, selection) {
            const track = stream.getVideoTracks()[0];
            if (!track) {
                throw new DOMException("The display picker returned no video track.", "NotFoundError");
            }

            if (selection.contentHint) track.contentHint = selection.contentHint;

            const constraints = {
                frameRate: { ideal: selection.frameRate, max: selection.frameRate }
            };
            if (selection.resolution > 0) {
                constraints.width = { max: Math.round(selection.resolution * 16 / 9) };
                constraints.height = { max: selection.resolution };
            }

            try {
                await track.applyConstraints(constraints);
            } catch (error) {
                console.warn("[Vesktop Rust] The WebView rejected a stream-quality constraint.", error);
            }

            screenTracks.add(track);
            track.addEventListener("ended", () => {
                if (isLinux) void media.stopAudio().catch(() => {});
            }, { once: true });
        }

        async function replaceAudioWithVirtualMic(displayStream) {
            let audioStream = null;
            try {
                audioStream = await acquireVirtualMicStream();
            } catch (error) {
                console.warn("[Vesktop Rust] Could not open the PipeWire virtual microphone; continuing without audio.", error);
            }

            const virtualTrack = audioStream?.getAudioTracks()[0];
            if (!virtualTrack) {
                await media.stopAudio().catch(() => {});
                return false;
            }

            for (const track of displayStream.getAudioTracks()) {
                displayStream.removeTrack(track);
                track.stop();
            }

            displayStream.addTrack(virtualTrack);
            virtualTrack.addEventListener("ended", () => {
                if (isLinux) void media.stopAudio().catch(() => {});
            }, { once: true });
            return true;
        }

        async function acquireVirtualMicStream() {
            for (let attempt = 0; attempt < 12; attempt++) {
                const devices = await mediaDevices.enumerateDevices().catch(() => []);
                const device = devices.find(item =>
                    item.kind === "audioinput" && item.label.toLowerCase().includes("vencord-screen-share")
                );

                if (device) {
                    return mediaDevices.getUserMedia({
                        audio: {
                            deviceId: { exact: device.deviceId },
                            autoGainControl: false,
                            echoCancellation: false,
                            noiseSuppression: false,
                            channelCount: 2,
                            sampleRate: 48000,
                            sampleSize: 16
                        },
                        video: false
                    });
                }

                await new Promise(resolve => setTimeout(resolve, 150));
            }

            return null;
        }

        function maybeUnmuteVirtualMic(track) {
            if (track?.kind !== "audio" || !track.label.toLowerCase().includes("vencord-screen-share")) return;

            setTimeout(() => {
                void media.unmuteAudio().catch(error => {
                    console.warn("[Vesktop Rust] Could not unmute system audio.", error);
                });
            }, 300);
        }

        // Tune only screen tracks. Camera video and ordinary voice tracks are left alone.
        const originalAddTrack = RTCPeerConnection.prototype.addTrack;
        RTCPeerConnection.prototype.addTrack = function (track, ...streams) {
            const sender = originalAddTrack.call(this, track, ...streams);
            if (screenTracks.has(track)) tuneSender(sender, track);
            maybeUnmuteVirtualMic(track);
            return sender;
        };

        if (typeof RTCRtpSender !== "undefined") {
            const originalReplaceTrack = RTCRtpSender.prototype.replaceTrack;
            RTCRtpSender.prototype.replaceTrack = async function (track) {
                const result = await originalReplaceTrack.call(this, track);
                if (track && screenTracks.has(track)) tuneSender(this, track);
                maybeUnmuteVirtualMic(track);
                return result;
            };
        }

        function tuneSender(sender, track) {
            try {
                const parameters = sender.getParameters();
                if (!parameters.encodings?.length) return;

                const settings = track.getSettings();
                const width = settings.width || (lastQuality.resolution ? Math.round(lastQuality.resolution * 16 / 9) : 1920);
                const height = settings.height || lastQuality.resolution || 1080;
                const fps = settings.frameRate || lastQuality.frameRate;
                const bitrate = Math.round(Math.min(Math.max(width * height * fps * 0.08, 3500000), 20000000));

                for (const encoding of parameters.encodings) {
                    encoding.maxBitrate = bitrate;
                    encoding.maxFramerate = fps;
                }

                void sender.setParameters(parameters).catch(error => {
                    console.warn("[Vesktop Rust] Could not apply screen-share sender quality.", error);
                });
            } catch (error) {
                console.warn("[Vesktop Rust] Could not tune the screen-share sender.", error);
            }
        }
    }

    const pickerCss = [
        ':host{all:initial;color-scheme:dark}',
        '.dialog{position:fixed;inset:50% auto auto 50%;transform:translate(-50%,-50%);z-index:2147483647;width:min(760px,calc(100vw - 40px));max-height:min(86vh,900px);overflow:auto;box-sizing:border-box;padding:26px;border-radius:16px;color:#f2f3f5;background:#232428;border:1px solid #45464d;box-shadow:0 18px 70px #000b;font:14px/1.45 system-ui,sans-serif}',
        '.eyebrow{color:#a6a7ad;font-size:10px;letter-spacing:.18em;font-weight:750}',
        'h1{margin:5px 0 2px;font-size:24px;line-height:1.25;font-weight:700}',
        '.subtitle{margin:0;color:#b5bac1}',
        '.section{margin-top:22px}',
        '.section-heading{margin-bottom:10px;color:#f2f3f5;font-size:13px;font-weight:700}',
        '.spaced{margin-top:16px}',
        '.two-columns{display:grid;grid-template-columns:1fr 1fr;gap:12px}',
        '.two-columns label{display:grid;gap:6px;color:#b5bac1;font-size:12px}',
        'select{width:100%;padding:10px 12px;color:#f2f3f5;background:#18191c;border:1px solid #3f4147;border-radius:8px;font:inherit}',
        '.choice-row{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}',
        '.choice{display:flex;gap:9px;align-items:flex-start;padding:10px;border:1px solid #404249;border-radius:9px;background:#2b2d31;cursor:pointer}',
        '.choice input{margin:3px 0 0;accent-color:#5865f2}',
        '.choice b,.choice small{display:block}',
        '.choice small{margin-top:2px;color:#b5bac1;font-size:11px}',
        '.audio-section{padding-top:18px;border-top:1px solid #3b3d44}',
        '.audio-modes{grid-template-columns:repeat(3,minmax(0,1fr))}',
        '.status{margin:10px 0;color:#b5bac1;font-size:12px}',
        '.sources{display:none;max-height:180px;overflow:auto;margin-top:8px;border:1px solid #3f4147;border-radius:8px;background:#191a1e}',
        '.sources.visible{display:block}',
        '.source-row{display:flex;gap:10px;align-items:center;padding:8px 10px;border-bottom:1px solid #303238;cursor:pointer;color:#e5e6e9}',
        '.source-row:last-child{border-bottom:0}',
        '.source-row input,.audio-toggles input{accent-color:#5865f2}',
        '.audio-toggles{display:flex;flex-wrap:wrap;gap:8px 18px;margin-top:12px;color:#b5bac1;font-size:11px}',
        'footer{display:flex;justify-content:flex-end;gap:10px;margin-top:24px}',
        'button{border:0;border-radius:8px;padding:10px 15px;font:650 13px system-ui,sans-serif;cursor:pointer}',
        'button.cancel{color:#f2f3f5;background:#3a3d44}',
        'button.start{color:white;background:#5865f2}',
        'button:hover{filter:brightness(1.08)}',
        '@media(max-width:560px){.dialog{padding:18px}.audio-modes,.choice-row{grid-template-columns:1fr}.two-columns{grid-template-columns:1fr}}'
    ].join("");

    // Prevent Discord from depending directly on the complete Tauri JS API.
    try {
        delete window.__TAURI__;
    } catch {
        // Some WebView implementations expose a non-configurable global.
    }
})();
