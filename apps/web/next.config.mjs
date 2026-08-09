/** @type {import('next').NextConfig} */
const config = {
  // Workspace packages ship TypeScript source (`exports: "./src/index.ts"`), so Next has to
  // compile them rather than require them.
  transpilePackages: ["@tabductor/core", "@tabductor/db", "@tabductor/bus", "@tabductor/engine"],

  // `pg` loads its native/optional pieces by dynamic require; bundling it breaks that.
  serverExternalPackages: ["pg"],

  // Linting is `pnpm -F web lint` against this app's own flat config — one authority for the
  // React hook policy, rather than Next reaching for a rule set that does not exist here.
  eslint: { ignoreDuringBuilds: true },

  webpack: (webpackConfig) => {
    // Those same packages are NodeNext TypeScript: a sibling module is imported as
    // "./client.js", a file that only exists as "./client.ts" on disk. tsc rewrites the
    // extension, bundlers have to be told to.
    webpackConfig.resolve.extensionAlias = {
      ".js": [".ts", ".tsx", ".js"],
      ".mjs": [".mts", ".mjs"],
    };
    return webpackConfig;
  },
};

export default config;
