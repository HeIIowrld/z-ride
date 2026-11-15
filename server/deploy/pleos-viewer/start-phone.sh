#!/bin/bash
set -euo pipefail
export ANDROID_SDK_ROOT=/opt/android-sdk
export ANDROID_AVD_HOME=/home/emulator/.android/avd
export DISPLAY=:104 QT_X11_NO_MITSHM=1
emulator_bin="${PLEOS_EMULATOR_BIN:-$ANDROID_SDK_ROOT/emulator/emulator}"
gpu_mode="${PLEOS_GPU_MODE:-swiftshader}"
case "$gpu_mode" in swangle|swiftshader|host) ;; *) exit 2 ;; esac
if [ ! -x "$emulator_bin" ]; then
    printf 'Android phone emulator executable unavailable: %s\n' "$emulator_bin" >&2
    exit 1
fi

Xvfb "$DISPLAY" -screen 0 720x1050x24 -nolisten tcp -noreset &
xvfb=$!
trap 'kill "$xvfb" 2>/dev/null || true' EXIT
for attempt in $(seq 1 30); do
    [ -S /tmp/.X11-unix/X104 ] && break
    sleep 0.2
done
openbox --sm-disable >/dev/null 2>&1 &
x11vnc -display "$DISPLAY" -rfbport 5904 -localhost -forever -shared -nosel -nopw -quiet &
websockify --heartbeat=30 6084 127.0.0.1:5904 &
"$emulator_bin" -avd PLY_Phone -port 5560 -memory 2048 -cores 2 \
    -gpu "$gpu_mode" -feature -Vulkan -no-snapshot -no-boot-anim -noaudio -no-metrics \
    -crash-report-mode never -camera-back none -camera-front none
