import parser from "@typescript-eslint/parser";

/**
 * The React hook policy (`docs/subphases/ROADMAP.md`), as a lint rule rather than a
 * convention: `useMountHook` is the only hook this codebase may call. Everything else —
 * useState, useMemo, useEffect, any custom `useThing` — is banned, so client state has to
 * live in the vanilla stores U0 builds and data has to come from server components or the
 * vanilla tRPC client.
 *
 * Two files are exempt because they *are* the exemption: `use-mount-hook.ts`, which wraps
 * `useEffect`, and `store.tsx`, whose bridge component is the one documented `forceUpdate`.
 */
const HOOK_CALL =
  "CallExpression[callee.name=/^use[A-Z]/]:not([callee.name='useMountHook']):not([callee.name='useStoreBridge'])";

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
