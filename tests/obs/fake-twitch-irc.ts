// Minimal in-memory Twitch IRC fake for the OBS overlay proof. It opens no socket and makes no
// network call: it plugs into the app's existing IrcTransportFactory seam
// (apps/server/src/ingest/irc.ts), so the real TwitchIrcAdapter parses real Twitch IRC lines.
//
// Behaviour follows Twitch's IRC docs (checked 31 Oct 2026):
// - Login (PASS oauth:<token>, then NICK), the 001-376 welcome burst, GLOBALUSERSTATE and
//   "NOTICE * :Login authentication failed": https://dev.twitch.tv/docs/chat/irc/#authenticating-with-the-twitch-irc-server
// - CAP REQ / ACK: https://dev.twitch.tv/docs/chat/irc/#requesting-twitch-capabilities
// - JOIN, 353, 366, USERSTATE and ROOMSTATE: https://dev.twitch.tv/docs/chat/irc/#joining-and-leaving-chatrooms
// - PRIVMSG tags (id, user-id, display-name, emotes, tmi-sent-ts, ...): https://dev.twitch.tv/docs/chat/irc/#privmsg-tags
// - PING / PONG keepalive: https://dev.twitch.tv/docs/chat/irc/#keepalive-messages
// - IRCv3 tag escaping: https://ircv3.net/specs/extensions/message-tags.html#escaping-values
import {randomUUID} from 'node:crypto';
import type {IrcTransport, IrcTransportFactory} from '../../apps/server/src/ingest/irc.ts';

export interface FakeChatter {login: string; userId: string; displayName?: string}
export interface FakeLogEntry {at: number; kind: string; detail?: string}

const escapeTag = (value: string) => value.replace(/\\/g, '\\\\').replace(/;/g, '\\:').replace(/ /g, '\\s').replace(/\r/g, '\\r').replace(/\n/g, '\\n');
const tags = (pairs: Record<string, string | number>) => '@' + Object.entries(pairs).map(([key, value]) => `${key}=${escapeTag(String(value))}`).join(';');

interface Connection {handlers: Parameters<IrcTransportFactory>[0]; pass?: string; nick?: string; welcomed: boolean; channels: Set<string>; closed: boolean; buffer: string}

/** One fake Twitch chat server. `transport` is handed to the app; the test drives chat with `say`. */
export class FakeTwitchIrc {
  readonly log: FakeLogEntry[] = [];
  readonly roomId = '424242';
  private connections = new Set<Connection>();
  private accepting = true;
  constructor(readonly channel: string, private readonly validToken: string, private readonly botLogin: string) {}

  /** The app's IRC transport. Delivery is asynchronous, like a socket. */
  readonly transport: IrcTransportFactory = handlers => {
    const connection: Connection = {handlers, welcomed: false, channels: new Set(), closed: false, buffer: ''};
    const transport: IrcTransport = {
      write: frame => { if (!connection.closed) setImmediate(() => this.receive(connection, frame)); },
      close: () => { this.drop(connection, false); },
    };
    if (!this.accepting) {
      this.note('irc.refused');
      setImmediate(() => { connection.closed = true; handlers.error(); });
      return transport;
    }
    this.connections.add(connection);
    this.note('irc.open');
    setImmediate(() => { if (!connection.closed) handlers.open(); });
    return transport;
  };

  /** Number of authenticated connections that have joined the channel. */
  get joined() { return [...this.connections].filter(connection => connection.welcomed && connection.channels.has(this.channel)).length; }

  /** Posts one chat line from `chatter` to every joined connection. Returns the message id. */
  say(chatter: FakeChatter, text: string, extra: Record<string, string> = {}): string {
    const id = randomUUID();
    const line = `${tags({'badge-info': '', badges: '', color: '', 'display-name': chatter.displayName ?? chatter.login, emotes: '', 'first-msg': 0, flags: '', id, mod: 0,
      'room-id': this.roomId, subscriber: 0, 'tmi-sent-ts': Date.now(), turbo: 0, 'user-id': chatter.userId, 'user-type': '', ...extra})} :${chatter.login}!${chatter.login}@${chatter.login}.tmi.twitch.tv PRIVMSG #${this.channel} :${text}`;
    this.broadcast(line);
    this.note('irc.privmsg', chatter.login);
    return id;
  }

  /** Server keepalive PING. */
  ping() { this.broadcast('PING :tmi.twitch.tv'); }

