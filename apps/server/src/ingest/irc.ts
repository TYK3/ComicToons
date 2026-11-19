import {connect} from 'node:tls';
import {connect as connectPlain} from 'node:net';
import {StringDecoder} from 'node:string_decoder';
import {setTimeout,clearTimeout} from 'node:timers';
import {randomInt,randomBytes,createHash} from 'node:crypto';
import {safeText, type StreamEvent} from '@comictoons/core';

export type IrcStatus = 'connecting' | 'empty' | 'unauthenticated' | 'unreachable' | 'disconnected' | 'paused';
export interface ChatAdapter {
  readonly simulated?: boolean;
  start(callbacks: {event: (event: StreamEvent) => void; status: (status: IrcStatus, retrying?: boolean) => void}): void;
  stop(): void;
}
export type AdapterFactory = (channel: string) => ChatAdapter;
export interface IrcTransport {write(frame: string): void; close(): void}
export type IrcTransportFactory = (handlers: {open: () => void; data: (chunk: Buffer | string) => void; close: () => void; error: () => void}) => IrcTransport;
/** Small socket seam for transport tests; the production endpoint stays fixed. */
export interface IrcSocket {
  on(event:'data',listener:(chunk:Buffer|string)=>void):unknown;
  on(event:'error'|'close',listener:()=>void):unknown;
  setTimeout(ms:number,listener?:()=>void):unknown;
  removeAllListeners():unknown;
  write(frame:string):unknown;
  destroy():unknown;
}
/** Returns a cancellation function, allowing virtual time without a real socket. */
export type IrcSchedule = (run:()=>void,delayMs:number)=>()=>void;
const scheduleRetry:IrcSchedule=(run,delay)=>{const timer=setTimeout(run,delay);timer.unref();return ()=>clearTimeout(timer);};
export const validChannel = (channel: string) => /^[a-z0-9_]{1,25}$/.test(channel);

/** Socket binding for the production transport; no chat-posting interface. */
export function bindIrcSocket(socket:IrcSocket,handlers:Parameters<IrcTransportFactory>[0]):IrcTransport {
  socket.on('data',handlers.data); socket.on('error',handlers.error); socket.on('close',handlers.close);
  // A quiet IRC channel is healthy. Server PING is answered by the adapter;
  // chat silence is handled separately by the source's Sample Data fallback.
  socket.setTimeout(0);
  return {write(frame) {socket.write(frame);},close() {
    socket.removeAllListeners(); socket.on('error',()=>{}); socket.destroy();
  }};
}
/** Optional endpoint override so a local Twitch fake can stand in for IRC. */
export const IRC_URL_ENV='COMICTOONS_TWITCH_IRC_URL';
export const DEFAULT_IRC_ENDPOINT=Object.freeze({host:'irc.chat.twitch.tv',port:6697,tls:true});
const LOOPBACK=new Set(['localhost','127.0.0.1','::1']);
/** Unset/empty means Twitch. Otherwise only `irc://` (plain) or `ircs://` (TLS)
 * to localhost, 127.0.0.1 or ::1 with an explicit port is honoured; anything
 * else, including another Twitch address, is refused (undefined). */
export function ircEndpoint(env:Readonly<Record<string,string|undefined>>=process.env):{host:string;port:number;tls:boolean}|undefined {
  const raw=env[IRC_URL_ENV];
  if(!raw)return DEFAULT_IRC_ENDPOINT;
  let url:URL;try{url=new URL(raw);}catch{return undefined;}
  const tls=url.protocol==='ircs:';
  if(!tls&&url.protocol!=='irc:')return undefined;
  if(url.username||url.password||url.search||url.hash||(url.pathname!==''&&url.pathname!=='/')||!/^\d{1,5}$/.test(url.port))return undefined;
  const host=url.hostname.replace(/^\[(.*)\]$/,'$1').toLowerCase(),port=Number(url.port);
  if(tls&&host===DEFAULT_IRC_ENDPOINT.host&&port===DEFAULT_IRC_ENDPOINT.port)return DEFAULT_IRC_ENDPOINT;
  return LOOPBACK.has(host)&&port>0&&port<65536?{host,port,tls}:undefined;
}
function dialIrc(env:Readonly<Record<string,string|undefined>>,handlers:Parameters<IrcTransportFactory>[0]):IrcTransport {
  const endpoint=ircEndpoint(env);
  if(!endpoint){console.warn(`[irc] ${IRC_URL_ENV} refused: only a localhost override is allowed`);throw new Error(`${IRC_URL_ENV} refused`);}
  return bindIrcSocket(endpoint.tls
    ?connect({host:endpoint.host,port:endpoint.port,servername:LOOPBACK.has(endpoint.host)?undefined:endpoint.host,rejectUnauthorized:true},handlers.open)
    :connectPlain({host:endpoint.host,port:endpoint.port},handlers.open),handlers);
}
/** Production transport: Twitch over verified TLS, or a permitted local fake.
 * Reads process.env at dial time. A refused override fails closed; it never falls back to Twitch. */
