// Fake Twitch chat (IRC) server over plain TCP on 127.0.0.1. Line formats come from
// https://dev.twitch.tv/docs/chat/irc/ (see payloads.ts for each builder). It speaks
// only what ComicToons reads: PASS/NICK/CAP, JOIN/PART, PING/PONG, PRIVMSG, CLEARMSG,
// CLEARCHAT, USERNOTICE (raid) and RECONNECT. Tokens are checked, never logged.
import {randomUUID} from 'node:crypto';
import type {Socket} from 'node:net';
import {ircClearchat, ircClearmsg, ircJoin, ircLoginFailed, ircPrivmsg, ircRaidUsernotice, ircWelcome, type TwitchUser} from './payloads.ts';

export interface IrcIdentity { user: TwitchUser; scopes: string[] }
export type IrcAuthenticate = (token: string, nick: string) => IrcIdentity | undefined;
export type IrcLog = (kind: string, detail: Record<string, string | number | boolean | undefined>) => void;

export class IrcClient {
  nick = '';
  token = '';
  authenticated = false;
  caps = new Set<string>();
  channels = new Set<string>();
  received: string[] = [];
  closed = false;
  private pending = '';
  constructor(readonly id: number, readonly socket: Socket, private server: FakeIrc) {
    socket.setEncoding('utf8');
    socket.on('data', chunk => this.onData(String(chunk)));
    socket.on('close', () => { this.closed = true; server.forget(this); });
    socket.on('error', () => undefined);
  }
  get tags() { return this.caps.has('twitch.tv/tags'); }
  send(line: string) { if (!this.closed && !this.socket.destroyed) this.socket.write(`${line}\r\n`); }
  private onData(chunk: string) {
    this.pending += chunk;
    let end: number;
    while ((end = this.pending.indexOf('\n')) >= 0) {
      const line = this.pending.slice(0, end).replace(/\r$/, '');
      this.pending = this.pending.slice(end + 1);
      if (line) this.server.handle(this, line);
    }
    if (this.pending.length > 16_384) this.socket.destroy();
  }
}

export class FakeIrc {
  readonly clients = new Set<IrcClient>();
  private nextId = 1;
  accepting = true;
  /** Inbound commands seen (command word and channel only, never the PASS argument). */
  readonly inbound: {client: number; command: string; arg?: string}[] = [];
  constructor(private options: {authenticate: IrcAuthenticate; roomId: () => string; log: IrcLog}) {}
  attach(socket: Socket) {
    if (!this.accepting) { socket.destroy(); return; }
    const client = new IrcClient(this.nextId++, socket, this);
    this.clients.add(client);
    this.options.log('irc.connect', {client: client.id});
  }
  forget(client: IrcClient) {
    if (this.clients.delete(client)) this.options.log('irc.close', {client: client.id});
  }
  handle(client: IrcClient, line: string) {
    const [command = '', ...rest] = line.split(' ');
    const upper = command.toUpperCase();
    const arg = rest.join(' ');
    this.inbound.push({client: client.id, command: upper, arg: upper === 'PASS' ? undefined : arg});
    this.options.log('irc.inbound', {client: client.id, command: upper});
    if (upper === 'PASS') { client.token = arg.replace(/^oauth:/, ''); return; }
    if (upper === 'CAP') {
      const caps = arg.replace(/^REQ :?/, '').split(' ').filter(Boolean);
      for (const cap of caps) client.caps.add(cap);
      client.send(`:tmi.twitch.tv CAP * ACK :${caps.join(' ')}`);
      return;
    }
    if (upper === 'NICK') { client.nick = arg.trim().toLowerCase(); this.login(client); return; }
    if (upper === 'PING') { client.send(`:tmi.twitch.tv PONG tmi.twitch.tv ${arg}`); return; }
    if (upper === 'PONG') return;
    if (!client.authenticated) return;
    if (upper === 'JOIN') {
      for (const raw of arg.split(',')) {
        const channel = raw.trim().replace(/^#/, '').toLowerCase();
        if (!channel) continue;
        client.channels.add(channel);
        for (const out of ircJoin(client.nick, channel, this.options.roomId(), client.tags)) client.send(out);
        this.options.log('irc.join', {client: client.id, channel});
      }
      return;
    }
    if (upper === 'PART') { client.channels.delete(arg.trim().replace(/^#/, '')); return; }
  }
  private login(client: IrcClient) {
    const identity = client.token ? this.options.authenticate(client.token, client.nick) : undefined;
    if (!identity || identity.user.login !== client.nick || !identity.scopes.includes('chat:read')) {
      this.options.log('irc.auth', {client: client.id, ok: false});
      client.send(ircLoginFailed());
      client.socket.end();
      return;
    }
    client.authenticated = true;
    this.options.log('irc.auth', {client: client.id, ok: true});
    for (const out of ircWelcome(client.nick, identity.user, client.tags)) client.send(out);
  }
  private inChannel(channel: string) { return [...this.clients].filter(c => c.authenticated && c.channels.has(channel)); }
  /** Returns how many joined clients received the line. */
  broadcast(channel: string, build: (client: IrcClient) => string) {
    const targets = this.inChannel(channel);
    for (const client of targets) client.send(build(client));
    return targets.length;
  }
  privmsg(channel: string, chatter: TwitchUser, message: {id?: string; text: string; mod?: boolean; broadcaster?: boolean}) {
    const id = message.id ?? randomUUID();
    const delivered = this.broadcast(channel, c => ircPrivmsg(channel, this.options.roomId(), chatter, {...message, id}, c.tags));
    return {id, delivered};
  }
  clearmsg(channel: string, login: string, targetMsgId: string, text: string) { return this.broadcast(channel, () => ircClearmsg(channel, login, targetMsgId, text)); }
  clearchat(channel: string, target?: {userId: string; login: string; banDuration?: number}) { return this.broadcast(channel, () => ircClearchat(channel, this.options.roomId(), target)); }
  raid(channel: string, raider: TwitchUser, viewers: number) { return this.broadcast(channel, () => ircRaidUsernotice(channel, this.options.roomId(), raider, viewers)); }
  ping() { for (const c of this.clients) if (c.authenticated) c.send('PING :tmi.twitch.tv'); }
  /** RECONNECT then close, as Twitch does before maintenance. */
  reconnect(closeAfterMs = 50) {
    for (const c of this.clients) c.send(':tmi.twitch.tv RECONNECT');
    const timer = setTimeout(() => { for (const c of [...this.clients]) c.socket.end(); }, closeAfterMs);
    timer.unref();
  }
  /** Abrupt network loss for every chat client. */
  dropAll() { for (const c of [...this.clients]) c.socket.destroy(); }
  stop() { this.accepting = false; this.dropAll(); }
}
