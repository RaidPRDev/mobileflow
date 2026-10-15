const path = require("node:path");
const fs = require("node:fs");
const { rspack } = require("@rspack/core");
const ReactRefreshPlugin = require("@rspack/plugin-react-refresh");

const isDev = process.env.NODE_ENV !== "production";

// The ROOT package.json is the single source of truth for the app's
// version/build identity (version + buildNumber/buildDate/buildType, bumped
// by infra/scripts/bump-build.mjs on each deploy). Embedded into the bundle
// as the __APP_BUILD__ global (declared in src/globals.d.ts).
const rootPkg = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, "../../package.json"), "utf8")
);

// Product display name — single source of truth for branding.
const { productName } = require("../../packages/shared/brand.json");

function isWsl() {
  if (process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP) return true;
  try {
    const v = fs.readFileSync("/proc/version", "utf8").toLowerCase();
    return v.includes("microsoft") || v.includes("wsl");
  } catch {
    return false;
  }
}
const wsl = isWsl();
if (isDev && wsl) console.log("[rspack] WSL detected — using polling file watcher");

/** @type {import('@rspack/cli').Configuration} */
module.exports = {
  entry: { main: "./src/main.tsx" },
  output: {
    path: path.resolve(__dirname, "dist"),
    filename: isDev ? "[name].js" : "[name].[contenthash].js",
    publicPath: "/",
    clean: true,
  },
  // The stock 244 KiB budget is a mobile-first heuristic for public landing
  // pages; this is an authenticated single-entry admin SPA served from the same
  // host, so it warned on every production build (~1.5 MiB entrypoint) and the
  // noise buried real errors in the deploy log. Budget raised rather than
  // switched off, so a genuine regression still surfaces. Off in dev, where the
  // unminified bundle blows past any threshold and the number means nothing.
  performance: isDev
    ? false
    : {
        hints: "warning",
        maxAssetSize: 2 * 1024 * 1024,
        maxEntrypointSize: 2 * 1024 * 1024,
      },
  resolve: {
    extensions: ["...", ".ts", ".tsx"],
    extensionAlias: {
      ".js": [".ts", ".tsx", ".js"],
      ".mjs": [".mts", ".mjs"],
    },
    alias: {
      "@": path.resolve(__dirname, "src"),
      "@assets": path.resolve(__dirname, "../../assets"),
    },
  },
  module: {
    rules: [
      {
        test: /\.tsx?$/,
        exclude: /node_modules/,
        loader: "builtin:swc-loader",
        options: {
          jsc: {
            parser: { syntax: "typescript", tsx: true },
            transform: {
              react: { runtime: "automatic", development: isDev, refresh: isDev },
            },
          },
        },
        type: "javascript/auto",
      },
      {
        test: /\.less$/,
        use: [
          {
            loader: "less-loader",
            options: {
              lessOptions: {
                math: "always",
                relativeUrls: true,
              },
            },
          },
        ],
        type: "css",
      },
      {
        test: /\.css$/,
        type: "css",
      },
      {
        test: /\.(png|jpg|jpeg|gif|svg|webp|woff2?)$/,
        type: "asset",
      },
    ],
  },
  plugins: [
    new rspack.DefinePlugin({
      __APP_BUILD__: JSON.stringify({
        version: rootPkg.version ?? "0.0.0",
        number: rootPkg.buildNumber ?? 0,
        date: rootPkg.buildDate ?? "",
        type: rootPkg.buildType ?? "beta",
      }),
    }),
    new rspack.HtmlRspackPlugin({
      template: "./public/index.html",
      title: productName,
    }),
    isDev && new ReactRefreshPlugin(),
  ].filter(Boolean),
  devServer: {
    port: 5173,
    historyApiFallback: true,
    hot: true,
    host: "127.0.0.1",
    proxy: [
      {
        context: ["/api"],
        target: "http://127.0.0.1:4000",
        changeOrigin: true,
        ws: true,
      },
    ],
  },
  watchOptions: wsl
    ? { poll: 300, aggregateTimeout: 200, ignored: /node_modules/ }
    : undefined,
};