export const twitchTlsTransport:IrcTransportFactory=handlers=>dialIrc(process.env,handlers);
/** Fallback legs implied by an env-bound transport (see ircTransportFor). */
const envFallbacks=new WeakMap<IrcTransportFactory,IrcTransportFactory|undefined>();
/** The 6697 leg bound to an injected env (e.g. createApp's `env` option) instead of
 * process.env. It carries the fallback that env implies: WSS 443 unless the env sets
 * COMICTOONS_TWITCH_IRC_URL, which replaces both legs. */
export function ircTransportFor(env:Readonly<Record<string,string|undefined>>):IrcTransportFactory {
  const transport:IrcTransportFactory=handlers=>dialIrc(env,handlers);
  envFallbacks.set(transport,defaultIrcFallback(env));
  return transport;
}
/** The fallback an env-bound transport implies; undefined for any other transport. */
export function ircFallbackFor(transport:IrcTransportFactory):IrcTransportFactory|undefined {
  return envFallbacks.get(transport);
}

/** Documented Twitch IRC-over-WebSocket chat endpoint (https://dev.twitch.tv/docs/chat/irc/),
 * used only when the 6697 TLS leg cannot connect or welcome. */
export const WSS_IRC_ENDPOINT=Object.freeze({host:'irc-ws.chat.twitch.tv',port:443,path:'/'});
const WS_GUID='258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const WS_MAX_MESSAGE=1_048_576;
/** Minimal RFC 6455 client carrying IRC lines in text frames: masked client frames,
 * ping answered with pong, fragmented and extended-length server frames. Each
 * message may hold several CRLF-delimited IRC lines; the adapter's parser is unchanged. */
