import {TwitchIrcAdapter,type IrcTransportFactory} from '../apps/server/src/ingest/irc.ts';
export function ircFixture(now:()=>number=()=>0,simulated=true) {
  let handlers:Parameters<IrcTransportFactory>[0];
  const sent:string[]=[];let closed=0;
  const transport:IrcTransportFactory=callbacks=>{handlers=callbacks;return {write:frame=>sent.push(frame),close:()=>{closed++;}};};
  const adapter=new TwitchIrcAdapter({channel:'approved_test',authenticate:()=>({username:'sample_bot',token:'oauth:mock_read_only'}),transport,now,simulated});
  return {adapter,sent,get closed(){return closed;},open(){handlers.open();},feed(text:string|Buffer){handlers.data(text);},drop(){handlers.close();},fail(){handlers.error();},
    welcome(){handlers.open();handlers.data(':tmi.twitch.tv 001 sample_bot :Welcome\r\n');},
    chat(id:string,text:string,user='viewer1'){handlers.data(`@id=${id};user-id=${user};mod=0 :sample!sample@sample PRIVMSG #approved_test :${text}\r\n`);}};
}
