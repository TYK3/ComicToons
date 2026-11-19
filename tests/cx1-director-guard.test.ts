import assert from 'node:assert/strict';
import test from 'node:test';
import {channel} from 'node:diagnostics_channel';
import type {FastifyInstance} from 'fastify';
import {createApp as buildApp} from '../apps/server/src/app.ts';

// The initialization channel lets the test install onRoute before buildApp registers its own routes.
test('CX1-DIRECTOR: every non-GET/HEAD API route denies a remote caller without a director header',async()=>{
  for(const configured of [false,true]){
    const routes=new Map<string,{method:string;url:string}>();
    const initialization=channel('fastify.initialization');
    const collect=(message:unknown)=>{
      const {fastify}=message as {fastify:FastifyInstance};
      fastify.addHook('onRoute',route=>{
        const methods=Array.isArray(route.method)?route.method:[route.method];
        for(const method of methods)if(!['GET','HEAD'].includes(method)&&route.url.startsWith('/api/'))routes.set(`${method} ${route.url}`,{method,url:route.url});
      });
    };
    initialization.subscribe(collect);
    const app=(()=>{try{return buildApp({env:{COMICTOONS_PARTICIPATION_MOCK:'1',...(configured?{COMICTOONS_DIRECTOR_KEY:'cx1-fake-director-secret'}:{})},logger:false});}finally{initialization.unsubscribe(collect);}})();
    try{
      await app.ready();
      assert.ok(routes.has('POST /api/recaps'));assert.ok(routes.has('POST /api/end'));
      assert.ok(routes.has('POST /api/participation/mock-event'));assert.ok(routes.has('POST /api/participation/mock-connect'));
      assert.ok(routes.size>=26,'capture the complete write surface, including studio routes registered before ready; director/:action is one template');
      for(const route of routes.values()){
        const url=route.url.replace(/:action\b/g,'approve').replace(/:[A-Za-z_][A-Za-z0-9_]*/g,'cx1-example');
        const response=await app.inject({method:route.method as 'POST',url,remoteAddress:'192.168.1.20',payload:{}});
        assert.equal(response.statusCode,configured?401:403,`${route.method} ${route.url}`);
        assert.equal(response.body.includes('cx1-fake-director-secret'),false);
        const wrongKeyResponse=await app.inject({method:route.method as 'POST',url,remoteAddress:'192.168.1.20',headers:{'x-comictoons-director-key':'cx1-wrong-key'},payload:{}});
        assert.equal(wrongKeyResponse.statusCode,configured?401:403,`${route.method} ${route.url} with a wrong director key`);
        assert.equal(wrongKeyResponse.body.includes('cx1-fake-director-secret'),false);
      }
    }finally{await app.close();}
  }
});
