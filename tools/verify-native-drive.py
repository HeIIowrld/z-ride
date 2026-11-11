"""Record a Pleos emulator's own navigation simulation alongside its cluster."""

import argparse
import json
import re
import subprocess
import time
from pathlib import Path
from urllib.request import Request, urlopen


def verify(args):
    adb = [args.adb, "-s", args.serial]
    remote_video = "/sdcard/zride-native-drive-verification.mp4"

    def device(*command):
        return subprocess.check_output([*adb, *command], encoding="utf-8", timeout=10).strip()

    user = device("shell", "am", "get-current-user")

    def navigation():
        return json.loads(device(
            "shell", "run-as", "ai.zride.demo.car", "--user", user,
            "cat", "files/navigation-sdk-state.json",
        ))

    def console(path, method="GET"):
        url = f"http://127.0.0.1:{args.console_port}{path}"
        with urlopen(Request(url, method=method), timeout=5) as response:
            return json.load(response)

    def lease():
        console("/browser/session?client=zride-native-drive", "POST")

    def motion(gear, speed):
        console("/vehicle/controls?speed=0&accelerator=0&brake=100&steering=0", "PUT")
        console(f"/vehicle/gear?gear={gear}", "PUT")
        console(f"/vehicle/controls?speed={speed}&accelerator=0&brake=0&steering=0", "PUT")

    device("forward", f"tcp:{args.console_port}", "tcp:8088")
    initial = navigation()
    initial_distance = initial.get("remainingDistanceM")
    if (
        initial.get("status") != "ROUTE_DRIVE"
        or not initial.get("destination")
        or type(initial_distance) is not int
        or initial_distance <= 0
    ):
        raise RuntimeError("Start a route and wait for a NaviHelper destination reading.")

    lease()
    motion("Park", 0)
    initial_range = args.range_m
    if initial_range is None:
        observed_range = console("/vehicle/state")["odometer"]["remaining_range_m"]
        if not isinstance(observed_range, (int, float)) or not 0 < observed_range <= 1_000_000:
            raise RuntimeError("Set the first leg's range with --range-m.")
        initial_range = round(observed_range)
    else:
        console(f"/vehicle/odometer?remaining_range_m={initial_range}", "PUT")
    recorder = subprocess.Popen([
        *adb, "shell", "screenrecord", "--size", "1920x1080",
        "--time-limit", str(args.seconds), remote_video,
    ])
    lowest_distance = initial_distance
    range_m = initial_range
    advanced = False
    driving = False
    arrived = False
    passed_waypoint = False
    started = time.monotonic()
    try:
        if args.start_button:
            # Optional operator-supplied tap on the visible simulator test button.
            time.sleep(2)
            device("shell", "input", "tap", *(str(point) for point in args.start_button))
            if args.close_menu:
                time.sleep(0.7)
                device("shell", "input", "tap", *(str(point) for point in args.close_menu))
        while time.monotonic() - started < args.seconds - 3:
            lease()
            state = navigation()
            same_destination = state.get("destination") == initial["destination"]
            if state.get("arrivedWaypoint") and not passed_waypoint:
                passed_waypoint = True
                print(json.dumps({"waypointArrived": state["arrivedWaypoint"], "rangeM": range_m}, ensure_ascii=False), flush=True)
            if advanced and same_destination and state.get("status") == "ARRIVED":
                arrived = True
                range_m = max(0, initial_range - initial_distance)
                console(f"/vehicle/odometer?remaining_range_m={range_m}", "PUT")
                print(json.dumps({"destinationArrived": state["destination"], "rangeM": range_m}, ensure_ascii=False), flush=True)
                break
            same_route = (
                state.get("status") == "ROUTE_DRIVE"
                and same_destination
                and (state.get("routeRevision") == initial.get("routeRevision") or passed_waypoint)
            )
            if same_route:
                distance = state.get("remainingDistanceM")
                index = state.get("nativeRouteIndex")
                if index is not None and index > (initial.get("nativeRouteIndex") or 0):
                    advanced = True
                if advanced and isinstance(distance, int) and 0 <= distance < lowest_distance:
                    lowest_distance = distance
                    range_m = max(0, initial_range - (initial_distance - distance))
                    console(f"/vehicle/odometer?remaining_range_m={range_m}", "PUT")
                    if not driving:
                        motion("Drive", args.speed_kph)
                        driving = True
                    actual = console("/vehicle/state")
                    if actual["odometer"]["remaining_range_m"] != range_m:
                        raise RuntimeError("Virtual Console did not confirm the cluster range.")
                    print(json.dumps({
                        "elapsedS": round(time.monotonic() - started, 1),
                        "nativeRouteIndex": index,
                        "destinationRemainingM": distance,
                        "clusterRangeM": actual["odometer"]["remaining_range_m"],
                        "gear": actual["gear"]["actual"]["value"],
                        "speedKph": actual["controls"]["speed_kph"],
                    }), flush=True)
            elif advanced and not args.require_arrival:
                break
            time.sleep(1)
    finally:
        try:
            lease()
            motion("Park", 0)
        finally:
            recorder.wait(timeout=args.seconds + 10)
            if recorder.returncode == 0:
                device("pull", remote_video, str(args.video))
                device("shell", "rm", remote_video)
    if recorder.returncode or not args.video.is_file() or not args.video.stat().st_size:
        raise RuntimeError("The emulator did not produce a recording.")
    if not advanced or lowest_distance == initial_distance or range_m == initial_range:
        raise RuntimeError("The recorded route did not advance in the OEM navigation engine.")
    if args.require_waypoint and not passed_waypoint:
        raise RuntimeError("The OEM navigation engine did not report waypoint arrival.")
    if args.require_arrival and not arrived:
        raise RuntimeError("The OEM navigation engine did not report destination arrival.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--adb", default="adb")
    parser.add_argument("--serial", required=True)
    parser.add_argument("--console-port", type=int, default=18088)
    parser.add_argument("--seconds", type=int, default=45)
    parser.add_argument("--range-m", type=int, help="Override range only when starting a new journey")
    parser.add_argument("--speed-kph", type=int, default=36)
    parser.add_argument("--start-button", nargs=2, type=int, metavar=("X", "Y"))
    parser.add_argument("--close-menu", nargs=2, type=int, metavar=("X", "Y"))
    parser.add_argument("--require-waypoint", action="store_true")
    parser.add_argument("--require-arrival", action="store_true")
    parser.add_argument("--video", type=Path, required=True)
    options = parser.parse_args()
    if not re.fullmatch(r"emulator-\d+", options.serial):
        parser.error("--serial must select a local emulator")
    if not 8 <= options.seconds <= 180 or not 1 <= options.speed_kph <= 60:
        parser.error("recording must last 8–180 seconds and demo speed must be 1–60 km/h")
    if ((options.range_m is not None and not 1 <= options.range_m <= 1_000_000)
            or not 1024 <= options.console_port <= 65535):
        parser.error("initial range or local console port out of bounds")
    verify(options)
