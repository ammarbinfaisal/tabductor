#!/usr/bin/env python3
"""Create the isolated, encrypted Terraform state bucket. Does not provision the cluster."""
import json
import subprocess
from pathlib import Path

REGION = 'ap-southeast-2'
ACCOUNT = '523227112806'
BUCKET = f'tabductor-staging-{ACCOUNT}-{REGION}-terraform'
def aws(*args):
    return subprocess.check_output(['aws', *args, '--region', REGION, '--output', 'json'])
if json.loads(aws('sts', 'get-caller-identity'))['Account'] != ACCOUNT:
    raise SystemExit('Refusing to provision into a different AWS account')
check = subprocess.run(['aws','s3api','head-bucket','--bucket',BUCKET,'--region',REGION], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
if check.returncode:
    aws('s3api','create-bucket','--bucket',BUCKET,'--create-bucket-configuration',json.dumps({'LocationConstraint':REGION}))
aws('s3api','put-bucket-versioning','--bucket',BUCKET,'--versioning-configuration','{"Status":"Enabled"}')
aws('s3api','put-public-access-block','--bucket',BUCKET,'--public-access-block-configuration',json.dumps(dict(BlockPublicAcls=True,IgnorePublicAcls=True,BlockPublicPolicy=True,RestrictPublicBuckets=True)))
aws('s3api','put-bucket-encryption','--bucket',BUCKET,'--server-side-encryption-configuration',json.dumps({'Rules':[{'ApplyServerSideEncryptionByDefault':{'SSEAlgorithm':'aws:kms'}}]}))
aws('s3api','put-bucket-policy','--bucket',BUCKET,'--policy',json.dumps({'Version':'2012-10-17','Statement':[{'Effect':'Deny','Principal':'*','Action':'s3:*','Resource':[f'arn:aws:s3:::{BUCKET}',f'arn:aws:s3:::{BUCKET}/*'],'Condition':{'Bool':{'aws:SecureTransport':'false'}}}]}))
root = Path('.tabductor-aws'); root.mkdir(mode=0o700,exist_ok=True)
for stage in ['foundation','edge']:
    (root / f'{stage}-backend.hcl').write_text(f'bucket = "{BUCKET}"\nkey = "{stage}/terraform.tfstate"\nregion = "{REGION}"\nencrypt = true\nuse_lockfile = true\n')
print(f'Terraform state ready in {BUCKET}; credentials were not written to disk.')
