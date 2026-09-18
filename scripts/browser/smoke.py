#!/usr/bin/env python3
"""Real, offline Camoufox acceptance: profile replacement, fencing and private recording.
Uses disposable Docker containers and an in-process fixture. No paid provider requests.
"""
import base64
import io
import json
import subprocess
import tarfile
import time
import urllib.error
import urllib.request
import uuid

HTML = b'''<!doctype html><title>Browser fixture</title><input id="password" type="password"><button id="login" onclick="document.cookie='fixture=logged-in; max-age=3600; path=/';localStorage.setItem('login','yes');location.href='/account'">Log in</button><div id="state"></div><script>document.querySelector('#state').textContent=document.cookie.includes('fixture=logged-in')&&localStorage.getItem('login')==='yes'?'authenticated':'anonymous'</script>'''
names = []
network = 'tabductor-smoke-'+uuid.uuid4().hex[:10]
fixture_name = network+'-fixture'
fixture_url = f'http://{fixture_name}:8085/login'
token = uuid.uuid4().hex

def docker(*args):
    return subprocess.check_output(['docker',*args], text=True).strip()
def worker():
    name = 'tabductor-smoke-'+uuid.uuid4().hex[:10]; names.append(name)
    docker('run','-d','--name',name,'--network',network,'-p','127.0.0.1::8080','--shm-size=1g',
           '-e',f'TABDUCTOR_WORKER_TOKEN={token}','-e','TABDUCTOR_ALLOW_PRIVATE_EGRESS=1','tabductor-browser-worker:local')
    port = json.loads(docker('inspect',name))[0]['NetworkSettings']['Ports']['8080/tcp'][0]['HostPort']
    url=f'http://127.0.0.1:{port}'
    for _ in range(60):
        try:
            urllib.request.urlopen(url+'/healthz',timeout=1).read(); return url
        except (OSError,urllib.error.URLError): time.sleep(0.25)
    raise RuntimeError('worker never became ready')
def rpc(url,path,body=None,method='POST'):
    request=urllib.request.Request(url+path,data=json.dumps(body).encode() if body is not None else None,method=method,
        headers={'Authorization':f'Bearer {token}','X-Tabductor-RPC-Version':'1','Content-Type':'application/json'})
    return json.loads(urllib.request.urlopen(request,timeout=90).read())
def command(url,session,method,page=None,params=None,input_generation=1,command_id=None):
    return rpc(url,f'/v1/sessions/{session}/commands',dict(generation=1,input_generation=input_generation,
        command_id=command_id or str(uuid.uuid4()),method=method,page_id=page,params=params or {}))['value']
def denied(fn):
    try: fn()
    except urllib.error.HTTPError as error:
        assert error.code == 409, error.code
    else: raise AssertionError('stale or duplicate command was accepted')
def fingerprint(snapshot):
    with tarfile.open(fileobj=io.BytesIO(base64.b64decode(snapshot)),mode='r:gz') as archive:
        name=next(m.name for m in archive.getmembers() if m.name.endswith('.tabductor-fingerprint.json'))
        return json.load(archive.extractfile(name))
try:
    docker('network','create',network)
    fixture_code = "import http.server\nHTML = "+repr(HTML)+"\nclass Handler(http.server.BaseHTTPRequestHandler):\n def do_GET(self):\n  self.send_response(200); self.send_header('Content-Type','text/html'); self.end_headers(); self.wfile.write(HTML)\n def log_message(self,*args): pass\nhttp.server.ThreadingHTTPServer(('0.0.0.0',8085),Handler).serve_forever()"
    names.append(fixture_name)
    docker('run','-d','--name',fixture_name,'--network',network,'--entrypoint','python','tabductor-browser-worker:local','-c',fixture_code)
    url=worker()
    rpc(url,'/v1/sessions',dict(session_id='smoke-a',generation=1,profile_dir='profile'))
    page=command(url,'smoke-a','page.create')['page_id']
    command(url,'smoke-a','page.goto',page,{'url':fixture_url})
    evidence=command(url,'smoke-a','page.perceive',page)
    assert evidence['title']=='Browser fixture'
    time.sleep(4.5)
    command(url,'smoke-a','page.insert_text',page,{'selector':'#password','text':'fixture-private-value'})
    command(url,'smoke-a','page.click',page,{'selector':'#login'},command_id='login-once')
    denied(lambda:command(url,'smoke-a','page.click',page,{'selector':'#login'},command_id='login-once'))
    state=command(url,'smoke-a','page.query_all',page,{'selector':'#state','fields':{'state':{}}})
    assert state==[{'state':'authenticated'}],state
    rpc(url,'/v1/sessions/smoke-a/control',dict(generation=1,input_generation=2,owner='human'))
    denied(lambda:command(url,'smoke-a','page.title',page))
    rpc(url,'/v1/sessions/smoke-a/control',dict(generation=1,input_generation=3,owner='ai'))
    assert command(url,'smoke-a','page.title',page,input_generation=3)=='Browser fixture'
    stopped=rpc(url,'/v1/sessions/smoke-a?generation=1',method='DELETE')
    media=rpc(url,'/v1/sessions/smoke-a/recording?after=-1',method='GET')
    assert media['finished']
    assert any(s['status']=='ready' and s.get('bytes') for s in media['segments']), 'no playable recording'
    assert any(s['status']=='private' and 'bytes' not in s for s in media['segments']), 'private interval missing'
    before=fingerprint(stopped['snapshot'])
    replacement=worker()
    rpc(replacement,'/v1/sessions',dict(session_id='smoke-b',generation=1,profile_dir='profile',snapshot=stopped['snapshot']))
    page=command(replacement,'smoke-b','page.create')['page_id']
    command(replacement,'smoke-b','page.goto',page,{'url':fixture_url})
    state=command(replacement,'smoke-b','page.query_all',page,{'selector':'#state','fields':{'state':{}}})
    assert state==[{'state':'authenticated'}],state
    after=rpc(replacement,'/v1/sessions/smoke-b?generation=1',method='DELETE')
    assert fingerprint(after['snapshot'])==before,'fingerprint changed after replacement'
    print('PASS: real Camoufox login/profile replacement, stable fingerprint, perception, duplicate/stale command fencing, takeover/resume, playable/private recording')
finally:
    import sys
    for name in names:
        if sys.exc_info()[0] is not None:
            subprocess.run(['docker','logs','--tail','50',name],stdout=sys.stderr,stderr=sys.stderr)
        subprocess.run(['docker','rm','-f',name],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)

    subprocess.run(['docker','network','rm',network],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
