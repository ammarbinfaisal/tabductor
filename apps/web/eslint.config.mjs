import parser from "@typescript-eslint/parser";

/**
 * The React hook policy (`docs/subphases/ROADMAP.md`), as a lint rule rather than a
 * convention. Everything — useState, useMemo, useEffect, any custom `useThing` — is banned
 * except three sanctioned calls, so client state has to live in the vanilla stores U0
 * builds and data has to come from server components or the vanilla tRPC client.
 *
 * The three are `useMountHook` (mount + cleanup), `useStoreBridge` (the documented U0
 * store-subscription exemption) and `usePolling` (that exemption's interval form). All
 * three are *defined* in the two files exempted below, which are the only places a real
 * React hook is imported.
 */
const SANCTIONED = ["useMountHook", "useStoreBridge", "usePolling"];
const HOOK_CALL = `CallExpression[callee.name=/^use[A-Z]/]${SANCTIONED.map(
  (name) => `:not([callee.name='${name}'])`,
).join("")}`;

export default [
  {
    files: ["**/*.ts", "**/*.tsx"],
    languageOptions: {
      parser,
      parserOptions: { ecmaVersion: "latest", sourceType: "module", ecmaFeatures: { jsx: true } },
    },
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: HOOK_CALL,
          message:
            "React hook policy: useMountHook is the only hook allowed. Put client state in a vanilla store (src/lib/store.tsx).",
        },
        {
          selector: "MemberExpression[object.name='React'][property.name=/^use[A-Z]/]",
          message: "React hook policy: useMountHook is the only hook allowed.",
        },
      ],
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "react",
              importNames: [
                "useState",
                "useEffect",
                "useMemo",
                "useCallback",
                "useReducer",
                "useRef",
                "useContext",
                "useSyncExternalStore",
                "useTransition",
                "useDeferredValue",
                "useLayoutEffect",
              ],
              message:
                "React hook policy: import useMountHook from src/lib/use-mount-hook.js instead.",
            },
          ],
        },
      ],
      "no-console": ["error", { allow: ["error"] }],
    },
  },
  {
    // The two files the policy is defined in terms of.
    files: ["src/lib/use-mount-hook.ts", "src/lib/store.tsx"],
    rules: { "no-restricted-syntax": "off", "no-restricted-imports": "off" },
  },
];
