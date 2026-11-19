import { readProductEnv } from '../../../packages/core/src/env.mjs';
import {createApp} from './app.ts';
import {loadEnv} from './env.ts';
loadEnv();
const port=Number(readProductEnv('COMICTOONS_API_PORT') ?? '3001');
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('COMICTOONS_API_PORT must be an integer from 1 to 65535');
const app=createApp();
await app.listen({port,host:'127.0.0.1'});
