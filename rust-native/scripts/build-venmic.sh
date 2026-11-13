#!/usr/bin/env bash
set -euo pipefail

# Build the pinned Vencord/venmic REST server and install a localhost-only copy.
# The upstream server defaults to 0.0.0.0; this patch is mandatory because /link
# and /unlink control the system audio graph and must not be exposed to the LAN.

readonly VENMIC_COMMIT="086a5b4cb201886140ca98ed3224e448a60b5050"
readonly BUILD_ROOT="$HOME/.cache/vesktop-rust/venmic"
readonly INSTALL_DIR="$HOME/.local/bin"
readonly SOURCE_DIR="$BUILD_ROOT/source"
readonly BUILD_DIR="$BUILD_ROOT/build"
readonly SERVER_CPP="$SOURCE_DIR/server/main.cpp"

for command in git cmake python3 install; do
    command -v "$command" >/dev/null 2>&1 || {
        printf 'Missing required build tool: %s\n' "$command" >&2
        exit 1
    }
done

mkdir -p "$BUILD_ROOT" "$INSTALL_DIR"

if [[ ! -d "$SOURCE_DIR/.git" ]]; then
    git clone https://github.com/Vencord/venmic.git "$SOURCE_DIR"
fi

git -C "$SOURCE_DIR" fetch --depth 1 origin "$VENMIC_COMMIT"
git -C "$SOURCE_DIR" checkout --detach "$VENMIC_COMMIT"

python3 - "$SERVER_CPP" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
text = path.read_text()
unsafe = 'server.listen("0.0.0.0", port);'
safe = 'server.listen("127.0.0.1", port);'

if safe in text:
    pass
elif unsafe in text:
    path.write_text(text.replace(unsafe, safe, 1))
else:
    raise SystemExit(
        "Could not apply the localhost-only venmic patch: expected listener line was not found. "
        "Review the pinned upstream source before building."
    )
PY

cmake -S "$SOURCE_DIR" -B "$BUILD_DIR" \
    -Dvenmic_server=ON \
    -Dvenmic_addon=OFF \
    -Dvenmic_prefer_remote=ON \
    -DCMAKE_BUILD_TYPE=Release

cmake --build "$BUILD_DIR" --target venmic-server --parallel

install -m 0755 "$BUILD_DIR/server/venmic-server" "$INSTALL_DIR/vesktop-venmic-server"

printf '\nInstalled localhost-only helper: %s/vesktop-venmic-server\n' "$INSTALL_DIR"
printf 'Make sure %s is in PATH, or set VESKTOP_VENMIC_SERVER to the binary path.\n' "$INSTALL_DIR"
