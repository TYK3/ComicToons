import { safeText } from '@comictoons/core';
import { ImportError } from './errors.ts';

/** One line of dialogue from an uploaded chat log. `t` is seconds into the stream, when known. */
export interface ChatLogLine { t?: number; user?: string; text: string }

const TXT_LINE = /^(?:\[?(\d{1,2}):(\d{2}):(\d{2})\]?\s+)?(?:([A-Za-z0-9_]{1,25}):\s*)?(.+)$/;

function fromTxt(content: string): ChatLogLine[] {
  const lines: ChatLogLine[] = [];
  for (const raw of content.split('\n')) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const match = TXT_LINE.exec(trimmed);
    if (!match) continue;
    const [, h, m, s, user, text] = match;
    const clean = safeText(text!);
    if (!clean) continue;
    lines.push({ t: h !== undefined ? Number(h) * 3600 + Number(m) * 60 + Number(s) : undefined, user, text: clean });
  }
  return lines;
}

type RawJsonLine = { t?: unknown; time?: unknown; at?: unknown; user?: unknown; username?: unknown; name?: unknown; text?: unknown; message?: unknown };
function fromJson(content: string): ChatLogLine[] {
  let parsed: unknown;
  try { parsed = JSON.parse(content); } catch { throw new ImportError('bad-chat-log', 'That chat log is not valid JSON.'); }
  if (!Array.isArray(parsed)) throw new ImportError('bad-chat-log', 'The chat log JSON must be an array of lines.');
  const lines: ChatLogLine[] = [];
  for (const entry of parsed as RawJsonLine[]) {
    if (!entry || typeof entry !== 'object') continue;
    const rawText = entry.text ?? entry.message;
    if (typeof rawText !== 'string') continue;
    const text = safeText(rawText);
    if (!text) continue;
    const rawT = entry.t ?? entry.time ?? entry.at;
    const t = typeof rawT === 'number' && Number.isFinite(rawT) ? rawT : undefined;
    const rawUser = entry.user ?? entry.username ?? entry.name;
    const user = typeof rawUser === 'string' && rawUser ? rawUser : undefined;
    lines.push({ t, user, text });
  }
  return lines;
}

/** .txt (`[hh:mm:ss] user: text`, any part optional) or .json (array of `{text|message, t|time|at, user}`). */
export function parseChatLog(content: string, format: 'txt' | 'json'): ChatLogLine[] {
  return format === 'json' ? fromJson(content) : fromTxt(content);
}
