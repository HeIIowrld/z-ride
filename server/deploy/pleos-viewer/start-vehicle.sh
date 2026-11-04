#!/bin/bash
# Install as /opt/pleos-runtime/start-vehicle, owned root; SDK/AVDs stay private.
set -euo pipefail
i="$1"
case "$i" in 1|2|3);; *)exit 2;; esac
export HOME=/home/emulator ANDROID_SDK_ROOT=/opt/android-sdk ANDROID_AVD_HOME=/home/emulator/.android/avd
export DISPLAY=:$((100+i)) QT_X11_NO_MITSHM=1
gpu_mode="${PLEOS_GPU_MODE:-swiftshader}"
case "$gpu_mode" in swangle|swiftshader|host);; *)exit 2;; esac
ram_mb="${PLEOS_RAM_MB:-4096}"
case "$ram_mb" in 3072|4096);; *)exit 2;; esac
Xvfb "$DISPLAY" -screen 0 1920x1200x24 -nolisten tcp -noreset &
xvfb=$!
trap 'kill "$xvfb" 2>/dev/null || true' EXIT
for attempt in $(seq 1 30);do [ -S "/tmp/.X11-unix/X$((100+i))" ] && break;sleep 0.2;done
openbox --sm-disable >/dev/null 2>&1 &
x11vnc -display "$DISPLAY" -rfbport "$((5900+i))" -localhost -forever -shared -nosel -nopw -quiet >"/home/emulator/logs/vnc-$i.log" 2>&1 &
websockify --heartbeat=30 "$((6080+i))" "127.0.0.1:$((5900+i))" >"/home/emulator/logs/websocket-$i.log" 2>&1 &
# 4 GiB matches the RAM guide; software graphics still differs from the GPU guide.
# 3 GiB is an explicit constrained operator override, not a vendor-supported profile.
/opt/android-sdk/emulator/emulator -avd "Pleos_$i" -port "$((5552+i*2))" -memory "$ram_mb" -cores 2 -gpu "$gpu_mode" -feature -Vulkan -no-snapshot -no-boot-anim -noaudio -no-metrics -crash-report-mode never -camera-back none -camera-front none >"/home/emulator/logs/emulator-$i.log" 2>&1 &
emu=$!
# Official Virtual Console. ADB remains private; the fixed vehicle proxy uses this port.
(for attempt in $(seq 1 180);do /opt/android-sdk/platform-tools/adb -s "emulator-$((5552+i*2))" forward "tcp:$((8080+i))" tcp:8088 >/dev/null 2>&1 && break;sleep 1;done) &
wait "$emu"

