#!/usr/bin/env python3
"""Publish already validated images; save immutable digests for Helm."""
import json
import subprocess
from pathlib import Path

def run(*args, **kwargs): return subprocess.check_output(list(args), text=True, **kwargs)
d=json.loads(run('python3','scripts/aws/terraform.py','-chdir=infra/aws/foundation','output','-json','deployment'))
revision=run('git','rev-parse','HEAD').strip()
tag=revision[:12]
if run('git','status','--porcelain').strip(): raise SystemExit('Commit the validated deployment batch before publishing images')
for local in ['tabductor-app:local', 'tabductor-browser-worker:local', 'tabductor-python-broker:local', 'tabductor-python-runner:local']:
    label=run('docker','image','inspect',local,'--format','{{index .Config.Labels "org.opencontainers.image.revision"}}').strip()
    if label != revision: raise SystemExit('Image revision mismatch; run python3 scripts/aws/build-images.py')
registry=f"{d['account_id']}.dkr.ecr.{d['region']}.amazonaws.com"
password=run('aws','ecr','get-login-password','--region',d['region'])
run('docker','login','--username','AWS','--password-stdin',registry,input=password)
images={}
for name,local in [('app','tabductor-app:local'),('browser-worker','tabductor-browser-worker:local'),('python-broker','tabductor-python-broker:local'),('python-runner','tabductor-python-runner:local')]:
    repository=d['image_repositories'][name]
    remote=f'{repository}:{tag}'
    subprocess.run(['docker','tag',local,remote],check=True)
    subprocess.run(['docker','push',remote],check=True)
    digest=run('aws','ecr','describe-images','--repository-name',f'tabductor-staging/{name}',
        '--image-ids',f'imageTag={tag}','--region',d['region'],'--query','imageDetails[0].imageDigest','--output','text').strip()
    images[name]={'repository':repository,'digest':digest}
Path('.tabductor-aws/images.json').write_text(json.dumps({**images, 'revision': revision},indent=2))
print('Published immutable image digests.')
