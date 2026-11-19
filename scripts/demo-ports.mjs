import { readProductEnv } from '../packages/core/src/env.mjs';

function resolvePort(name, fallback, env) {
  const port = Number(readProductEnv(name, env) ?? fallback);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`${name} must be an integer from 1 to 65535`);
  return port;
}

export function resolveDemoPorts(env = process.env) {
  return {
    apiPort: resolvePort('COMICTOONS_API_PORT', '3001', env),
    webPort: resolvePort('COMICTOONS_WEB_PORT', '4173', env),
  };
}
