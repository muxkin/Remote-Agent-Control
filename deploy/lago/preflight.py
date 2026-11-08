#!/usr/bin/env python3
"""Check the selected host before pulling/starting the production stack."""
import json
import os
from pathlib import Path
import shutil
import socket
import sys

memory = {}
for line in Path('/proc/meminfo').read_text().splitlines():
    key, value = line.split(':', 1)
    memory[key] = int(value.split()[0])
target = Path('/opt/lago') if Path('/opt/lago').exists() else Path('/opt')
free_gib = shutil.disk_usage(target).free / 1024**3
total_mib = memory['MemTotal'] / 1024
cpus = len(os.sched_getaffinity(0))
problems = []
if total_mib < 3500:
    problems.append('At least approximately 4 GB physical RAM is recommended for this stack; swap is not counted.')
if cpus < 2:
    problems.append('At least 2 vCPUs are recommended.')
if free_gib < 12:
    problems.append('Reserve at least 12 GiB free disk for images, database growth and backups.')
for port in (13000, 18080):
    with socket.socket() as sock:
        if sock.connect_ex(('127.0.0.1', port)) == 0:
            problems.append(f'Loopback port {port} is already in use; inspect the existing service before deployment.')
print(json.dumps({'physical_memory_mib': round(total_mib), 'vcpus': cpus, 'free_disk_gib': round(free_gib, 1), 'problems': problems}, indent=2))
sys.exit(1 if problems else 0)
