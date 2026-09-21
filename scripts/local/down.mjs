import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

function docker(args, capture = false) {
  const result = spawnSync('docker', args, {
    cwd: new URL('../../', import.meta.url),
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw Error(`docker ${args[0]} failed (${result.status ?? result.signal})`);
  return result.stdout ?? '';
}

export function localDown(run = docker) {
  // The base file needs no worker key or socket interpolation. Orphan removal
  // includes gateway/fleet from the browser override, even after a partial down.
  const compose = ['compose', '-p', 'tabductor', '-f', 'docker-compose.yml', '--profile', '*'];
  run([...compose, 'config', '--quiet']);
  const ids = args => run(['ps', '-aq', ...args], true).trim().split(/\s+/).filter(Boolean);
  const services = ids(['--filter', 'label=com.docker.compose.project=tabductor']);
  // Stop the controller before enumerating workers so it cannot replace them.
  if (services.length) run(['stop', ...services]);
  const workers = ids(['--filter', 'label=tabductor.local-browser=1', '--filter', 'network=tabductor_default']);
  if (workers.length) run(['rm', '-f', ...workers]);
  run([...compose, 'down', '--remove-orphans']);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    localDown();
    console.log('Tabductor stopped; local browser containers removed. Persistent data and encryption keys retained.');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
