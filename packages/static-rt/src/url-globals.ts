import ivm from "isolated-vm";

const urlFields = ["href", "origin", "protocol", "username", "password", "host", "hostname", "port", "pathname", "search", "hash"] as const;

/** Use Node's URL parser without transferring host objects or constructors into the
 * isolate. Only bounded JSON strings cross this synchronous, data-only bridge. */
export async function installUrlGlobals(context: ivm.Context, timeout: number): Promise<void> {
  let calls = 0, totalChars = 0;
  const parse = new ivm.Callback((wire: string): string => {
    if (typeof wire !== "string" || wire.length > 65_536 || ++calls > 10_000 || (totalChars += wire.length) > 4_000_000) {
      return JSON.stringify({ error: "URL parsing budget exceeded" });
    }
    try {
      const request = JSON.parse(wire);
      let value: unknown;
      if (request.kind === "url") {
        const url = new URL(request.input, request.base);
        if (request.field !== undefined) {
          if (!urlFields.includes(request.field) || request.field === "origin") throw new TypeError("Invalid URL field");
          url[request.field as Exclude<typeof urlFields[number], "origin">] = request.value;
        }
        value = Object.fromEntries(urlFields.map(field => [field, url[field]]));
      } else if (request.kind === "params") {
        const params = new URLSearchParams(request.input);
        switch (request.operation) {
          case undefined: break;
          case "append": params.append(request.name, request.value); break;
          case "delete": params.delete(request.name, request.value); break;
          case "set": params.set(request.name, request.value); break;
          case "sort": params.sort(); break;
          default: throw new TypeError("Invalid URLSearchParams operation");
        }
        value = { entries: [...params], text: params.toString() };
      } else throw new TypeError("Invalid URL operation");
      const result = JSON.stringify({ value });
      return result.length <= 1_000_000 ? result : JSON.stringify({ error: "URL result exceeds 1 MB" });
    } catch {
      // Throw a guest TypeError below, never transfer a host Error or its prototype.
      return JSON.stringify({ error: "Invalid URL or URLSearchParams input" });
    }
  });
  await context.evalClosure(URL_GLOBALS, [parse, JSON.stringify(urlFields)], { timeout });
}

// Executed verbatim in the guest; all classes, accessors and iterators belong to it.
const URL_GLOBALS = String.raw`
const bridge = $0;
const fields = JSON.parse($1);
const parse = request => {
  const wire = JSON.stringify(request);
  if (wire.length > 65536) throw new TypeError('URL input exceeds 65536 characters');
  const result = JSON.parse(bridge(wire));
  if (result.error) throw new TypeError(result.error);
  return result.value;
};
const urls = new WeakMap(), queries = new WeakMap();
const query = (self, operation, name, value) => {
  const state = queries.get(self);
  const result = parse({kind: 'params', input: state.read(), operation, name, value});
  if (operation) state.write(result.text);
  return result;
};
class URLSearchParams {
  constructor(init = '') {
    if (init !== null && typeof init === 'object') {
      init = typeof init[Symbol.iterator] === 'function'
        ? Array.from(init, pair => {
            const values = Array.from(pair, String);
            if (values.length !== 2) throw new TypeError('Expected a name/value pair');
            return values;
          })
        : Object.fromEntries(Object.entries(init).map(([key, value]) => [key, String(value)]));
    } else init = init == null ? '' : String(init);
    let text = parse({kind: 'params', input: init}).text;
    queries.set(this, {read: () => text, write: value => { text = value; }});
  }
  get size() { return query(this).entries.length; }
  append(name, value) { query(this, 'append', String(name), String(value)); }
  delete(name, value) { query(this, 'delete', String(name), value === undefined ? undefined : String(value)); }
  set(name, value) { query(this, 'set', String(name), String(value)); }
  sort() { query(this, 'sort'); }
  get(name) { return this.getAll(name)[0] ?? null; }
  getAll(name) {
    name = String(name);
    return query(this).entries.filter(pair => pair[0] === name).map(pair => pair[1]);
  }
  has(name, value) { return value === undefined ? this.getAll(name).length > 0 : this.getAll(name).includes(String(value)); }
  *entries() {
    for (let index = 0; ; index++) {
      const entry = query(this).entries[index];
      if (!entry) return;
      yield entry;
    }
  }
  *keys() { for (const [key] of this) yield key; }
  *values() { for (const [, value] of this) yield value; }
  [Symbol.iterator]() { return this.entries(); }
  forEach(callback, thisArg) { for (const [key, value] of this) callback.call(thisArg, value, key, this); }
  toString() { return query(this).text; }
}
class URL {
  constructor(input, base = undefined) {
    const value = parse({kind: 'url', input: String(input), base: base === undefined ? undefined : String(base)});
    const params = new URLSearchParams();
    urls.set(this, {value, params});
    queries.set(params, {read: () => this.search, write: value => { this.search = value; }});
  }
  get searchParams() { return urls.get(this).params; }
  toString() { return this.href; }
  toJSON() { return this.href; }
  static canParse(input, base) { return URL.parse(input, base) !== null; }
  static parse(input, base) { try { return new URL(input, base); } catch { return null; } }
}
for (const field of fields) {
  Object.defineProperty(URL.prototype, field, {
    enumerable: true, configurable: true,
    get() { return urls.get(this).value[field]; },
    ...(field === 'origin' ? {} : {set(value) {
      const state = urls.get(this);
      state.value = parse({kind: 'url', input: state.value.href, field, value: String(value)});
    }}),
  });
}
Object.defineProperty(URL.prototype, Symbol.toStringTag, {value: 'URL'});
Object.defineProperty(URLSearchParams.prototype, Symbol.toStringTag, {value: 'URLSearchParams'});
Object.defineProperties(globalThis, {
  URL: {value: URL, configurable: true, writable: true},
  URLSearchParams: {value: URLSearchParams, configurable: true, writable: true},
});
`;
