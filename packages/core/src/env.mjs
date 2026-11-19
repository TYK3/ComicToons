/** Read the current setting first. Remove the legacy prefix fallback after one release. */
export function readProductEnv(name, env = process.env) {
  return env[name] ?? env[name.replace(/^COMICTOONS_/, 'PANELCAST_')];
}
