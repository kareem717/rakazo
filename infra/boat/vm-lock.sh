#!/bin/bash
set -euo pipefail
# Remove only the routing and firewall rules installed by Rakazo.
python3 - <<'CLEAN'
import subprocess
for tool in ('iptables','ip6tables'):
 subprocess.run([tool,'-w','-P','OUTPUT','ACCEPT'],check=True)
 for table in ('filter','mangle','nat'):
  r=subprocess.run([tool+'-save','-t',table],capture_output=True,text=True,check=True)
  lines=[]
  for line in r.stdout.splitlines():
   if line.startswith('-A ') and any(x in line for x in ('RAKAZO_', 'rakazo0', '51872', '0x7071','0x7070')): continue
   if line.startswith(':RAKAZO_'): continue
   lines.append(line)
  subprocess.run([tool+'-restore','--wait'],input='\n'.join(lines)+'\n',text=True,check=True)
for family in ('-4','-6'):
 for priority in (40,45,46,50,60,70,80,90,100):
  while subprocess.run(['ip',family,'rule','del','priority',str(priority)],stderr=subprocess.DEVNULL).returncode==0: pass
 subprocess.run(['ip',family,'route','flush','table','51871'],stderr=subprocess.DEVNULL)
CLEAN
