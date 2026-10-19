#!/usr/bin/env python3
"""Explicit online acceptance check; run inside a managed bot terminal.

--rebind-wireguard also reproduces a tunnel socket being created by a command
scope. No credentials are used or public IP addresses printed.
"""
import argparse
import os
from pathlib import Path
import subprocess
import uuid

parser = argparse.ArgumentParser()
parser.add_argument('--rebind-wireguard', action='store_true')
args = parser.parse_args()
if '/app.slice/' not in Path('/proc/self/cgroup').read_text():
    raise SystemExit('Run this check inside a bot terminal command scope')

environment = {k: v for k, v in os.environ.items()
               if k.lower() not in ('http_proxy', 'https_proxy', 'all_proxy', 'no_proxy')}
url = 'https://api.ipify.org'


def run(argv):
    return subprocess.check_output(argv, env=environment, text=True, timeout=40).strip()


def check(name, condition):
    if not condition:
        raise SystemExit(name + ': FAILED')
    print(name + ': passed', flush=True)


expected = run(['curl', '-4', '--socks5-hostname', '10.202.0.1:1080',
                '-fsS', '--max-time', '20', url])
check('curl ignores proxy environment and still uses proxy egress',
      run(['curl', '-4', '--noproxy', '*', '-fsS', '--max-time', '20', url]) == expected)
check('Node fetch uses proxy egress',
      run(['node', '-e', 'fetch("' + url + '").then(r=>r.text()).then(console.log)']) == expected)
check('Python without HTTP proxy support uses proxy egress',
      run(['python3', '-c', 'import urllib.request; print(urllib.request.build_opener(urllib.request.ProxyHandler({})).open("'
           + url + '",timeout=20).read().decode())']) == expected)
check('sudo child uses proxy egress',
      run(['sudo', '-n', 'env', '-u', 'ALL_PROXY', '-u', 'all_proxy',
           'curl', '-4', '--noproxy', '*', '-fsS', '--max-time', '20', url]) == expected)
check('management scope retains direct egress',
      run(['sudo', '-n', 'systemd-run', '--quiet', '--wait', '--pipe', '--collect',
           '--unit=rakazo-proxy-check-' + uuid.uuid4().hex[:12],
           'curl', '-4', '--noproxy', '*', '-fsS', '--max-time', '20', url]) != expected)
if args.rebind_wireguard:
    # The socket inherits this command's cgroup. Its WireGuard mark must bypass
    # the public UDP rejection, or the browser and terminal both lose egress.
    run(['sudo', '-n', 'wg', 'set', 'rakazo0', 'listen-port', '0'])
    check('WireGuard rebind preserves tunnel transport',
          run(['curl', '-4', '--noproxy', '*', '-fsS', '--max-time', '20', url]) == expected)
    if 'wg0' in run(['sudo', '-n', 'wg', 'show', 'interfaces']).split():
        check('provider preview transport is marked',
              run(['sudo', '-n', 'wg', 'show', 'wg0', 'fwmark']) != 'off')
        run(['sudo', '-n', 'wg', 'set', 'wg0', 'listen-port', '0'])
        print('Provider preview tunnel rebound; verify the screen connection externally', flush=True)
