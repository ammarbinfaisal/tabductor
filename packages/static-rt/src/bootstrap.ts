/**
 * The JavaScript that builds `ctx` **inside** the isolate.
 *
 * It is a string rather than a module because it is compiled by `isolated-vm` into a different
 * JS realm — nothing in this file's own scope is reachable from it, and nothing in it is
 * reachable from here except through the one reference it is handed.
 *
 * The whole surface routes through a single host dispatch function keyed by a path string,
 * rather than dozens of injected references. That keeps the crossing in one place (one
 * argument-copy policy, one promise policy, one error shape) and makes the surface trivially
 * enumerable — which is what the registry-isolation test walks.
 *
 * `guard.all` and `guard.failures` are implemented **here**, guest-side, for a reason worth
 * stating: `all` takes an array of un-awaited promises (§11's template builds exactly that and
 * passes it without awaiting), and a promise cannot cross the isolate boundary. So the guest
 * awaits them and reports the resulting booleans to the host, which correlates them with the
 * checks it logged in call order and keeps the failure detail.
 */
export const BOOTSTRAP = `
(function (dispatch) {
  function call(path, args) {
    return dispatch.apply(undefined, [path, args], {
      arguments: { copy: true },
      result: { promise: true, copy: true },
    });
  }

  const page = {
    goto: (url) => call("page.goto", [url]),
    click: (selector) => call("page.click", [selector]),
    type: (selector, text) => call("page.type", [selector, text]),
    scroll: (direction) => call("page.scroll", [direction]),
    waitFor: (selector, opts) => call("page.waitFor", [selector, opts]),
    query: (selector) => call("page.query", [selector]),
    evalExtract: (selector, fields) => call("page.evalExtract", [selector, fields]),
    screenshot: () => call("page.screenshot", []),
    upload: (anchor, assetRef) => call("page.upload", [anchor, assetRef]),
    url: () => call("page.url", []),
  };

  // The §11 template writes its url guard with a RegExp literal, and a RegExp cannot cross
  // the isolate boundary by copy — it would arrive as an empty object. Flattening to source
  // text here keeps that template working verbatim, which matters because it is exactly what
  // S6b's compiler is prompted to emit.
  function patternOf(p) {
    return p instanceof RegExp ? p.source : String(p);
  }

  const guard = {
    url: (pattern) => call("guard.url", [patternOf(pattern)]),
    exists: (selector, opts) => call("guard.exists", [selector, opts]),
    text: (selector, matcher) => call("guard.text", [selector, patternOf(matcher)]),
    noDialog: () => call("guard.noDialog", []),
    async all(checks) {
      const list = Array.isArray(checks) ? checks : [checks];
      // A rejected check counts as a failed check, never as a thrown script: a guard whose
      // selector is gone is exactly the situation guards exist to detect.
      const results = await Promise.all(
        list.map((c) => Promise.resolve(c).then((v) => v === true, () => false)),
      );
      return call("guard.__settle", [results]);
    },
    failures: () => call("guard.failures", []),
  };

  const network = {
    list: (opts) => call("network.list", [opts]),
    read: (index, parts) => call("network.read", [index, parts]),
  };

  const state = {
    get: (key) => call("state.get", [key]),
    set: (key, value) => call("state.set", [key, value]),
  };

  return {
    page,
    guard,
    network,
    state,
    emit: (type, packet) => call("emit", [type, packet]),
    emitIfNew: (type, packet, opts) => call("emitIfNew", [type, packet, opts]),
    deopt: (prompt, evidence) => call("deopt", [prompt, evidence]),
  };
})
`;
