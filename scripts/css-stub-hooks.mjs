// Test-only hooks: Vite handles stylesheet and image imports in the app build, Node does not.
// A .css import becomes an empty module; an image or font import becomes its file name as a URL string.
const ASSET = /\.(?:png|jpe?g|webp|gif|avif|svg|woff2?)$/i;
export async function load(url, context, nextLoad) {
  const clean = url.split('?')[0];
  if (clean.endsWith('.css')) return { format: 'module', source: 'export default {};', shortCircuit: true };
  if (ASSET.test(clean)) return { format: 'module', source: `export default ${JSON.stringify('/' + clean.split('/').slice(-1)[0])};`, shortCircuit: true };
  return nextLoad(url, context);
}
