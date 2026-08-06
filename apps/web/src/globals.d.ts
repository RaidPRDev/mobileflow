// Injected at bundle time by rspack DefinePlugin from the ROOT package.json
// (version + buildNumber/buildDate/buildType). See apps/web/rspack.config.cjs.
declare const __APP_BUILD__: {
  version: string;
  number: number;
  date: string;
  type: string;
};

declare module "*.less";
declare module "*.css";
declare module "*.svg" {
  const url: string;
  export default url;
}
declare module "*.png" {
  const url: string;
  export default url;
}
declare module "*.woff2" {
  const url: string;
  export default url;
}
