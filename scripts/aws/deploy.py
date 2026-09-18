#!/usr/bin/env python3
"""Deploy the shared chart with the validated image digests and external secret."""
import json
import os
import subprocess
from pathlib import Path
root=Path('.tabductor-aws').resolve()
os.environ['KUBECONFIG']=str(root/'kubeconfig')
images=json.loads((root/'images.json').read_text())
chart='infra/helm/tabductor'
values={'image':images['app'],'fleet':{'workerImage':images['browser-worker']['repository']+'@'+images['browser-worker']['digest']},
        'environment':{'BROWSER_CPU_REQUEST':'1','BROWSER_MEMORY_REQUEST':'2Gi'}}
# No secrets in this file or in Helm history.
(root/'images-values.json').write_text(json.dumps(values))
base=['helm','upgrade','--install','staging',chart,'--namespace','tabductor-staging','-f',chart+'/values-aws.yaml','-f',str(root/'images-values.json')]
# Stop execution across schema migrations. Browser fleet persists until sessions drain.
subprocess.run(base+['--set','controlPlane.enabled=false','--set','migration.enabled=false','--wait','--timeout','5m'],check=True)
subprocess.run(['kubectl','-n','tabductor-staging','delete','job','staging-tabductor-migrate','--ignore-not-found'],check=True)
subprocess.run(base+['--set','controlPlane.enabled=false','--set','migration.enabled=true','--wait','--timeout','5m'],check=True)
subprocess.run(['kubectl','-n','tabductor-staging','wait','--for=condition=complete','job/staging-tabductor-migrate','--timeout=5m'],check=True)
subprocess.run(base+['--set','controlPlane.enabled=true','--set','migration.enabled=false','--wait','--timeout','5m'],check=True)
arn=subprocess.check_output(['python3','scripts/aws/terraform.py','-chdir=infra/aws/edge','output','-raw','target_group_arn'],text=True).strip()
binding={'apiVersion':'elbv2.k8s.aws/v1beta1','kind':'TargetGroupBinding','metadata':{'name':'gateway','namespace':'tabductor-staging'},
         'spec':{'serviceRef':{'name':'staging-tabductor-gateway','port':8081},'targetGroupARN':arn,'targetType':'ip'}}
subprocess.run(['kubectl','apply','-f','-'],input=json.dumps(binding),text=True,check=True)
print('Shared chart deployed; HTTPS endpoint targets the authenticated gateway.')
