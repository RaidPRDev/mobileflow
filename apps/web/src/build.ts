// App build identity, embedded at bundle time from the ROOT package.json
// (see rspack.config.cjs DefinePlugin). buildNumber/date/type are bumped by
// infra/scripts/bump-build.mjs on every production deploy.
export const appBuild = __APP_BUILD__;

// Version, then number, then type — e.g. "v0.0.0 (12) beta".
export const appBuildLabel = `v${appBuild.version} (${appBuild.number}) ${appBuild.type}`;