export function wsIrcTransport(target:{host:string;port:number;path:string;tls:boolean}):IrcTransportFactory {
  return handlers=>{
    const key=randomBytes(16).toString('base64');
    const expected=createHash('sha1').update(key+WS_GUID).digest('base64');
    const socket=target.tls
      ?connect({host:target.host,port:target.port,servername:LOOPBACK.has(target.host)?undefined:target.host,rejectUnauthorized:true})
      :connectPlain({host:target.host,port:target.port});
    let upgraded=false,done=false,buffer=Buffer.alloc(0),fragments:Buffer[]=[];
    const fail=()=>{if(done)return;done=true;handlers.error();};
    const ended=()=>{if(done)return;done=true;if(upgraded)handlers.close();else handlers.error();};
    const send=(opcode:number,payload:Buffer)=>{
      if(done||payload.length>65_535)return;
      const mask=randomBytes(4),body=Buffer.from(payload);for(let i=0;i<body.length;i++)body[i]!^=mask[i%4]!;
      const head=body.length<126?Buffer.from([0x80|opcode,0x80|body.length]):Buffer.from([0x80|opcode,0x80|126,body.length>>8,body.length&255]);
      socket.write(Buffer.concat([head,mask,body]));
    };
    socket.once(target.tls?'secureConnect':'connect',()=>{
      socket.write(`GET ${target.path} HTTP/1.1\r\nHost: ${target.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n`+
        `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    });
    socket.on('data',(chunk:Buffer)=>{
      if(done)return;
      buffer=Buffer.concat([buffer,chunk]);
      if(!upgraded){
        const at=buffer.indexOf('\r\n\r\n');if(at<0){if(buffer.length>16_384)fail();return;}
        const [status='',...lines]=buffer.subarray(0,at).toString('latin1').split('\r\n');buffer=buffer.subarray(at+4);
        const headers=new Map(lines.map(line=>{const i=line.indexOf(':');return [line.slice(0,i).trim().toLowerCase(),line.slice(i+1).trim()] as const;}));
        if(!/^HTTP\/1\.1 101\b/.test(status)||headers.get('sec-websocket-accept')!==expected||headers.get('upgrade')?.toLowerCase()!=='websocket'){fail();return;}
        upgraded=true;handlers.open();if(done)return;
      }
      while(buffer.length>=2&&!done){
        const fin=(buffer[0]!&0x80)!==0,opcode=buffer[0]!&0x0f;let length=buffer[1]!&0x7f,offset=2;
        if(buffer[1]!&0x80){fail();return;} // A server never masks.
        if(length===126){if(buffer.length<4)return;length=buffer.readUInt16BE(2);offset=4;}
        else if(length===127){if(buffer.length<10)return;const big=buffer.readBigUInt64BE(2);if(big>BigInt(WS_MAX_MESSAGE)){fail();return;}length=Number(big);offset=10;}
        if(buffer.length<offset+length)return;
        const payload=buffer.subarray(offset,offset+length);buffer=buffer.subarray(offset+length);
        if(opcode===0x8){send(0x8,payload.subarray(0,2));ended();return;}
        if(opcode===0x9){send(0xA,payload);continue;}
        if(opcode===0xA)continue;
        if(opcode!==0x1&&opcode!==0x0){fail();return;}
        fragments.push(Buffer.from(payload));
        if(fragments.reduce((n,f)=>n+f.length,0)>WS_MAX_MESSAGE){fail();return;}
        if(!fin)continue;
        const text=Buffer.concat(fragments).toString('utf8');fragments=[];
        handlers.data(text.endsWith('\r\n')?text:`${text}\r\n`);
      }
      if(buffer.length>WS_MAX_MESSAGE+16)fail();
    });
    socket.on('error',fail);socket.on('close',ended);socket.setTimeout(0);
    return {write(frame){send(0x1,Buffer.from(frame,'utf8'));},close(){
      done=true;socket.removeAllListeners();socket.on('error',()=>{});socket.destroy();
    }};
  };
}
export const twitchWssTransport:IrcTransportFactory=wsIrcTransport({...WSS_IRC_ENDPOINT,tls:true});
/** The fallback leg for production: WSS 443, unless COMICTOONS_TWITCH_IRC_URL is set,
 * which replaces both legs (a refused override still fails closed). */
export function defaultIrcFallback(env:Readonly<Record<string,string|undefined>>=process.env):IrcTransportFactory|undefined {
  return env[IRC_URL_ENV]?undefined:twitchWssTransport;
}
/** A 6697 leg that connects but sends no welcome within this window yields to WSS. */
export const WELCOME_TIMEOUT_MS=15_000;
export type IrcTransportName='tls'|'wss';

function unescapeTag(value: string) {
  return value.replace(/\\([s:nr\\])/g,(_match,key: string)=>({s:' ',':':';',n:'\n',r:'\r','\\':'\\'}[key]!));
}
export function parseIrc(line: string) {
  if (!line || line.length > 8192 || /[\r\n\0\uFFFD]/.test(line)) return undefined;
  const match = /^(?:@([^ ]+) )?(?::([^ ]+) )?([A-Z]+|\d{3})(?: (.*))?$/.exec(line);
  if (!match) return undefined;
  const tags: Record<string,string> = Object.create(null);
  for (const pair of (match[1] ?? '').split(';')) {
    const separator = pair.indexOf('=');
    if (separator > 0) tags[pair.slice(0,separator)] = unescapeTag(pair.slice(separator+1));
  }
  const rest = match[4] ?? '';
  const trailing = rest.startsWith(':') ? 0 : rest.indexOf(' :');
  const head = trailing < 0 ? rest : rest.slice(0,trailing);
  return {tags,prefix:match[2] ?? '',command:match[3]!,params:head.split(' ').filter(Boolean),
    text:trailing < 0 ? '' : rest.slice(trailing+(trailing === 0 ? 1 : 2))};
}

/** Step 6 ceiling: no watchdog gap or retry delay may exceed fifteen minutes. */
export const MAX_WAIT_MS=900_000;
/** Half-open detection while connected on either leg: after this long with no
 * inbound line the client sends one PING, and if nothing at all arrives within
 * the deadline the link is treated as dead and reconnected. Server PINGs and
 * chat reset the idle clock, so a busy or Twitch-pinged link never sends one. */
export const LIVENESS_IDLE_MS=60_000;
export const LIVENESS_DEADLINE_MS=15_000;
export const LIVENESS_PING='PING :tmi.twitch.tv';
/** Matches the source's dedup ledger bound. */
const RECENT_LINES=1024;
/** Documented login-failure NOTICE texts (https://dev.twitch.tv/docs/chat/irc/). */
const LOGIN_FAILURE=/^(?:Login authentication failed|Improperly formatted auth)$/i;
/** One redacted line per NOTICE: only the symbolic msg-id, never the text. */
function logNotice(msgId:string|undefined,loginFailure:boolean){
  const id=msgId&&/^[a-z0-9_]{1,64}$/.test(msgId)?msgId:'none';
  console.warn(`[irc] NOTICE msg-id=${id}; ${loginFailure?'login failed, disconnecting':'staying connected'}`);
}

type IrcIdentity={username:string;token:string};
/** Opt-in environment flag for read-only anonymous chat. Off unless exactly "1". */
export const ANON_CHAT_FLAG='COMICTOONS_TWITCH_ANON';
export const anonymousChatEnabled=(env:Readonly<Record<string,string|undefined>>)=>env[ANON_CHAT_FLAG]==='1';
/** Identities minted only by withAnonymousFallback; a hand-made justinfan identity is not anonymous. */
const anonymousIdentities=new WeakSet<object>();
/** Credential callback for the adapter: a signed-in token always wins. Only when
 * none exists and the flag is on does it return Twitch's anonymous read-only
 * login (NICK justinfan<digits>, no PASS). Anonymous sessions cannot post. */
export function withAnonymousFallback(authenticate:(()=>IrcIdentity|undefined)|undefined,enabled:boolean):()=>IrcIdentity|undefined {
  return ()=>{
    const identity=authenticate?.();
    if(identity||!enabled)return identity;
    const anonymous=Object.freeze({username:`justinfan${randomInt(10_000,100_000)}`,token:''});
    anonymousIdentities.add(anonymous);return anonymous;
  };
}
/** Outbound allow-list: this adapter never posts chat in any mode, and an
 * anonymous session never sends PASS. */
const OUTBOUND=/^(?:PASS oauth:[a-zA-Z0-9_-]{1,256}|NICK [a-z0-9_]{1,25}|CAP REQ :twitch\.tv\/tags twitch\.tv\/commands|JOIN #[a-z0-9_]{1,25}|PONG :[a-zA-Z0-9.:-]{1,128}|PING :tmi\.twitch\.tv)$/;

/** Refill ledgers are keyed by channel, not by adapter instance, so they outlive any
 * single TwitchIrcAdapter: ChatSource builds a fresh instance on every connect (e.g.
 * every POST /api/ingest), and an already-spent hourly budget must stay spent across
 * that reconnect, not reset to a fresh ten. */
const refillLedgers=new Map<string,number[]>();
function refillsFor(channel:string):number[] {
  let ledger=refillLedgers.get(channel);
  if(!ledger){ledger=[];refillLedgers.set(channel,ledger);}
  return ledger;
}
/** Test-only reset hook: clears every channel's ledger so cases that reuse a channel
 * name (e.g. 'approved_test') can each start from a clean hourly budget. */
export function resetRefillLedgers():void {refillLedgers.clear();}

/** Credentials are supplied privately by a future owner bootstrap, never by HTTP.
 * Missing credentials fail closed without opening any socket. No auth is read
 * from environment/files here. Protocol text is never logged; a NOTICE logs
 * only its symbolic msg-id. */
export class TwitchIrcAdapter implements ChatAdapter {
  readonly simulated: boolean;
  private transport?: IrcTransport;
  private generation=0;
  private attempt=0;
  private cancelRetry?:()=>void;
  private cancelWatchdog?:()=>void;
  private cancelWelcome?:()=>void;
  private cancelLiveness?:()=>void;
  /** The transport leg of the current or last connection, for status display. */
  transportName?:IrcTransportName;
  /** Ids of lines emitted since start, so CLEARCHAT can withdraw them. A line already
   * withdrawn by a room-wide clear is kept (flagged, not removed): a published panel
   * survives that clear, so a later ban or timeout still needs it to withdraw the line. */
  private recent:{id:string;user:string;login:string;roomCleared?:boolean}[]=[];
  constructor(private options: {channel:string; authenticate?:()=>{username:string;token:string}|undefined;
    transport?:IrcTransportFactory; fallbackTransport?:IrcTransportFactory; now?:()=>number; schedule?:IrcSchedule; simulated?:boolean}) {this.simulated=options.simulated ?? false;}
  start(callbacks: {event:(event:StreamEvent)=>void;status:(status:IrcStatus,retrying?:boolean)=>void}) {
    this.stop(); const generation=this.generation;this.recent=[];
    if (!validChannel(this.options.channel)) throw new Error('Enter a valid Twitch channel name.');
    const now=this.options.now ?? Date.now; const started=now();
    const current=()=>generation===this.generation;
    let retries=0,welcomedAt:number|undefined;
    // Two legs: TLS 6697, then WSS 443 once TLS has failed before any welcome.
    // The switch is sticky for this start and goes through retry(), so the
    // backoff, retry count and episode budget are exactly those of one leg.
    const fallback=this.options.transport?(this.options.fallbackTransport??ircFallbackFor(this.options.transport)):defaultIrcFallback();
    let onFallback=false,primaryWelcomed=false;
    // Episode ceiling: the budget for one reconnect episode, from its first
    // failure after a healthy link to giving up. Recovery (below) clears it.
    let episodeStart:number|undefined;
    const episodeLeft=()=>episodeStart===undefined?MAX_WAIT_MS:Math.max(0,MAX_WAIT_MS-(now()-episodeStart));
    const finish=(status:IrcStatus)=>{if(!current())return;this.stop();callbacks.status(status);};
    const pruneRefills=()=>{
      const cutoff=now()-3_600_000,ledger=refillsFor(this.options.channel);
      let kept=0;for(const at of ledger)if(at>cutoff)ledger[kept++]=at;ledger.length=kept;
    };
    const recoverBudget=()=>{
      if(retries===0||welcomedAt===undefined||now()-welcomedAt<60_000)return;
      pruneRefills();
      // Only a spent budget needs a refill; later frames on this socket are free.
      const ledger=refillsFor(this.options.channel);
      if(ledger.length<10){ledger.push(now());retries=0;episodeStart=undefined;}
    };
    const retry=(status:IrcStatus,canRecover=true)=>{
      if(!current())return;
      // A drop can also confirm stability; a welcome alone cannot refill.
      if(canRecover)recoverBudget();
      // The first failure since a reset opens the episode clock.
      episodeStart??=now();
      this.disconnect();
      pruneRefills();if(refillsFor(this.options.channel).length>=10){finish('paused');return;}
      if(episodeLeft()<=0){finish('unreachable');return;}
      if(retries===3){finish(status);return;}
      const delay=Math.min(MAX_WAIT_MS,1000*2**retries++,episodeLeft());
      callbacks.status(status,true);
      if(current())this.cancelRetry=(this.options.schedule??scheduleRetry)(()=>{this.cancelRetry=undefined;if(current())open();},delay);
    };
    const open=()=>{
      welcomedAt=undefined;
      let identity:ReturnType<NonNullable<typeof this.options.authenticate>>;
      try{identity=this.options.authenticate?.();}catch{finish('unauthenticated');return;}
      const anonymous=identity!==undefined&&anonymousIdentities.has(identity)&&/^justinfan\d{5}$/.test(identity.username)&&identity.token==='';
      if(!identity||!validChannel(identity.username)||(!anonymous&&!/^oauth:[a-zA-Z0-9_-]{1,256}$/.test(identity.token))){finish('unauthenticated');return;}
      const attempt=++this.attempt;
      const active=()=>current()&&attempt===this.attempt;
      const viaFallback=onFallback&&fallback!==undefined;let welcomedHere=false;
      this.transportName=viaFallback?'wss':'tls';
      const drop=(status:IrcStatus,canRecover=true)=>{
        if(!active())return;
        if(!viaFallback&&!welcomedHere&&!primaryWelcomed&&fallback&&!onFallback){
          onFallback=true;console.warn('[irc] TLS 6697 failed before welcome; falling back to WSS 443');
        }
        retry(status,canRecover);
      };
      let frameSequence=0,watchdogMs=600_000; // Spec's ten-minute bootstrap before two PINGs.
      let lastPingAt:number|undefined;
      const armWatchdog=()=>{
        const watched=++frameSequence;this.cancelWatchdog?.();
        // Mid-episode, the gap itself is clipped to whatever budget remains,
        // so a half-open stall can never outlast the fifteen-minute episode.
        this.cancelWatchdog=(this.options.schedule??scheduleRetry)(()=>{
          if(!active()||watched!==frameSequence)return;
          // A silent half-open link cannot refill its budget by waiting.
          this.cancelWatchdog=undefined;drop('unreachable',false);
        },Math.min(watchdogMs,episodeLeft()));
      };
      // Liveness runs only after the welcome; before it, the bootstrap watchdog
      // and welcome timeout decide. Both stages are clipped to the episode budget.
      let livenessSequence=0;
      const armLiveness=()=>{
        if(welcomedAt===undefined)return;
        const armed=++livenessSequence;this.cancelLiveness?.();
        const schedule=this.options.schedule??scheduleRetry;
        this.cancelLiveness=schedule(()=>{
          if(!active()||armed!==livenessSequence)return;
          write(LIVENESS_PING);
          this.cancelLiveness=schedule(()=>{
            if(!active()||armed!==livenessSequence)return;
            // No reply and no other line: a dead link cannot refill its budget.
            this.cancelLiveness=undefined;drop('unreachable',false);
          },Math.min(LIVENESS_DEADLINE_MS,episodeLeft()));
        },Math.min(LIVENESS_IDLE_MS,episodeLeft()));
      };
      const decoder=new StringDecoder('utf8');let pending='',authenticated=false,joined=false,reconnect=false;
      const write=(frame:string)=>{if(active()&&OUTBOUND.test(frame)&&!(anonymous&&frame.startsWith('PASS ')))this.transport?.write(`${frame}\r\n`);};
      const consume=(line:string)=>{
        const message=parseIrc(line);if(!message)return;
        // Any parsed inbound frame, including PING, can confirm sixty seconds
        // of recovery and refill the spent budget, not only a later drop.
        recoverBudget();
        // Every parsed line, a PONG to our own PING included, restarts the idle
        // clock and cancels a pending deadline. A PONG never touches the watchdog cadence.
        armLiveness();
        if (message.command==='PING' && /^[a-zA-Z0-9.:-]{1,128}$/.test(message.text)) {
          const received=now();
          if(lastPingAt!==undefined&&received>lastPingAt)watchdogMs=Math.min(MAX_WAIT_MS,2*(received-lastPingAt));
          lastPingAt=received;armWatchdog();write(`PONG :${message.text}`);return;
        }
        armWatchdog();
        // Only a login failure ends the session; Twitch closes that socket
        // itself. Every other NOTICE reports an action outcome and is benign.
        if (message.command==='NOTICE') {
          const loginFailure=LOGIN_FAILURE.test(message.text.trim())||(!authenticated&&message.params[0]==='*'&&/auth|login/i.test(message.text));
          logNotice(message.tags['msg-id'],loginFailure);
          if(loginFailure)finish('unauthenticated');
          return;
        }
        // Drain every complete frame already in this chunk before replacing the
        // socket. Partial frames never cross connection boundaries.
        if (message.command==='RECONNECT') {reconnect=true;return;}
        if (message.command==='001' || message.command==='GLOBALUSERSTATE') {
          if(message.command==='001'&&welcomedAt===undefined){
            welcomedAt=now();this.cancelWelcome?.();this.cancelWelcome=undefined;
            if(!welcomedHere)console.info(`[irc] welcomed via ${this.transportName}`);
            welcomedHere=true;if(!viaFallback)primaryWelcomed=true;armLiveness();
          }
          authenticated=true;
          if(!joined){joined=true;write(`JOIN #${this.options.channel}`);callbacks.status('empty');}
          return;
        }
        // Twitch moderation removal is a privacy withdrawal, including for
        // already queued/approved lines. No outbound chat command is used.
        // CLEARCHAT with a user (ban/timeout) withdraws that user's lines;
        // without one (/clear) it withdraws every line emitted so far.
        if(authenticated&&message.command==='CLEARCHAT'&&message.params[0]===`#${this.options.channel}`){
          const targetUser=message.tags['target-user-id'],targetLogin=message.text.trim().toLowerCase();
          const whole=!targetUser&&!targetLogin;
          const cleared=this.recent.filter(line=>whole?!line.roomCleared:(targetUser?line.user===targetUser:line.login===targetLogin));
          // A room-wide clear only flags its lines: Studio spares the published panel,
          // so the line must stay findable here for a later targeted withdrawal. A
          // targeted clear (ban/timeout) is narrower and is done with its lines for good.
          if(whole)for(const line of cleared)line.roomCleared=true;
          else this.recent=this.recent.filter(line=>!cleared.includes(line));
          const t=Math.max(0,(now()-started)/1000);
          // Young's ruling: a ban or timeout drops only that user's earlier lines
          // and is never an opt-out, so their later chat is still eligible.
          // A room-wide clear is marked so Studio leaves already published panels as they are.
          for(const line of cleared){if(!current())return;callbacks.event({type:'chat',t,text:'',withdraw:'message',targetId:line.id,moderator:true,...(whole?{scope:'room' as const}:{})});}
          return;
        }
        // A single deleted line is narrower than a withdrawal: only that
        // message id leaves the studio, not the whole user's history.
        if(authenticated&&message.command==='CLEARMSG'&&message.params[0]===`#${this.options.channel}`&&message.tags['target-msg-id']){
          this.recent=this.recent.filter(line=>line.id!==message.tags['target-msg-id']);
          callbacks.event({id:message.tags.id,type:'chat',t:Math.max(0,(now()-started)/1000),text:'',withdraw:'message',targetId:message.tags['target-msg-id'],moderator:true});return;
        }
        // A raid notice mirrors the EventSub channel.raid normaliser's shape,
        // so raids still arrive from chat if EventSub is unavailable.
        if(authenticated&&message.command==='USERNOTICE'&&message.params[0]===`#${this.options.channel}`&&message.tags['msg-id']==='raid'){
          const count=message.tags['msg-param-viewerCount'] ?? '';if(!/^\d{1,9}$/.test(count))return;
          const from=safeText(message.tags['msg-param-displayName'] || message.tags['msg-param-login'] || message.tags['display-name'] || '').trim() || 'Anonymous crew';
          callbacks.event({id:message.tags.id,t:Math.max(0,(now()-started)/1000),type:'raid',from,viewers:Number(count)});return;
        }
        if (!authenticated || message.command!=='PRIVMSG' || message.params[0]!==`#${this.options.channel}`)return;
        const text=safeText(message.text).trim();if(!text)return;
        const nick=message.prefix.split('!')[0]!,user=message.tags['user-id'] || nick,login=nick.toLowerCase();
        if(message.tags.id){this.recent.push({id:message.tags.id,user,login});if(this.recent.length>RECENT_LINES)this.recent.shift();}
        // The display name lets participation name a cameo (Ink me via !ink) the way EventSub does.
        const name=safeText(message.tags['display-name'] ?? '').trim() || nick;
        callbacks.event({id:message.tags.id,type:'chat',t:Math.max(0,(now()-started)/1000),
          user,name,text,
          moderator:message.tags.mod==='1' || (message.tags.badges ?? '').includes('broadcaster/1')});
      };
      callbacks.status('connecting');
      if(!active())return;
      armWatchdog();
      if(!viaFallback&&fallback&&!primaryWelcomed&&!onFallback){
        this.cancelWelcome=(this.options.schedule??scheduleRetry)(()=>{
          this.cancelWelcome=undefined;if(active()&&!welcomedHere)drop('unreachable',false);
        },Math.min(WELCOME_TIMEOUT_MS,episodeLeft()));
      }
      try {
        this.transport=(viaFallback?fallback!:(this.options.transport ?? twitchTlsTransport))({
          open:()=>{if(!active())return;if(!anonymous)write(`PASS ${identity!.token}`);write(`NICK ${identity!.username}`);write('CAP REQ :twitch.tv/tags twitch.tv/commands');},
          data:chunk=>{
            if(!active())return;
            pending+=typeof chunk==='string'?chunk:decoder.write(chunk);
            let end:number;
            while((end=pending.indexOf('\r\n'))>=0){const line=pending.slice(0,end);pending=pending.slice(end+2);consume(line);if(!active())return;}
            if(pending.length>16384)finish('unreachable');
            else if(reconnect)drop('disconnected');
          },
          close:()=>drop('disconnected'),error:()=>drop('unreachable'),
        });
      } catch {drop('unreachable');}
    };
    pruneRefills();if(refillsFor(this.options.channel).length>=10)finish('paused');else open();
  }
  private disconnect(){this.attempt++;this.cancelWatchdog?.();this.cancelWatchdog=undefined;this.cancelWelcome?.();this.cancelWelcome=undefined;this.cancelLiveness?.();this.cancelLiveness=undefined;const transport=this.transport;this.transport=undefined;try{transport?.close();}catch{/* Teardown never blocks fallback. */}}
  stop() {this.generation++;this.cancelRetry?.();this.cancelRetry=undefined;this.disconnect();}
}
