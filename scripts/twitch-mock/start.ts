// Standalone fake Twitch for local development: node --import tsx scripts/twitch-mock/start.ts [--port 4120] [--not-affiliate]
// Prints environment variable NAMES and local URLs only, never credential values.
// Type commands on stdin to play viewer or moderator (type "help").
import {createInterface} from 'node:readline';
import {FakeTwitch} from './fake-twitch.ts';

const args = process.argv.slice(2);
const flag = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const port = Number(flag('--port') ?? 4120);
if (port !== 4120 && port !== 0 && process.env.TWITCH_MOCK_ANY_PORT !== '1') {
  console.error('Use --port 4120 (the reserved mock port) or set TWITCH_MOCK_ANY_PORT=1.');
  process.exit(2);
}
const appPort = Number(process.env.COMICTOONS_API_PORT ?? 3120);
const fake = new FakeTwitch({
  port,
  // The same names the app reads, so one env serves both; built-in fake values otherwise.
  clientId: process.env.TWITCH_CLIENT_ID || undefined,
  clientSecret: process.env.TWITCH_CLIENT_SECRET || undefined,
  redirectUris: [process.env.TWITCH_REDIRECT_URI || `http://127.0.0.1:${appPort}/auth/twitch/callback`],
  broadcaster: {login: process.env.TWITCH_CHANNEL || 'fakebroadcaster', broadcasterType: args.includes('--not-affiliate') ? '' : 'affiliate'},
});
await fake.start();
const u = fake.urls;
console.log(`Fake Twitch listening on ${u.base} (HTTP, EventSub WebSocket and plain IRC share this port).`);
console.log(`  OAuth   ${u.authBase}/authorize | /token | /validate | /revoke`);
console.log(`  Helix   ${u.helixBase}/...`);
console.log(`  EventSub ${u.eventSubWs}`);
console.log(`  IRC     ${u.irc} (plain TCP, local only)`);
console.log('Point the app at it with these variables (values: the URLs above; client id and secret from your env or the fake defaults in fake-twitch.ts):');
for (const name of Object.keys(fake.appEnv())) console.log(`  ${name}`);
console.log('Type "help" for commands. Ctrl+C stops the fake.');

const help = `Commands:
  chat <login> <text...>        viewer message (IRC PRIVMSG + channel.chat.message)
  burst <count>                 that many messages from different viewers
  delete <login> <message-id>   CLEARMSG + channel.chat.message_delete
  ban <login> [seconds]         CLEARCHAT for one user (timeout when seconds given)
  raid <login> <viewers>        USERNOTICE raid + channel.raid
  redeem <login> <input...>     redeem the first custom reward the app created
  vote <n1> <n2> ...            poll progress
  poll-end                      poll completes
  predict <outcome> <users> <points>
  lock | resolve [outcome]      prediction lock / end
  hype [level]                  hype train begin
  reconnect                     EventSub session_reconnect + IRC RECONNECT
  drop                          drop every socket without a close frame
  expire                        expire every access token (refresh still works)
  status                        sessions, subscriptions, rewards`;
const rl = createInterface({input: process.stdin});
rl.on('line', line => {
  const [cmd = '', ...rest] = line.trim().split(/\s+/);
  try {
    switch (cmd) {
      case '': return;
      case 'help': console.log(help); return;
      case 'chat': console.log(fake.chat(rest[0] ?? 'viewer1', rest.slice(1).join(' ') || 'hello')); return;
      case 'burst': for (let i = 0; i < Number(rest[0] ?? 10); i++) fake.chat(`viewer${i + 1}`, `burst line ${i + 1}`); console.log('sent'); return;
      case 'delete': console.log(fake.deleteMessage(rest[0] ?? 'viewer1', rest[1] ?? '')); return;
      case 'ban': console.log(fake.clearChat(rest[0], rest[1] ? Number(rest[1]) : undefined)); return;
      case 'raid': console.log(fake.raid(rest[0] ?? 'raider', Number(rest[1] ?? 12))); return;
      case 'redeem': {
        const reward = [...fake.rewards.values()][0];
        if (!reward) { console.log('No custom reward yet; the app creates it.'); return; }
        console.log(fake.redeem(reward.id, rest[0] ?? 'viewer1', rest.slice(1).join(' ')).delivered, 'delivered'); return;
      }
      case 'vote': console.log(fake.votePoll(rest.map(Number)), 'delivered'); return;
      case 'poll-end': console.log(fake.finishPoll(), 'delivered'); return;
      case 'predict': console.log(fake.predict(Number(rest[0] ?? 0), Number(rest[1] ?? 1), Number(rest[2] ?? 100)), 'delivered'); return;
      case 'lock': console.log(fake.lockPrediction(), 'delivered'); return;
      case 'resolve': { const p = fake.activePrediction; console.log(fake.endPrediction(p, 'RESOLVED', p?.outcomes[Number(rest[0] ?? 0)]?.id), 'delivered'); return; }
      case 'hype': console.log(fake.hypeTrain(Number(rest[0] ?? 1)), 'delivered'); return;
      case 'reconnect': fake.sendReconnect(); fake.irc.reconnect(); console.log('sent'); return;
      case 'drop': fake.closeSessions('drop'); fake.irc.dropAll(); console.log('dropped'); return;
      case 'expire': fake.expireAccessTokens(); console.log('expired'); return;
      case 'status':
        console.log({sessions: fake.connectedSessions.map(s => ({id: s.id, status: s.status})),
          subscriptions: [...fake.subscriptions.values()].map(s => `${s.type} ${s.status}`),
          rewards: [...fake.rewards.values()].map(r => r.title), ircClients: fake.irc.clients.size});
        return;
      default: console.log('Unknown command; type "help".');
    }
  } catch (error) { console.log(error instanceof Error ? error.message : String(error)); }
});
const shutdown = () => { rl.close(); void fake.stop().then(() => process.exit(0)); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
