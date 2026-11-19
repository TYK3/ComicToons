// Minimal RFC 6455 WebSocket server endpoint for the fake EventSub server.
// Node built-ins only (no new dependency). Covers what EventSub uses: text frames,
// ping/pong, close codes, and an abrupt drop (no close frame) for disconnect tests.
// Protocol reference: https://www.rfc-editor.org/rfc/rfc6455
import {createHash} from 'node:crypto';
import {EventEmitter} from 'node:events';
import type {IncomingMessage} from 'node:http';
import type {Duplex} from 'node:stream';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export interface WsEvents { message: [text: string]; pong: [payload: Buffer]; close: [code: number, reason: string] }

export class WsConnection extends EventEmitter<WsEvents> {
  closed = false;
  closeCode?: number;
  /** Who started the close: 'server' (this side), 'client', or 'drop' (socket ended without a close frame). */
  closedBy?: 'server' | 'client' | 'drop';
  private buffer = Buffer.alloc(0);
  private fragments: Buffer[] = [];
  private fragmentOpcode = 0;
  constructor(private socket: Duplex) {
    super();
    socket.on('data', chunk => this.onData(chunk as Buffer));
    socket.on('close', () => this.finish(1006, '', 'drop'));
    socket.on('error', () => this.finish(1006, '', 'drop'));
  }
  static accept(req: IncomingMessage, socket: Duplex, head: Buffer): WsConnection | undefined {
    const key = req.headers['sec-websocket-key'];
    if (typeof key !== 'string' || (req.headers.upgrade ?? '').toLowerCase() !== 'websocket') {
      socket.end('HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
      return undefined;
    }
    const accept = createHash('sha1').update(key + GUID).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    const connection = new WsConnection(socket);
    if (head.length) connection.onData(head);
    return connection;
  }
  send(text: string) { this.frame(0x1, Buffer.from(text, 'utf8')); }
  ping(payload = Buffer.alloc(0)) { this.frame(0x9, payload); }
  /** Sends a close frame with a code, as Twitch does (4000-4007), then ends the socket. */
  close(code = 1000, reason = '') {
    if (this.closed) return;
    const body = Buffer.alloc(2 + Buffer.byteLength(reason));
    body.writeUInt16BE(code, 0); body.write(reason, 2);
    this.frame(0x8, body);
    this.finish(code, reason, 'server');
    this.socket.end();
  }
  /** Abrupt loss: no close frame, as when the network goes away. */
  drop() { this.finish(1006, '', 'drop'); this.socket.destroy(); }
  private finish(code: number, reason: string, by: 'server' | 'client' | 'drop') {
    if (this.closed) return;
    this.closed = true; this.closeCode = code; this.closedBy = by;
    this.emit('close', code, reason);
  }
  private frame(opcode: number, payload: Buffer) {
    if (this.closed || this.socket.destroyed) return;
    const length = payload.length;
    const header = length < 126 ? Buffer.alloc(2) : length < 65536 ? Buffer.alloc(4) : Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    if (length < 126) header[1] = length;
    else if (length < 65536) { header[1] = 126; header.writeUInt16BE(length, 2); }
    else { header[1] = 127; header.writeBigUInt64BE(BigInt(length), 2); }
    this.socket.write(Buffer.concat([header, payload]));
  }
  private onData(chunk: Buffer) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      if (this.buffer.length < 2) return;
      const first = this.buffer[0]!, second = this.buffer[1]!;
      const fin = (first & 0x80) !== 0, opcode = first & 0x0f, masked = (second & 0x80) !== 0;
      let length = second & 0x7f, offset = 2;
      if (length === 126) { if (this.buffer.length < 4) return; length = this.buffer.readUInt16BE(2); offset = 4; }
      else if (length === 127) { if (this.buffer.length < 10) return; length = Number(this.buffer.readBigUInt64BE(2)); offset = 10; }
      const maskOffset = offset; if (masked) offset += 4;
      if (this.buffer.length < offset + length) return;
      const payload = Buffer.from(this.buffer.subarray(offset, offset + length));
      if (masked) for (let i = 0; i < payload.length; i++) payload[i]! ^= this.buffer[maskOffset + (i % 4)]!;
      this.buffer = this.buffer.subarray(offset + length);
      this.handle(fin, opcode, payload);
      if (this.closed) return;
    }
  }
  private handle(fin: boolean, opcode: number, payload: Buffer) {
    if (opcode === 0x8) {
      const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
      const reason = payload.subarray(2).toString('utf8');
      if (!this.closed) { this.frame(0x8, payload.subarray(0, 2)); this.finish(code, reason, 'client'); this.socket.end(); }
      return;
    }
    if (opcode === 0x9) { this.frame(0xA, payload); return; }
    if (opcode === 0xA) { this.emit('pong', payload); return; }
    if (opcode === 0x1 || opcode === 0x2) { this.fragmentOpcode = opcode; this.fragments = [payload]; }
    else if (opcode === 0x0) this.fragments.push(payload);
    else return;
    if (!fin) return;
    const whole = Buffer.concat(this.fragments); this.fragments = [];
    if (this.fragmentOpcode === 0x1 || this.fragmentOpcode === 0x2) this.emit('message', whole.toString('utf8'));
  }
}
