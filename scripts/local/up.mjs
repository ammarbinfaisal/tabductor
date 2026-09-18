import { existsSync, readFileSync, appendFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { parseEnv } from 'node:util';
import { spawnSync } from 'node:child_process';
const file = new URL('../../.env', import.meta.url);
if (!existsSync(file)) writeFileSync(file, '', {mode:0o600});
const values = parseEnv(readFileSync(file,'utf8'));
if (!values.BROWSER_WORKER_TOKEN_KEY) appendFileSync(file, '\nBROWSER_WORKER_TOKEN_KEY='+randomBytes(48).toString('base64url')+'\n');
const endpoint = process.env.DOCKER_HOST || spawnSync('docker',['context','inspect','--format','{{.Endpoints.docker.Host}}'],{encoding:'utf8'}).stdout?.trim();
if (!endpoint?.startsWith('unix:///')) throw Error('Local managed browsers require a local Unix Docker socket.');
const socketPath = endpoint.slice('unix://'.length);
if (values.DOCKER_SOCKET_PATH !== socketPath) {
  const text = readFileSync(file,'utf8').replace(/^DOCKER_(?:GID|SOCKET_PATH)=.*\n?/gm,'');
  writeFileSync(file, text+'\nDOCKER_SOCKET_PATH='+socketPath+'\n',{mode:0o600});
}
const args=['compose','-f','docker-compose.yml','-f','docker-compose.browser.yml'];
for (const command of [['build','web','browser-image'],
  // Initialize the shared encryption key as the app user before the local operator
  // can wrap a browser snapshot. No key values leave the process.
  ['run','--rm','--no-deps','web','node','--import','tsx','--input-type=module','-e',
    'import {fileKeyWrapper} from "@tabductor/secrets";const key=Buffer.alloc(32);await fileKeyWrapper("/app/data/secrets-kek.json").wrap(key);key.fill(0);'],
  ['up','-d']]) {
 const result=spawnSync('docker',[...args,...command],{stdio:'inherit',cwd:new URL('../../',import.meta.url)});
 if(result.status!==0)process.exit(result.status??1);
}
console.log('Tabductor with managed local browsers: http://localhost:3000');
