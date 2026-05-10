// Suppresses deprecation warnings emitted by transitive dependencies that we
// can't fix without upstream releases. We narrowly filter specific codes so
// warnings originating in our own code still surface.
const SILENCED = new Set([
  "DEP0040", // `punycode` module is deprecated (transitive: tr46/whatwg-url/etc.)
  "DEP0060", // util._extend is deprecated (transitive: spdy via webpack-dev-server)
]);
const originalEmit = process.emit;
process.emit = function (name, data, ...rest) {
  if (name === "warning" && data && SILENCED.has(data.code)) return false;
  return originalEmit.call(this, name, data, ...rest);
};
