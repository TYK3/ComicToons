import {test as base,expect,type BrowserContext} from '@playwright/test';
import {mkdtemp} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createApp} from '../apps/server/src/app.ts';

/** Real local HTTP app and a fresh on-disk recap library for each scenario.
 * No persisted user exports are removed or reset to arrange test state. */
export async function routeApp(context:BrowserContext,origin:string){
  await context.route(/\/api\/|\/exports\//,async route=>{
    const url=new URL(route.request().url());
    const response=await route.fetch({url:`${origin}${url.pathname}${url.search}`});
    await route.fulfill({response});
  });
}
export const test=base.extend<{appOrigin:string}>({
  appOrigin:async({baseURL},use)=>{
    if(!baseURL)throw new Error('The frontend base URL is required.');
    const recapDirectory=await mkdtemp(resolve('artifacts/tmp/export-scenario-'));
    // IRC-ENV-1: an injected env, so ambient shell flags (anonymous chat, credentials) cannot
    // turn a fixture app into a live Twitch client; createApp otherwise falls back to process.env.
    const app=createApp({recapDirectory,env:{NODE_ENV:'test'}});
    try{const origin=await app.listen({host:'127.0.0.1',port:0});await use(origin);}
    finally{await app.close();}
  },
  request:async({playwright,appOrigin},use)=>{
    const request=await playwright.request.newContext({baseURL:appOrigin});
    try{await use(request);}finally{await request.dispose();}
  },
  context:async({context,appOrigin},use)=>{await routeApp(context,appOrigin);await use(context);},
});
export {expect};
