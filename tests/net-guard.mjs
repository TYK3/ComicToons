// IRC-ENV-1 network guard, loaded with NODE_OPTIONS=--import by tests/playwright.config.ts
// (web servers and workers) and usable for any Node test run. It refuses every non-loopback
// DNS lookup and socket connect and appends one JSON line per attempt (host, port, call site;
// never payloads) to $COMICTOONS_NET_GUARD_LOG. With COMICTOONS_NET_GUARD=fail it also fails
// the process (stderr line and exit code 1), so a dial cannot pass silently.
import fs from 'node:fs';import net from 'node:net';import dns from 'node:dns';
const LOG=process.env.COMICTOONS_NET_GUARD_LOG;
const FAIL=process.env.COMICTOONS_NET_GUARD==='fail';
const loop=h=>h===undefined||h===null||h===''||h==='localhost'||h==='::1'||h==='[::1]'||h==='0.0.0.0'||/^127\./.test(String(h))||/^::ffff:127\./.test(String(h));
const who=()=>process.argv.slice(1).map(s=>String(s).split('/').slice(-2).join('/')).join(' ').slice(0,160);
const site=()=>{const s=(new Error().stack||'').split('\n').slice(3).find(l=>/\/(tests|apps|packages|scripts)\//.test(l)&&!/node_modules|net-guard/.test(l));return s?s.trim().replace(/^.*\/(tests|apps|packages|scripts)\//,'$1/').replace(/\)$/,''):'';};
const rec=(via,host,port)=>{
  if(LOG){try{fs.appendFileSync(LOG,JSON.stringify({t:new Date().toISOString(),pid:process.pid,proc:who(),via,host:String(host),port:port??null,at:site()})+'\n');}catch{/* logging must never break the guarded process */}}
  if(FAIL){process.exitCode=1;try{process.stderr.write(`[net-guard] refused ${via} to non-loopback ${host}${port?`:${port}`:''}\n`);}catch{/* logging must never break the guarded process */}}
};
const refuse=(via,host,port,code)=>{rec(via,host,port);const e=new Error(`net-guard refused ${via} to non-loopback ${host}`);e.code=code||'ECONNREFUSED';return e;};
const origLookup=dns.lookup;
dns.lookup=function(host,opts,cb){if(typeof opts==='function'){cb=opts;opts={};}if(!loop(host)&&!net.isIP(host)){const e=refuse('dns.lookup',host,undefined,'ENOTFOUND');return process.nextTick(()=>cb(e));}return origLookup.call(this,host,opts,cb);};
if(dns.promises){const pl=dns.promises.lookup;dns.promises.lookup=function(host,opts){if(!loop(host)&&!net.isIP(host))return Promise.reject(refuse('dns.promises.lookup',host,undefined,'ENOTFOUND'));return pl.call(this,host,opts);};}
const origSockConnect=net.Socket.prototype.connect;
net.Socket.prototype.connect=function(...args){let o=args[0];if(Array.isArray(o))o=o[0];
  let host,port;if(o&&typeof o==='object'){if(o.path)return origSockConnect.apply(this,args);host=o.host;port=o.port;}else if(typeof o==='string'&&isNaN(Number(o))){return origSockConnect.apply(this,args);}else{port=o;host=typeof args[1]==='string'?args[1]:undefined;}
  if(!loop(host)){const e=refuse('net.Socket.connect',host,port);process.nextTick(()=>this.destroy(e));return this;}
  return origSockConnect.apply(this,args);};
