import assert from 'node:assert/strict';
import test from 'node:test';
import {FakeTwitch} from '../scripts/twitch-mock/fake-twitch.ts';
import {twitchConfig} from '../apps/server/src/twitch/config.ts';

test('fake OAuth accepts the registered gate-port callback and real scopes without accepting bad clients or redirects',()=>{
  const redirect='http://127.0.0.1:3102/auth/twitch/callback';
  const fake=new FakeTwitch({redirectUris:[redirect]});
  const scopes=twitchConfig({COMICTOONS_FLAG_BOT_REPLIES:'1'}).scopes;
  const invoke=(extra:Record<string,string>={})=>{
    let status=0;let headers:Record<string,string>={};
    const response={writeHead(code:number,values:Record<string,string>){status=code;headers=values;return this;},end(){}};
    const url=new URL('http://127.0.0.1/oauth2/authorize');
    url.search=new URLSearchParams({client_id:fake.clientId,redirect_uri:redirect,response_type:'code',scope:scopes.join(' '),state:'fake-state',...extra}).toString();
    Reflect.get(fake,'authorize').call(fake,url,response);
    return {status,headers};
  };
  const approved=invoke();
  assert.equal(approved.status,302);
  const location=new URL(approved.headers.Location);
  assert.equal(location.origin+location.pathname,redirect);
  assert.equal(location.searchParams.get('scope'),scopes.join(' '));
  assert.equal(location.searchParams.get('state'),'fake-state');
  fake.authorizeMode='deny';
  const denied=invoke();
  assert.equal(denied.status,302);
  assert.equal(new URL(denied.headers.Location).searchParams.get('error'),'access_denied');
  assert.equal(invoke({client_id:'wrong'}).status,400);
  assert.equal(invoke({redirect_uri:'http://127.0.0.1:9/elsewhere'}).status,400);
});
