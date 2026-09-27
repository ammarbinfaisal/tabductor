#!/usr/bin/env python3
"""Build deployable images from one clean revision and label their provenance."""
import subprocess

def output(*args):
    return subprocess.check_output(args, text=True).strip()
if output('git', 'status', '--porcelain'):
    raise SystemExit('Commit the validated batch before building deployment images')
revision = output('git', 'rev-parse', 'HEAD')
for dockerfile, tag, context in [('Dockerfile', 'tabductor-app:local', '.'), ('apps/browser-worker/Dockerfile', 'tabductor-browser-worker:local', '.'), ('apps/python-runner/Dockerfile', 'tabductor-python-broker:local', '.'), ('apps/python-runner/Dockerfile.runtime', 'tabductor-python-runner:local', '.')]:
    subprocess.run(['docker', 'build', '--label', 'org.opencontainers.image.revision=' + revision,
                    '-f', dockerfile, '-t', tag, context], check=True)
if output('git', 'rev-parse', 'HEAD') != revision or output('git', 'status', '--porcelain'):
    raise SystemExit('Source changed during build; rebuild before publishing')
print('Built application, worker, Python broker and execution images for revision ' + revision)
