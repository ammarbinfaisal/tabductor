(function () {
  if (window.__tabductorConsoleBridgeInstalled || window.__browserMcpConsoleBridgeInstalled) {
    return;
  }
  window.__tabductorConsoleBridgeInstalled = true;
  window.__browserMcpConsoleBridgeInstalled = true;

  const methods = ["log", "info", "warn", "error"];

  function serialize(value) {
    try {
      if (typeof value === "string") {
        return value;
      }
      return JSON.stringify(value);
    } catch (_error) {
      return String(value);
    }
  }

  for (const method of methods) {
    const original = console[method];
    console[method] = (...args) => {
      window.postMessage(
        {
          source: "tabductor-page-console",
          entry: {
            level: method,
            args: args.map(serialize),
            timestamp: new Date().toISOString(),
          },
        },
        "*",
      );
      return original.apply(console, args);
    };
  }
})();
