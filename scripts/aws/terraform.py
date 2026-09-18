#!/usr/bin/env python3
"""Run Terraform with refreshable AWS CLI login credentials; never persist key material."""
import os
from pathlib import Path
import shlex
import sys
root=Path(__file__).resolve().parents[2]
env=os.environ.copy()
env['TABDUCTOR_SOURCE_AWS_CONFIG']=env.get('AWS_CONFIG_FILE',str(Path.home()/'.aws/config'))
env['TABDUCTOR_SOURCE_AWS_CREDENTIALS']=env.get('AWS_SHARED_CREDENTIALS_FILE',str(Path.home()/'.aws/credentials'))
env['TABDUCTOR_SOURCE_AWS_PROFILE']=env.get('AWS_PROFILE','default')
state=root/'.tabductor-aws';state.mkdir(mode=0o700,exist_ok=True)
config=state/'sdk-config'
command=shlex.join([sys.executable,str(root/'scripts/aws/credentials.py')])
config.write_text(f'[profile tabductor-terraform]\nregion = ap-southeast-2\ncredential_process = {command}\n')
config.chmod(0o600)
for key in ['AWS_ACCESS_KEY_ID','AWS_SECRET_ACCESS_KEY','AWS_SESSION_TOKEN','AWS_DEFAULT_PROFILE']:
    env.pop(key,None)
env.update(AWS_CONFIG_FILE=str(config),AWS_PROFILE='tabductor-terraform',AWS_SDK_LOAD_CONFIG='1',AWS_REGION='ap-southeast-2')
os.execvpe('terraform',['terraform',*sys.argv[1:]],env)
