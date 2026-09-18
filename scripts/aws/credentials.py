#!/usr/bin/env python3
"""AWS credential_process bridge. Its stdout is consumed only by the AWS SDK."""
import os
import subprocess
import sys
env = os.environ.copy()
for key in ['AWS_ACCESS_KEY_ID','AWS_SECRET_ACCESS_KEY','AWS_SESSION_TOKEN','AWS_PROFILE','AWS_DEFAULT_PROFILE','AWS_CONFIG_FILE','AWS_SHARED_CREDENTIALS_FILE']:
    env.pop(key, None)
env['AWS_CONFIG_FILE'] = os.environ['TABDUCTOR_SOURCE_AWS_CONFIG']
env['AWS_SHARED_CREDENTIALS_FILE'] = os.environ['TABDUCTOR_SOURCE_AWS_CREDENTIALS']
result = subprocess.run(['aws','configure','export-credentials','--profile',os.environ['TABDUCTOR_SOURCE_AWS_PROFILE'],'--format','process'],env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
if result.returncode:
    sys.stderr.write('AWS login could not be refreshed; run aws login for the configured profile.\n')
    raise SystemExit(result.returncode)
sys.stdout.buffer.write(result.stdout)
