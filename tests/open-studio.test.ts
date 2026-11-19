import assert from 'node:assert/strict';
import test from 'node:test';
import {createApp} from '../apps/server/src/app.ts';

test('local sample and Twitch tools open without an access-code session',async()=>{
  const app=createApp({env:{},logger:false});
  try{
    for(const path of ['/api/state','/api/twitch/status','/api/fixtures'])assert.equal((await app.inject(path)).statusCode,200,path);
    for(const path of ['/api/access','/api/access/login','/api/access/logout'])assert.equal((await app.inject({method:path.endsWith('/access')?'GET':'POST',url:path})).statusCode,404,path);
    assert.equal((await app.inject({method:'POST',url:'/api/settings',payload:{speed:10}})).statusCode,200);
    assert.equal((await app.inject({method:'POST',url:'/api/settings',payload:{speed:10},remoteAddress:'203.0.113.9'})).statusCode,403,'existing director protection still applies');
  }finally{await app.close();}
});

test('a configured director key still protects local writes',async()=>{
  const app=createApp({env:{COMICTOONS_DIRECTOR_KEY:'controlled-local-director-key'},logger:false});
  try{
    assert.equal((await app.inject('/api/state')).statusCode,200);
    assert.equal((await app.inject({method:'POST',url:'/api/settings',payload:{speed:10}})).statusCode,401);
    assert.equal((await app.inject({method:'POST',url:'/api/settings',headers:{'x-comictoons-director-key':'controlled-local-director-key'},payload:{speed:10}})).statusCode,200);
  }finally{await app.close();}
});
