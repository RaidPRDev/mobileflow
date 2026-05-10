const path = require("node:path");
const fs = require("node:fs");
const { rspack } = require("@rspack/core");
const ReactRefreshPlugin = require("@rspack/plugin-react-refresh");

const isDev = process.env.NODE_ENV !== "production";

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
  resolve: {
    extensions: ["...", ".ts", ".tsx"],
    alias: { "@": path.resolve(__dirname, "src") },
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
    new rspack.HtmlRspackPlugin({
      template: "./public/index.html",
      title: "MobileFlow",
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