  /** Closes every connection as a dropped socket would. */
  dropAll() { for (const connection of [...this.connections]) this.drop(connection, true); }

  /** While false, new connections fail at once (like an unreachable host). */
  setAccepting(accepting: boolean) { this.accepting = accepting; }

  stop() { this.accepting = false; this.dropAll(); }

  private note(kind: string, detail?: string) { this.log.push({at: Date.now(), kind, detail}); }

  private broadcast(line: string) {
    for (const connection of this.connections) if (connection.welcomed && connection.channels.has(this.channel)) this.send(connection, line);
  }

  private send(connection: Connection, ...lines: string[]) {
    if (connection.closed) return;
    const chunk = lines.map(line => `${line}\r\n`).join('');
    setImmediate(() => { if (!connection.closed) connection.handlers.data(chunk); });
  }

  private drop(connection: Connection, notify: boolean) {
    if (connection.closed) return;
    connection.closed = true;
    this.connections.delete(connection);
    this.note('irc.close');
    if (notify) setImmediate(() => connection.handlers.close());
  }

  private receive(connection: Connection, frame: string) {
    if (connection.closed) return;
    connection.buffer += frame;
    let end: number;
    while ((end = connection.buffer.indexOf('\r\n')) >= 0) {
      const line = connection.buffer.slice(0, end);
      connection.buffer = connection.buffer.slice(end + 2);
      this.command(connection, line);
      if (connection.closed) return;
    }
  }

  private command(connection: Connection, line: string) {
    const [verb = '', ...rest] = line.split(' ');
    const argument = rest.join(' ');
    switch (verb.toUpperCase()) {
      case 'CAP':
        this.send(connection, `:tmi.twitch.tv CAP * ACK :${argument.replace(/^REQ :/, '')}`);
        return;
      case 'PASS':
        connection.pass = argument;
        return;
      case 'NICK': {
        connection.nick = argument.toLowerCase();
        // Twitch closes the socket after a failed login. The token itself is never logged.
        if (connection.pass !== `oauth:${this.validToken}` || connection.nick !== this.botLogin) {
          this.note('irc.login-failed');
          this.send(connection, ':tmi.twitch.tv NOTICE * :Login authentication failed');
          setImmediate(() => this.drop(connection, true));
          return;
        }
        connection.welcomed = true;
        const nick = connection.nick;
        this.note('irc.login', nick);
        this.send(connection, `:tmi.twitch.tv 001 ${nick} :Welcome, GLHF!`, `:tmi.twitch.tv 002 ${nick} :Your host is tmi.twitch.tv`,
          `:tmi.twitch.tv 003 ${nick} :This server is rather new`, `:tmi.twitch.tv 004 ${nick} :-`, `:tmi.twitch.tv 375 ${nick} :-`,
          `:tmi.twitch.tv 372 ${nick} :You are in a maze of twisty passages.`, `:tmi.twitch.tv 376 ${nick} :>`,
          `${tags({'badge-info': '', badges: '', color: '', 'display-name': nick, 'emote-sets': 0, 'user-id': '1001', 'user-type': ''})} :tmi.twitch.tv GLOBALUSERSTATE`);
        return;
      }
      case 'JOIN': {
        if (!connection.welcomed) return;
        const channel = argument.replace(/^#/, '').toLowerCase();
        // Twitch quietly drops a JOIN for a channel that does not exist.
        if (channel !== this.channel) return;
        connection.channels.add(channel);
        const nick = connection.nick!;
        this.note('irc.join', channel);
        this.send(connection, `:${nick}!${nick}@${nick}.tmi.twitch.tv JOIN #${channel}`, `:${nick}.tmi.twitch.tv 353 ${nick} = #${channel} :${nick}`,
          `:${nick}.tmi.twitch.tv 366 ${nick} #${channel} :End of /NAMES list`,
          `${tags({'badge-info': '', badges: '', color: '', 'display-name': nick, 'emote-sets': 0, mod: 0, subscriber: 0, 'user-type': ''})} :tmi.twitch.tv USERSTATE #${channel}`,
          `${tags({'emote-only': 0, 'followers-only': -1, r9k: 0, 'room-id': this.roomId, slow: 0, 'subs-only': 0})} :tmi.twitch.tv ROOMSTATE #${channel}`);
        return;
      }
      case 'PONG':
        this.note('irc.pong');
        return;
      default:
        return;
    }
  }
}
