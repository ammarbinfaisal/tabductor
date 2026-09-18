#!/usr/bin/env python3
"""Real, offline Camoufox acceptance: profile replacement, fencing and private recording.
Uses disposable Docker containers and an in-process fixture. No paid provider requests.
"""
import base64
import io
import os
from pathlib import Path
import json
import subprocess
import tarfile
import time
import urllib.error
import urllib.request
import uuid

HTML = b'''<!doctype html><title>Browser fixture</title><input id="password" type="password"><button id="login" onclick="document.cookie='fixture=logged-in; max-age=3600; path=/';localStorage.setItem('login','yes');location.href='/account'">Log in</button><iframe src="/frame"></iframe><button id="popup" onclick="window.open('/popup')">Popup</button><button id="dialog" onclick="alert('fixture dialog')">Dialog</button><div id="state"></div><script>fetch('/api/fixture');document.querySelector('#state').textContent=document.cookie.includes('fixture=logged-in')&&localStorage.getItem('login')==='yes'?'authenticated':'anonymous'</script>'''
names = []
network = 'tabductor-smoke-'+uuid.uuid4().hex[:10]
fixture_name = network+'-fixture'
fixture_url = f'http://{fixture_name}:8085/login'
token = uuid.uuid4().hex

def docker(*args):
    return subprocess.check_output(['docker',*args], text=True).strip()
def worker():
    name = 'tabductor-smoke-'+uuid.uuid4().hex[:10]; names.append(name)
    source_mount = ['-v',str(Path(__file__).resolve().parents[2]/'apps/browser-worker/src')+':/worker/src:ro'] if os.environ.get('TABDUCTOR_BROWSER_SMOKE_SOURCE') == '1' else []
    docker('run','-d',*source_mount,'--name',name,'--network',network,'-p','127.0.0.1::8080','--shm-size=1g',
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
    fixture_code = "import http.server\nHTML = "+repr(HTML)+"""
class Handler(http.server.BaseHTTPRequestHandler):
 def do_GET(self):
  self.send_response(200)
  self.send_header('Content-Type','application/json' if self.path.startswith('/api/') else 'text/html')
  self.end_headers()
  self.wfile.write(b'{"fixture":true}' if self.path.startswith('/api/') else b'<input id="frame-secret" placeholder="Frame secret"><div>Frame content</div>' if self.path=='/frame' else b'<title>Popup fixture</title>Popup' if self.path=='/popup' else HTML)
 def log_message(self,*args): pass
http.server.ThreadingHTTPServer(('0.0.0.0',8085),Handler).serve_forever()
"""
    names.append(fixture_name)
    docker('run','-d','--name',fixture_name,'--network',network,'--entrypoint','python','tabductor-browser-worker:local','-c',fixture_code)
    url=worker()
    rpc(url,'/v1/sessions',dict(session_id='smoke-a',generation=1,profile_dir='profile'))
    page=command(url,'smoke-a','page.create')['page_id']
    command(url,'smoke-a','page.goto',page,{'url':fixture_url})
    evidence=command(url,'smoke-a','page.perceive',page)
    assert evidence['title']=='Browser fixture'
    frame_element=next(el for el in evidence['elements'] if el['name']=='Frame secret')
    probe=command(url,'smoke-a','page.probe',page,{'selector':frame_element['locator']})
    assert probe['tag']=='input' and probe['frameOrigin']==fixture_url.removesuffix('/login'),probe
    time.sleep(4.5)
    command(url,'smoke-a','page.insert_text',page,{'selector':frame_element['locator'],'text':'private-frame-fixture'})
    command(url,'smoke-a','page.click',page,{'selector':'#popup'})
    command(url,'smoke-a','page.click',page,{'selector':'#dialog'})
    for _ in range(50):
        observed=rpc(url,'/v1/sessions/smoke-a/commands',dict(generation=1,input_generation=1,command_id=str(uuid.uuid4()),method='browser.events',params={}))['events']
        if any(e.get('record',{}).get('url','').endswith('/popup') for e in observed):
            break
        time.sleep(0.1)
    assert any(e['kind']=='dialog' for e in observed), 'dialog missing'
    assert any(e.get('record',{}).get('url','').endswith('/popup') and e['page_id']==page for e in observed),str([(e['kind'],e.get('record',{}).get('url')) for e in observed])
    api=next(e for e in observed if e['kind']=='settled' and e['record']['url'].endswith('/api/fixture'))
    body=command(url,'smoke-a','network.part',params={'request_id':api['request_id'],'part':'responseBody'})
    assert json.loads(base64.b64decode(body['bytes']))=={'fixture':True}
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
    print('PASS: real Camoufox login/profile replacement, stable fingerprint, frame secret targeting, popup/dialog/network observations, duplicate/stale command fencing, takeover/resume, playable/private recording')
finally:
    import sys
    for name in names:
        if sys.exc_info()[0] is not None:
            subprocess.run(['docker','logs','--tail','50',name],stdout=sys.stderr,stderr=sys.stderr)
        subprocess.run(['docker','rm','-f',name],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)

    subprocess.run(['docker','network','rm',network],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
