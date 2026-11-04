#!/usr/bin/env python3
"""PVE-only guard. Stops only emulator units in CT317 under host pressure."""
from pathlib import Path
import subprocess
memory={line.split(':')[0]:int(line.split()[1]) for line in Path('/proc/meminfo').read_text().splitlines() if ':'in line}
pressure=Path('/proc/pressure/memory').read_text().splitlines()[0]
avg10=float(next(v.split('=')[1]for v in pressure.split()if v.startswith('avg10=')))
if memory['MemAvailable']<1024*1024 or avg10>20:
    for i in [3,2,1]:
        unit=f'pleos-vehicle@{i}.service'
        active=subprocess.run(['pct','exec','317','--','systemctl','is-active',unit],capture_output=True,text=True,timeout=10).stdout.strip()=='active'
        if active:
            subprocess.run(['pct','exec','317','--','systemctl','stop',unit],check=True,timeout=30)
            print(f'Stopped CT317 {unit}: host memory pressure; availableMiB={memory["MemAvailable"]//1024}, avg10={avg10}')
            break
