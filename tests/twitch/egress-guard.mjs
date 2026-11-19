import net from 'node:net';
import {syncBuiltinESMExports} from 'node:module';
import {connectPort, fetchPort, guardedPorts} from './live-ports.mjs';
const local=host=>host==='localhost'||host==='::1'||host==='[::1]'||(/^127\./.test(host)&&net.isIP(host)===4);
const refuse=()=>{console.error('Mock app attempted non-loopback egress.');process.exit(1);};
// HARNESS-PORT-1: the app child never dials the developer's live app on 3001/4173 either.
const guarded=guardedPorts();
const refuseLive=port=>{console.error(`Mock app attempted to reach live port ${port}.`);process.exit(1);};
const connect=net.Socket.prototype.connect;
net.Socket.prototype.connect=function(...args){
  const normalized=Array.isArray(args[0])?args[0]:args;
  const options=normalized[0];
  const host=typeof options==='object'?options?.host:typeof normalized[1]==='string'?normalized[1]:'127.0.0.1';
  if(!options?.path&&!local(host??'127.0.0.1'))refuse();
  const port=connectPort(args);if(port!==undefined&&guarded.includes(port))refuseLive(port);
  return connect.apply(this,args);
};
const originalFetch=globalThis.fetch;
globalThis.fetch=(input,init)=>{const url=new URL(typeof input==='string'||input instanceof URL?input:input.url);if(!local(url.hostname))refuse();const {port}=fetchPort(input);if(guarded.includes(port))refuseLive(port);return originalFetch(input,init);};
syncBuiltinESMExports();
