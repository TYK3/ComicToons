/** Test-run environment scrub shared by the unit runner (scripts/run-tests.mjs) and the
 * e2e config (tests/playwright.config.ts). An operator shell that exports anonymous chat,
 * the signed-in real-run switch, network art or any provider credential must not reach a
 * test process: those are forced off and every credential-shaped variable is removed. */
export const FORCED_TEST_ENV = Object.freeze({
  COMICTOONS_TWITCH_ANON: '', PANELCAST_TWITCH_ANON: '',
  COMICTOONS_SIGNED_IN_REAL_RUN: '', PANELCAST_SIGNED_IN_REAL_RUN: '',
  COMICTOONS_ART_NETWORK: '0', PANELCAST_ART_NETWORK: '0',
});
/** Client ids/secrets, API keys and tokens, account ids, with optional _2/_3 suffixes. */
export const CREDENTIAL_NAME = /(?:TOKEN|SECRET|API_KEY|CLIENT_ID|ACCOUNT_ID)(?:_\d+)?$/;
/** Overrides to merge over an env: forced flags, plus '' for each credential-shaped name present. */
export function scrubbedEnvOverrides(env = process.env) {
  const overrides = {...FORCED_TEST_ENV};
  for (const name of Object.keys(env)) if (CREDENTIAL_NAME.test(name)) overrides[name] = '';
  return overrides;
}
/** A copy of env with the scrub applied (empty overrides are removed outright). */
export function scrubbedEnv(env = process.env) {
  const result = {...env};
  for (const [name, value] of Object.entries(scrubbedEnvOverrides(env))) {
    if (value === '') delete result[name]; else result[name] = value;
  }
  return result;
}
/** Applies the scrub to env in place (used for the Playwright runner and its workers). */
export function scrubEnvInPlace(env = process.env) {
  const clean = scrubbedEnv(env);
  for (const name of Object.keys(env)) if (!(name in clean)) delete env[name];
  Object.assign(env, clean);
}
