import test,{mock} from 'node:test';
import assert from 'node:assert/strict';
import {IRC_URL_ENV,DEFAULT_IRC_ENDPOINT,ircEndpoint,twitchTlsTransport,TwitchIrcAdapter,withAnonymousFallback} from '../apps/server/src/ingest/irc.ts';

test('IRC-URL-DEFAULT: with no override the endpoint is the fixed Twitch TLS address',()=>{
  assert.equal(IRC_URL_ENV,'COMICTOONS_TWITCH_IRC_URL');
  assert.deepEqual(DEFAULT_IRC_ENDPOINT,{host:'irc.chat.twitch.tv',port:6697,tls:true});
  assert.deepEqual(ircEndpoint({}),DEFAULT_IRC_ENDPOINT);
  assert.deepEqual(ircEndpoint({[IRC_URL_ENV]:''}),DEFAULT_IRC_ENDPOINT);
  assert.deepEqual(ircEndpoint({[IRC_URL_ENV]:'ircs://irc.chat.twitch.tv:6697'}),DEFAULT_IRC_ENDPOINT);
});

test('IRC-URL-LOCAL: a localhost, 127.0.0.1 or ::1 override is honoured, in plain or TLS form',()=>{
  assert.deepEqual(ircEndpoint({[IRC_URL_ENV]:'irc://localhost:6667'}),{host:'localhost',port:6667,tls:false});
  assert.deepEqual(ircEndpoint({[IRC_URL_ENV]:'irc://127.0.0.1:4567'}),{host:'127.0.0.1',port:4567,tls:false});
  assert.deepEqual(ircEndpoint({[IRC_URL_ENV]:'ircs://[::1]:6697'}),{host:'::1',port:6697,tls:true});
  assert.deepEqual(ircEndpoint({[IRC_URL_ENV]:'IRC://LOCALHOST:7000/'}),{host:'localhost',port:7000,tls:false});
});

test('IRC-URL-REFUSED: any other host, scheme or shape is refused and the transport fails closed without dialling',()=>{
  for(const value of ['ircs://evil.example:6697','irc://irc.chat.twitch.tv:6667','ircs://irc.chat.twitch.tv:443','ircs://localhost.evil.example:6697',
    'irc://127.0.0.2:6667','irc://0.0.0.0:6667','irc://user@localhost:6667','irc://localhost:6667/path','irc://localhost:6667?x=1','irc://localhost',
    'wss://irc-ws.chat.twitch.tv:443','http://localhost:6667','localhost:6667','not a url'])
    assert.equal(ircEndpoint({[IRC_URL_ENV]:value}),undefined,value);
  const previous=process.env[IRC_URL_ENV];process.env[IRC_URL_ENV]='ircs://evil.example:6697';
  const warn=mock.method(console,'warn',()=>{});
  try{
    const handlers={open:()=>assert.fail('must not open'),data:()=>{},close:()=>{},error:()=>{}};
    assert.throws(()=>twitchTlsTransport(handlers),/refused/);
    assert.deepEqual(warn.mock.calls.map(call=>call.arguments.join(' ')),[`[irc] ${IRC_URL_ENV} refused: only a localhost override is allowed`]);
    // Through the adapter the refusal is an unreachable link, never a silent fallback to Twitch.
    const statuses:string[]=[],jobs:(()=>void)[]=[];
    const adapter=new TwitchIrcAdapter({channel:'approved_test',authenticate:withAnonymousFallback(undefined,true),schedule:run=>{jobs.push(run);return ()=>{};}});
    adapter.start({event:()=>{},status:status=>statuses.push(status)});
    while(jobs.length)jobs.shift()!();
    adapter.stop();
    assert.equal(statuses.at(-1),'unreachable');assert.ok(!statuses.includes('empty'));
  }finally{warn.mock.restore();if(previous===undefined)delete process.env[IRC_URL_ENV];else process.env[IRC_URL_ENV]=previous;}
});
