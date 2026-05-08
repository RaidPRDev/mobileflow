const path = require("node:path");
const { rspack } = require("@rspack/core");
const ReactRefreshPlugin = require("@rspack/plugin-react-refresh");

const isDev = process.env.NODE_ENV !== "production";

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
        test: /\.(png|jpg|jpeg|gif|svg|webp)$/,
        type: "asset",
      },
    ],
  },
  plugins: [
    new rspack.HtmlRspackPlugin({
      template: "./public/index.html",
      title: "MobileFlow Documentation",
    }),
    isDev && new ReactRefreshPlugin(),
  ].filter(Boolean),
  devServer: {
    port: 5174,
    historyApiFallback: true,
    hot: true,
    host: "127.0.0.1",
  },
};
