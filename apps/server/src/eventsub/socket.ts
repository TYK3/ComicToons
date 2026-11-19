import {request as httpRequest} from 'node:http';
import {request as httpsRequest} from 'node:https';
import {createHash,randomBytes} from 'node:crypto';
import type {Socket} from 'node:net';
import type {EventSubSocket} from './messages.ts';

// A small RFC 6455 client so EventSub needs no new dependency (Node 20 has no global WebSocket
// without a flag). EventSub only sends text frames and Ping; the client only ever sends Pong
// and Close (anything else makes Twitch close with 4001, per handling-websocket-events).
const GUID='258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_MESSAGE=1<<20;

export function encodeFrame(opcode:number,payload:Buffer,mask=true):Buffer {
  const length=payload.length;
  const head=length<126?2:length<65536?4:10;
  const frame=Buffer.alloc(head+(mask?4:0)+length);
  frame[0]=0x80|opcode;
  if(length<126)frame[1]=length;
  else if(length<65536){frame[1]=126;frame.writeUInt16BE(length,2);}
  else{frame[1]=127;frame.writeBigUInt64BE(BigInt(length),2);}
  if(!mask){payload.copy(frame,head);return frame;}
  frame[1]|=0x80;
  const key=randomBytes(4);key.copy(frame,head);
  for(let index=0;index<length;index++)frame[head+4+index]=payload[index]!^key[index%4]!;
  return frame;
}

/** Splits a byte stream into frames. Returns the frames found and the unread tail. */
export function decodeFrames(buffer:Buffer):{frames:{fin:boolean;opcode:number;payload:Buffer}[];rest:Buffer} {
  const frames:{fin:boolean;opcode:number;payload:Buffer}[]=[];let offset=0;
  while(buffer.length-offset>=2){
    const first=buffer[offset]!,second=buffer[offset+1]!;
    let length=second&0x7f,cursor=offset+2;
    if(length===126){if(buffer.length-cursor<2)break;length=buffer.readUInt16BE(cursor);cursor+=2;}
    else if(length===127){if(buffer.length-cursor<8)break;const big=buffer.readBigUInt64BE(cursor);if(big>BigInt(MAX_MESSAGE))throw new Error('Frame too large');length=Number(big);cursor+=8;}
    const masked=(second&0x80)!==0;let key:Buffer|undefined;
    if(masked){if(buffer.length-cursor<4)break;key=buffer.subarray(cursor,cursor+4);cursor+=4;}
    if(buffer.length-cursor<length)break;
    const payload=Buffer.from(buffer.subarray(cursor,cursor+length));
    if(key)for(let index=0;index<payload.length;index++)payload[index]=payload[index]!^key[index%4]!;
    frames.push({fin:(first&0x80)!==0,opcode:first&0x0f,payload});
    offset=cursor+length;
  }
  return {frames,rest:buffer.subarray(offset)};
}

/** Opens ws:// or wss:// and reports text messages. Ping is answered with Pong automatically. */
export function connectWebSocket(url:string):EventSubSocket {
  const target=new URL(url);
  if(target.protocol!=='wss:'&&target.protocol!=='ws:')throw new Error('EventSub needs a ws:// or wss:// address.');
  const key=randomBytes(16).toString('base64');
  const expected=createHash('sha1').update(key+GUID).digest('base64');
  let socket:Socket|undefined;let closed=false;let closeSent=false;
  const handle:EventSubSocket={close(code=1000){
    if(closed)return;
    if(socket&&!closeSent){closeSent=true;const body=Buffer.alloc(2);body.writeUInt16BE(code);try{socket.write(encodeFrame(0x8,body));}catch{/* already gone */}}
    finish(code,'client close');
  }};
  const finish=(code:number,reason:string)=>{if(closed)return;closed=true;try{socket?.end();setTimeout(()=>socket?.destroy(),1000).unref();}catch{/* ignore */}if(!socket)req.destroy();handle.onclose?.(code,reason);};
  const options={method:'GET',headers:{Connection:'Upgrade',Upgrade:'websocket','Sec-WebSocket-Version':'13','Sec-WebSocket-Key':key}};
  const req=(target.protocol==='wss:'?httpsRequest:httpRequest)(new URL(target.href.replace(/^ws/,'http')),options);
  req.setTimeout(15_000,()=>{req.destroy(new Error('WebSocket handshake timed out'));});
  req.on('response',response=>{response.resume();handle.onerror?.(new Error(`WebSocket handshake refused (${response.statusCode})`));finish(1006,'handshake refused');});
  req.on('error',error=>{if(closed)return;handle.onerror?.(error);finish(1006,error.message);});
  req.on('upgrade',(response,upgraded,head)=>{
    socket=upgraded as Socket;
    if(response.headers['sec-websocket-accept']!==expected){handle.onerror?.(new Error('WebSocket handshake failed'));finish(1006,'bad accept');return;}
    socket.setNoDelay(true);
    let buffer:Buffer=Buffer.from(head);let parts:Buffer[]=[];let textOpen=false;
    const read=(chunk:Buffer)=>{
      buffer=buffer.length?Buffer.concat([buffer,chunk]):chunk;
      let decoded;try{decoded=decodeFrames(buffer);}catch(error){handle.onerror?.(error as Error);handle.close(1009);return;}
      buffer=Buffer.from(decoded.rest);
      for(const frame of decoded.frames){
        if(closed)return;
        if(frame.opcode===0x9){socket!.write(encodeFrame(0xA,frame.payload));continue;}
        if(frame.opcode===0xA)continue;
        if(frame.opcode===0x8){
          const code=frame.payload.length>=2?frame.payload.readUInt16BE(0):1005;
          const reason=frame.payload.subarray(2).toString('utf8');
          if(!closeSent){closeSent=true;const body=Buffer.alloc(2);body.writeUInt16BE(code===1005?1000:code);try{socket!.write(encodeFrame(0x8,body));}catch{/* ignore */}}
          finish(code,reason);return;
        }
        if(frame.opcode===0x1){parts=[frame.payload];textOpen=true;}
        else if(frame.opcode===0x0&&textOpen)parts.push(frame.payload);
        else continue;
        if(parts.reduce((sum,part)=>sum+part.length,0)>MAX_MESSAGE){handle.close(1009);return;}
        if(frame.fin){textOpen=false;const text=Buffer.concat(parts).toString('utf8');parts=[];handle.onmessage?.(text);}
      }
    };
    socket.on('data',read);
    socket.on('error',error=>{if(!closed)handle.onerror?.(error);});
    socket.on('close',()=>finish(1006,'connection lost'));
    if(buffer.length){const first=buffer;buffer=Buffer.alloc(0);read(first);}
  });
  req.end();
  return handle;
}
