#!/usr/bin/env python3
"""Install the optional, hash-locked Linux driver without changing the system Python."""
import argparse
import fcntl
import hashlib
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile


def install(requirements, target=None):
    os.umask(0o022)
    content = requirements.read_bytes()
    digest = hashlib.sha256(content).hexdigest()
    parent = Path.home() / '.local/share/rakazo/browser-drivers'
    target = target or parent / ('patchright-' + digest[:16])
    target.parent.mkdir(parents=True, exist_ok=True)
    lock_path = target.with_name(target.name + '.lock')
    with open(lock_path, 'a') as lock:
        os.chmod(lock_path, 0o600)
        fcntl.flock(lock, fcntl.LOCK_EX)
        python = target / 'bin/python'
        marker = target / '.requirements-sha256'
        if python.exists() and marker.exists() and marker.read_text() == digest:
            return python
        staging = Path(tempfile.mkdtemp(prefix='.browser-driver-', dir=target.parent))
        try:
            if shutil.which('uv'):
                env = {**os.environ, 'UV_CACHE_DIR': str(target.parent / '.uv-cache')}
                subprocess.run(['uv', 'venv', '--python', sys.executable, str(staging)], check=True, env=env)
                command = ['uv', 'pip', 'install', '--python', str(staging / 'bin/python')]
            else:
                env = os.environ
                subprocess.run([sys.executable, '-m', 'venv', str(staging)], check=True)
                command = [str(staging / 'bin/python'), '-m', 'pip', 'install', '--disable-pip-version-check']
            subprocess.run([*command, '--require-hashes', '--only-binary=:all:', '-r', str(requirements)],
                           stdout=sys.stderr, check=True, env=env)
            subprocess.run([str(staging / 'bin/python'), '-c', 'from patchright.sync_api import sync_playwright'],
                           stdout=sys.stderr, check=True)
            (staging / '.requirements-sha256').write_text(digest)
            # Images run with an unprivileged uid that differs from the builder.
            staging.chmod(0o755)
            if target.exists():
                shutil.rmtree(target)
            staging.rename(target)
            return python
        finally:
            if staging.exists():
                shutil.rmtree(staging)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--requirements', required=True, type=Path)
    parser.add_argument('--target', type=Path)
    args = parser.parse_args()
    print(install(args.requirements, args.target))
