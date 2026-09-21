import {cookieAccessOrigin, cookieMatchesHost} from './cookie-access.js';

const code = document.querySelector('#code');
const status = document.querySelector('#status');
const sync = document.querySelector('#sync');
let transfer;
function error(message) { status.textContent = message; }
code.addEventListener('input', () => { transfer = undefined; sync.hidden = true; document.querySelector('#target').textContent = ''; });
document.querySelector('#review').addEventListener('click', async () => {
  transfer = undefined; sync.hidden = true;
  try {
    const grant = JSON.parse(code.value);
    const server = new URL(grant.server);
    if (server.origin !== grant.server || server.username || server.password || !(server.protocol === 'https:' || (server.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(server.hostname)))) throw Error('Use HTTPS for Tabductor, or HTTP on localhost only.');
    if (!/^[A-Za-z0-9_-]{43}$/.test(grant.token) || Date.parse(grant.expiresAt) <= Date.now() || !Number.isFinite(Date.parse(grant.expiresAt))) throw Error('Create a fresh import code in Tabductor.');
    const [tab] = await chrome.tabs.query({active:true,currentWindow:true});
    if (!tab?.id || new URL(tab.url).origin !== grant.origin) throw Error('Open the website named in your import code, then reopen this extension.');
    const cookieOrigin = await cookieAccessOrigin(chrome.cookies, tab.id, grant.origin);
    transfer = { grant, tabId:tab.id, cookieOrigin };
    document.querySelector('#target').textContent = `${grant.origin} → ${grant.profileName} at ${server.origin}` + (cookieOrigin !== grant.origin ? ` (also needs cookie access to ${cookieOrigin})` : '');
    sync.hidden = false; status.textContent = 'Review the website, destination profile and server before allowing the transfer.';
  } catch (e) { error(e instanceof SyntaxError ? 'Paste the complete import code from Tabductor.' : e.message); }
});
sync.addEventListener('click', async () => {
  if (!transfer) return;
  const {grant,tabId,cookieOrigin} = transfer;
  const origins = [...new Set([grant.origin+'/*',cookieOrigin+'/*',grant.server+'/*'])];
  let granted = false;
  sync.disabled = true;
  try {
    // Called directly from this click so optional permissions have a user gesture.
    granted = await chrome.permissions.request({origins});
    if (!granted) throw Error('Website access was not granted. Nothing was copied.');
    const tab = await chrome.tabs.get(tabId);
    if (new URL(tab.url).origin !== grant.origin || Date.parse(grant.expiresAt) <= Date.now()) throw Error('The tab changed or the code expired. Review a fresh transfer.');
    const [{result}] = await chrome.scripting.executeScript({target:{tabId},func:()=>({origin:location.origin,localStorage:Object.keys(localStorage).map(name=>({name,value:localStorage.getItem(name)}))})});
    if (result.origin !== grant.origin) throw Error('The website changed during export. Nothing was sent.');
    const store = (await chrome.cookies.getAllCookieStores()).find(s=>s.tabIds.includes(tabId));
    if (!store) throw Error('Cookie store is unavailable.');
    const partition = await chrome.cookies.getPartitionKey({tabId,frameId:0});
    const cookies = [...await chrome.cookies.getAll({storeId:store.id}), ...await chrome.cookies.getAll({storeId:store.id,partitionKey:partition.partitionKey})];
    const host = new URL(grant.origin).hostname;
    const selected = cookies.filter(c=>cookieMatchesHost(c,host));
    if (selected.some(c=>c.partitionKey)) throw Error('This site uses partitioned cookies. Open this cloud profile and sign in there to preserve its login correctly. Nothing was sent.');
    const payload = {origin:grant.origin,localStorage:result.localStorage,cookies:selected.map(c=>({name:c.name,value:c.value,domain:c.domain,path:c.path,expires:c.session?-1:c.expirationDate,httpOnly:c.httpOnly,secure:c.secure,sameSite:({strict:'Strict',lax:'Lax',no_restriction:'None',unspecified:'Lax'})[c.sameSite]}))};
    const response = await fetch(grant.server+'/api/profile-import',{method:'POST',redirect:'error',credentials:'omit',headers:{'Content-Type':'application/json',Authorization:'Bearer '+grant.token},body:JSON.stringify(payload)});
    const resultBody = await response.json();
    if (!response.ok) throw Error(resultBody.error || 'Import failed.');
    status.textContent = `Imported ${resultBody.cookies} cookies and ${resultBody.localStorageEntries} local storage entries. Open the profile in Tabductor to use them.`;
    code.value = ''; transfer = undefined; sync.hidden = true;
  } catch(e) { error(e.message || 'Transfer failed.'); }
  finally { if (granted) await chrome.permissions.remove({origins}); sync.disabled = false; }
});
