/** The shared wire contract for exploratory and compiled browser programs. */
export type HelperRevision = { name: string; revision: string; source: string };
export type SdkTerminal = { outcome: "done"; result: unknown } | { outcome: "fail"; reason: string }
  | { outcome: "deopt"; reason: string; evidence?: unknown };
export type SdkOperation = {
  operationId: string; invocationId: string; sequence: number; name: string;
  phase: "started" | "finished"; effect: boolean; args?: unknown; result?: unknown;
  target?: string; durationMs?: number; error?: string;
};

/** Names are generated from the host registry, never a second capability allowlist. */
export const SDK_BOOTSTRAP = `(function(dispatch, names, input, helpers) {
  const freeze = value => {
    if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
    return value;
  };
  const call = async (name, args = {}) => {
    const wire = JSON.stringify({name, args});
    if (wire.length > 1000000) throw new Error('tool arguments exceed 1 MB');
    const result = JSON.parse(await dispatch.apply(undefined, [wire], {
      arguments: {copy:true}, result: {promise:true, copy:true}
    }));
    if (result && result.ok && ['done','fail','run.deopt'].includes(name)) throw new Error('SDK terminal outcome');
    return result;
  };
  const api = {call, input:freeze(input), budget:()=>call('__budget'), yield:()=>call('__yield')};
  // A callable namespace supports both api.emit(args) and api.emit.batch(args).
  const install = name => {
    const path = name === 'done' || name === 'fail' ? ['run',name] : name.split('.');
    let parent = api;
    for (let i=0;i<path.length;i++) {
      const key = path[i];
      if (['__proto__','prototype','constructor'].includes(key)) throw new Error('Invalid SDK name');
      if (!Object.hasOwn(parent,key)) parent[key] = (...args) => call(path.slice(0,i+1).join('.'), ...args);
      if (i===path.length-1) {
        const old = parent[key];
        parent[key] = Object.assign((args)=>call(name,args),old);
      }
      parent = parent[key];
    }
  };
  names.forEach(install);
  api.helpers ??= {};
  let depth = 0;
  api.helpers.call = async (name,args) => {
    const helper = helpers[name];
    if (!helper) throw new Error('Helper unavailable: define it, then invoke it in the next code call');
    if (++depth > 16) { depth--; throw new Error('Helper recursion limit exceeded'); }
    try {
      const receipt = await call('helpers.use',{name,revision:helper.revision});
      if (!receipt.ok) throw new Error(receipt.error);
      return await helper.run(api,args);
    } finally { depth--; }
  };
  const lock = value => {
    if ((typeof value === 'object' && value) || typeof value === 'function') {
      Object.values(value).forEach(lock); Object.freeze(value);
    }
  };
  lock(api);
  return api;
})`;
