import assert from 'node:assert/strict';
import {test} from 'node:test';
import {cookieAccessOrigin, cookieMatchesHost} from './cookie-access.js';

test('uses Chrome site resolution when cookie access is already granted', async () => {
  const cookies = {getPartitionKey:async () => ({partitionKey:{topLevelSite:'https://google.co.uk'}})};
  assert.equal(await cookieAccessOrigin(cookies, 1, 'https://accounts.google.co.uk'), 'https://google.co.uk');
});

test('rejects unrelated domains and unexpected API failures', async () => {
  for (const site of ['https://evil.test/', 'http://google.com/', 'https://user@google.com/']) {
    const cookies = {getPartitionKey:async () => {throw Error(`No host permissions for cookies at url: "${site}".`);}};
    await assert.rejects(cookieAccessOrigin(cookies, 1, 'https://www.google.com'), /Could not determine cookie access/);
  }
  const cookies = {getPartitionKey:async () => {throw Error('Invalid `tabId`.');}};
  await assert.rejects(cookieAccessOrigin(cookies, 1, 'https://www.google.com'), /Invalid `tabId`/);
});

test('only includes cookies that apply to the selected hostname', () => {
  assert.equal(cookieMatchesHost({domain:'.google.com', hostOnly:false}, 'www.google.com'), true);
  assert.equal(cookieMatchesHost({domain:'www.google.com', hostOnly:true}, 'www.google.com'), true);
  assert.equal(cookieMatchesHost({domain:'google.com', hostOnly:true}, 'www.google.com'), false);
  assert.equal(cookieMatchesHost({domain:'accounts.google.com', hostOnly:true}, 'www.google.com'), false);
  assert.equal(cookieMatchesHost({domain:'.google.com', hostOnly:false}, 'notgoogle.com'), false);
});

// Exercise the actual popup handlers with Chrome's parent-site permission check.
// No browser account, server, or real cookies are used.
for (const [origin, site, partitioned, denied] of [
  ['https://www.google.com', 'https://google.com', false, false],
  ['https://accounts.google.co.uk', 'https://google.co.uk', false, false],
  ['https://app.notion.com', 'https://notion.com', false, false],
  ['https://www.google.com', 'https://google.com', true, false],
  ['https://www.google.com', 'https://google.com', false, true],
]) {
  test(`popup transfer ${origin}, partitioned=${partitioned}, denied=${denied}`, async () => {
    const grant = {origin, server:'https://tabductor.test', profileName:'Fixture', token:'a'.repeat(43), expiresAt:new Date(Date.now()+60000).toISOString()};
    const elements = new Map();
    const originalGlobals = Object.fromEntries(['document','chrome','fetch'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    let allowed = [];
    let removed;
    let uploaded;
    let partitionChecks = 0;
    const fixtureCookie = {name:'fixture', value:'synthetic', domain:'.'+new URL(site).hostname, path:'/', hostOnly:false, httpOnly:true, secure:true, session:true, sameSite:'lax'};
    globalThis.document = {querySelector(selector) {
      if (!elements.has(selector)) elements.set(selector, {value:'', textContent:'', hidden:false, disabled:false, events:{}, addEventListener(event, handler) {this.events[event] = handler;}});
      return elements.get(selector);
    }};
    globalThis.chrome = {
      tabs:{query:async () => [{id:1, url:origin}], get:async () => ({id:1, url:origin})},
      permissions:{
        request:async ({origins}) => {if (denied) return false; allowed = origins; return true;},
        remove:async ({origins}) => {removed = origins; allowed = []; return true;},
      },
      scripting:{executeScript:async () => [{result:{origin, localStorage:[{name:'fixture', value:'synthetic'}]}}]},
      cookies:{
        getAllCookieStores:async () => [{id:'0', tabIds:[1]}],
        getPartitionKey:async () => {
          partitionChecks++;
          for (const required of [site, origin]) {
            if (!allowed.includes(required+'/*')) throw Error(`No host permissions for cookies at url: "${required}/".`);
          }
          return {partitionKey:{topLevelSite:site, hasCrossSiteAncestor:false}};
        },
        getAll:async (details) => {
          if (details.partitionKey) return partitioned ? [{...fixtureCookie, partitionKey:details.partitionKey}] : [];
          return [fixtureCookie,
            {...fixtureCookie, domain:new URL(site).hostname, hostOnly:true, name:'parent-only'},
            {...fixtureCookie, domain:'unrelated.test', hostOnly:true, name:'unrelated'}];
        },
      },
    };
    globalThis.fetch = async (_url, options) => {
      uploaded = JSON.parse(options.body);
      return {ok:true, json:async () => ({cookies:uploaded.cookies.length, localStorageEntries:uploaded.localStorage.length})};
    };
    try {
      await import(`./popup.js?case=${encodeURIComponent(origin)}-${partitioned}-${denied}`);
      elements.get('#code').value = JSON.stringify(grant);
      await elements.get('#review').events.click();
      assert.equal(elements.get('#sync').hidden, false);
      assert.ok(elements.get('#target').textContent.includes(`cookie access to ${site}`));
      await elements.get('#sync').events.click();
      assert.equal(elements.get('#sync').disabled, false);
      if (denied) {
        assert.equal(uploaded, undefined);
        assert.match(elements.get('#status').textContent, /access was not granted/);
        return;
      }
      assert.equal(partitionChecks, 2);
      assert.deepEqual(removed, [origin+'/*', site+'/*', grant.server+'/*']);
      assert.deepEqual(allowed, []);
      if (partitioned) {
        assert.equal(uploaded, undefined);
        assert.match(elements.get('#status').textContent, /partitioned cookies/);
      } else {
        assert.equal(uploaded.origin, origin);
        assert.deepEqual(uploaded.cookies.map(cookie => cookie.name), ['fixture']);
        assert.match(elements.get('#status').textContent, /Imported 1 cookies/);
      }
    } finally {
      for (const [key, descriptor] of Object.entries(originalGlobals)) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else delete globalThis[key];
      }
    }
  });
}
