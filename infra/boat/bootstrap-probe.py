#!/usr/bin/python3
"""Inspect a guarded bootstrap without launching or changing the setup."""
from pathlib import Path
import fcntl
import sys

with open('/run/lock/rakazo-network-bootstrap.lock', 'a') as lock:
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        print('RUNNING')
        raise SystemExit(0)
    expected = sys.argv[1] + ' ' + Path('/proc/sys/kernel/random/boot_id').read_text().strip()
    try:
        complete = Path('/home/user/.rakazo-network/bootstrap-complete').read_text().strip()
    except FileNotFoundError:
        complete = ''
    print('COMPLETE' if complete == expected else 'NOT_COMPLETE')
