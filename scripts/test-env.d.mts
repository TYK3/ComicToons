type Env = Record<string, string | undefined>;
export declare const FORCED_TEST_ENV: Readonly<Record<string, string>>;
export declare const CREDENTIAL_NAME: RegExp;
export declare function scrubbedEnvOverrides(env?: Env): Record<string, string>;
export declare function scrubbedEnv(env?: Env): Env;
export declare function scrubEnvInPlace(env?: Env): void;
