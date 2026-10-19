#!/usr/bin/env python3
"""Fetch this desktop's apt-index-verified archives concurrently, then install offline."""
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import hashlib
import os
import shlex
import subprocess

packages = ['xvfb', 'x11vnc', 'fluxbox', 'xterm', 'websockify', 'novnc', 'redsocks', 'unbound']
plan = subprocess.check_output(['apt-get', '--print-uris', '--yes', '--download-only', '-o', 'Acquire::ForceHash=SHA256', 'install', *packages], text=True)
downloads = []
for line in plan.splitlines():
    if not line.startswith("'"):
        continue
    url, name, size, digest = shlex.split(line)
    if not url.startswith('https://') or Path(name).name != name or not digest.startswith('SHA256:'):
        raise SystemExit('Unexpected apt archive metadata')
    downloads.append((url, name, int(size), digest.split(':', 1)[1]))

cache = Path('/var/cache/apt/archives')
cache.mkdir(parents=True, exist_ok=True)

def fetch(item):
    url, name, size, digest = item
    dest = cache / name
    if dest.exists() and dest.stat().st_size == size and hashlib.sha256(dest.read_bytes()).hexdigest() == digest:
        return
    temp = cache / (name + '.rakazo-download')
    subprocess.run(['curl', '--fail', '--silent', '--show-error', '--location', '--continue-at', '-', '--max-time', '300', '--retry', '2', '--retry-all-errors', '--retry-delay', '1', '--output', str(temp), url], check=True)
    if temp.stat().st_size != size or hashlib.sha256(temp.read_bytes()).hexdigest() != digest:
        raise RuntimeError('Apt archive size or SHA256 mismatch')
    temp.replace(dest)

print(f'Downloading {len(downloads)} verified archives ({sum(x[2] for x in downloads)} bytes)', flush=True)
with ThreadPoolExecutor(max_workers=8) as pool:
    list(pool.map(fetch, downloads))
subprocess.run(['apt-get', '--no-download', '--yes', '-qq', 'install', *packages], check=True, env={**os.environ, 'DEBIAN_FRONTEND': 'noninteractive'})
print('DESKTOP_PACKAGES_READY', flush=True)
