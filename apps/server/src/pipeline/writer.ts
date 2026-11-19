import { safeText } from '@comictoons/core';
import type { StreamEvent } from '@comictoons/core';
import { strongSignalKind, type LiveMoment, type MomentKind } from './moments.ts';

export interface WrittenPanel { caption: string; beats: string[]; dialogue: string[]; sfx: string; mood: string; scene: string; sources: string[] }
/** recentCaptions / recentScenes: what other live panels already use, so this panel's caption
 * and art prompt are written to differ from them. */
export interface WriterContext { recentCaptions?: string[]; recentScenes?: string[]; style?: string }
/** A caption/dialogue writer for one detected moment. Deterministic today; an LLM-backed
 * implementation can later satisfy this same interface without Studio needing to change. */
export interface ComicWriter { write(moment: LiveMoment, context?: WriterContext): Promise<WrittenPanel> }

const sfxByKind: Record<MomentKind, string> = {
  raid: 'RAID!', cheer: 'CHEER!', hype: 'HYPE!', redemption: 'INK!', poll: 'VOTE!', clip: 'CLIP!', spike: 'SPIKE!', burst: 'SURGE!', chat: 'TALK',
};
const moodByKind: Record<MomentKind, string> = {
  raid: 'triumphant', cheer: 'excited', hype: 'triumphant', redemption: 'proud', poll: 'curious', clip: 'dramatic', spike: 'energetic', burst: 'electric', chat: 'reflective',
};

function dedupe(lines: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of lines) { if (seen.has(line)) continue; seen.add(line); out.push(line); }
  return out;
}

/** Distinct chat lines, most repeated first (ties keep their chat order), so a spike or
 * burst leads with the line the crowd actually shouted rather than background chatter. */
function rankedLines(moment: LiveMoment): string[] {
  const counts = new Map<string, number>();
  for (const event of moment.events) {
    if (event.type !== 'chat' || !event.text) continue;
    const line = safeText(event.text).trim();
    if (line) counts.set(line, (counts.get(line) ?? 0) + 1);
  }
  const order = dedupe([...counts.keys()]);
  return order.map((line, index) => ({ line, index, count: counts.get(line)! }))
    .sort((a, b) => b.count - a.count || a.index - b.index).map((item) => item.line);
}

function chatLines(moment: LiveMoment): string[] {
  return rankedLines(moment).slice(0, 4);
}

/** The strongest distinct chat line: the most repeated, then the longest. Used only to vary
 * captions; never quoted verbatim into an art prompt, and no usernames leak out. */
function strongestLine(moment: LiveMoment): string {
  const ranked = rankedLines(moment);
  if (!ranked.length) return '';
  const counts = moment.events.filter((event) => event.type === 'chat' && event.text).map((event) => safeText(event.text!).trim());
  const top = counts.filter((line) => line === ranked[0]).length;
  return ranked.filter((line) => counts.filter((item) => item === line).length === top)
    .reduce((best, line) => (line.length > best.length ? line : best), '');
}

function distinctUsers(moment: LiveMoment): number {
  return new Set(moment.events.filter((event) => event.type === 'chat').map((event) => event.user).filter(Boolean)).size;
}

function chatCount(moment: LiveMoment): number {
  return moment.events.filter((event) => event.type === 'chat').length;
}

/** For a burst, only the viewers who actually used the repeated emote/keyword count. */
function tokenUsers(moment: LiveMoment): number {
  if (!moment.token) return distinctUsers(moment);
  const token = moment.token.toLowerCase();
  return new Set(moment.events.filter((event) => event.type === 'chat' && safeText(event.text ?? '').toLowerCase().includes(token)).map((event) => event.user).filter(Boolean)).size;
}

function tokenLabel(moment: LiveMoment): string {
  if (!moment.token) return '';
  const pattern = moment.token.toLowerCase();
  for (const event of moment.events) {
    const text = safeText(event.text ?? '');
    const index = text.toLowerCase().indexOf(pattern);
    if (index >= 0) return text.slice(index, index + moment.token.length);
  }
  return moment.token.toUpperCase();
}

function clockMark(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

function describeMoment(moment: LiveMoment): string {
  switch (moment.kind) {
    case 'raid': {
      const event = moment.events.find((item): item is StreamEvent & { from: string } => item.type === 'raid' && !!item.from);
      return event ? `${safeText(event.from)} arrives with ${event.viewers ?? 'a crew of'} viewers` : 'a raid crew arrives';
    }
    case 'cheer': return 'chat cheers with bits';
    case 'hype': return 'the hype train rolls in';
    case 'redemption': return 'a viewer redeems the moment';
    case 'poll': return 'chat decides together';
    case 'clip': return 'a clip-worthy beat unfolds';
    case 'spike': {
      const line = strongestLine(moment);
      const users = distinctUsers(moment);
      if (line && users > 1) return `${users} viewers pile in with "${line}"`;
      return line ? `"${line}" floods in` : `${chatCount(moment)} chat lines land in seconds`;
    }
    case 'burst': {
      const users = Math.max(tokenUsers(moment), 1);
      const token = tokenLabel(moment);
      return token ? `${users} viewers spam ${token} at once` : `${users} viewers share the same reaction at once`;
    }
    default: {
      const line = strongestLine(moment);
      return line || 'chat settles in';
    }
  }
}

/** Extra, content-derived details tried in order when the primary caption has already been
 * used: another real quoted line, the crowd size, the emote, the event detail, then the
 * moment's place in the stream. There is no numeric-counter fallback. */
function alternateDetails(moment: LiveMoment): string[] {
  const details: string[] = [];
  const strongest = strongestLine(moment);
  if (moment.kind === 'spike' || moment.kind === 'burst') details.push(`${describeMoment(moment)}, ${clockMark(moment.startAt)} in`);
  for (const line of rankedLines(moment)) if (line !== strongest) details.push(`"${line}"`);
  const users = distinctUsers(moment);
  const lines = chatCount(moment);
  const token = tokenLabel(moment);
  if (token) details.push(`${tokenUsers(moment)} viewers go ${token}`);
  if (users > 1) details.push(`${users} viewers in on it`);
  if (lines > 1) details.push(`${lines} messages in ${Math.max(1, Math.round(moment.endAt - moment.startAt))}s`);
  for (const event of moment.events) {
    if (event.type === 'raid' && event.viewers) details.push(`${event.viewers} raiders in the doorway`);
    if ((event.type === 'hype' || event.type === 'hype_train_begin') && event.level) details.push(`hype level ${event.level}`);
  }
  details.push(`at ${clockMark(moment.startAt)} into the stream`);
  if (strongest) details.push(`"${strongest}" at ${clockMark(moment.startAt)}`);
  return dedupe(details);
}

const captionTemplates: Record<MomentKind, (detail: string) => string> = {
  raid: (detail) => `A raid crashes in: ${detail}.`,
  cheer: () => 'Bits rain down as chat cheers the moment on.',
  hype: () => 'The hype train rolls in and the room lifts off.',
  redemption: () => 'A viewer redeems the moment and steps into the panel.',
  poll: () => 'Chat decides together, and the story bends to the vote.',
  clip: () => 'A clip-worthy beat unfolds in real time.',
  spike: (detail) => `Chat erupts all at once: ${detail}.`,
  burst: (detail) => `The same reaction floods chat: ${detail}.`,
  chat: (detail) => `A quiet moment in chat: ${detail}.`,
};

const beatTemplates: Record<MomentKind, (detail: string) => string[]> = {
  raid: (detail) => [`A new crew arrives: ${detail}.`, 'The room welcomes them in.'],
  cheer: () => ['Bits light up the screen.', 'The cheer lands at just the right beat.'],
  hype: () => ['The hype train pulls into the station.', 'Everyone piles on for the ride.'],
  redemption: (detail) => [`${detail}.`, 'The redemption locks in and the panel is theirs.'],
  poll: () => ['The chat vote closes.', 'The winning choice becomes canon.'],
  clip: () => ['The clip catches the beat.', 'It becomes this panel.'],
  spike: (detail) => [`Chat floods in together: ${detail}.`, 'The moment is too big to miss.'],
  burst: (detail) => [`${detail}.`, 'The reaction becomes the panel.'],
  chat: (detail) => [`${detail}.`],
};

/* ---- Scene / art prompt -------------------------------------------------------------
 * The scene is built from the panel's own content: the moment kind, paraphrased chat themes,
 * the emote's meaning, intensity, crowd size and event detail. It never contains raw chat
 * text, emote/keyword tokens or usernames: chat is only ever matched against fixed theme
 * patterns below and replaced by fixed visual vocabulary, so the image model is never asked
 * to draw real words and nobody in chat is named in a prompt. */

interface ChatTheme { pattern: RegExp; visual: string }
const chatThemes: ChatTheme[] = [
  { pattern: /\b(kekw|lul|lol|lmao|lmfao|omegalul|rofl|haha\w*|xd|icant)\b/i, visual: 'figures doubled over with laughter' },
  { pattern: /\b(no way|can'?t believe|did not expect|didn'?t expect|wow|omg|pog\w*|what\?+|insane)\b/i, visual: 'wide eyes and dropped jaws' },
  { pattern: /\b(oh no|close|brink|scary|nervous|yikes|rip|monkas|careful|danger)\b/i, visual: 'clenched fists and held breath' },
  { pattern: /\b(lets? go|let's go|go go|gg|hype|incredible|so good|great|amazing|huge|w)\b/i, visual: 'raised arms and pumping fists' },
  { pattern: /\b(clean|textbook|perfect|nice|skill|timing|play|run|smooth|calculated)\b/i, visual: 'approving nods and thumbs up' },
  { pattern: /\b(hello|hi|hey|welcome|first time|o7|heyguys|evening|morning)\b/i, visual: 'hands raised in greeting' },
  { pattern: /(<3|\b(love|heart|cute|wholesome)\b)/i, visual: 'small hearts drifting overhead' },
  { pattern: /\b(all day|again|still here|marathon|tired|sleep\w*|residentsleeper)\b/i, visual: 'weary but loyal regulars slumped in their seats' },
  { pattern: /\b(sad|cry\w*|pepehands|biblethump|f)\b/i, visual: 'heads bowed and tears welling' },
];

/** Known emotes paraphrased by meaning; the token itself never reaches the prompt. */
const emoteMeanings: Record<string, string> = {
  kekw: 'wheezing, tearful laughter', lul: 'open-mouthed laughter', omegalul: 'explosive, falling-over laughter', lol: 'giggling laughter',
  pog: 'open-mouthed astonishment', pogchamp: 'open-mouthed astonishment', poggers: 'gleeful astonishment', kappa: 'sly, knowing smirks',
  monkas: 'nervous sweat beading on every brow', pepehands: 'quiet tears', biblethump: 'big sobbing tears', kreygasm: 'blissful awe',
  residentsleeper: 'drowsy, nodding-off boredom', heyguys: 'friendly waves', gg: 'sporting applause', f: 'solemn respect', w: 'triumphant fist pumps',
  '<3': 'floating hearts', clap: 'rhythmic applause', ez: 'smug confidence', copium: 'desperate hopeful grins', sadge: 'slumped, sad shoulders',
};

function chatTexts(moment: LiveMoment): string[] {
  return moment.events.filter((event) => event.type === 'chat' && event.text).map((event) => safeText(event.text!).trim()).filter(Boolean);
}

/** The two most common chat themes, as fixed visual phrases (never the chat words). */
function chatThemeVisuals(moment: LiveMoment): string[] {
  const counts = new Map<string, number>();
  for (const text of chatTexts(moment)) {
    for (const theme of chatThemes) if (theme.pattern.test(text)) counts.set(theme.visual, (counts.get(theme.visual) ?? 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1] || chatThemes.findIndex((t) => t.visual === a[0]) - chatThemes.findIndex((t) => t.visual === b[0]))
    .slice(0, 2).map(([visual]) => visual);
}

function emoteMeaning(moment: LiveMoment): string {
  const token = (moment.token ?? '').toLowerCase();
  if (!token) return '';
  if (emoteMeanings[token]) return emoteMeanings[token]!;
  const theme = chatThemes.find((item) => item.pattern.test(token));
  return theme ? theme.visual : 'one shared, wordless reaction rippling from face to face';
}

function crowdPhrase(count: number): string {
  if (count <= 1) return 'a lone figure';
  if (count <= 3) return 'a small knot of two or three figures';
  if (count <= 9) return 'a tight cluster of about half a dozen figures';
  if (count <= 24) return 'a packed crowd of a dozen or more figures';
  if (count <= 99) return 'a vast, overflowing crowd';
  return 'an endless sea of figures stretching to the horizon';
}

function bubblePhrase(messages: number, seconds: number): string {
  const rate = messages / Math.max(1, seconds);
  if (messages <= 1) return 'a single blank speech bubble';
  if (rate >= 2) return 'a torrent of blank speech bubbles stacked edge to edge';
  if (rate >= 0.8) return 'a steady stream of blank speech bubbles';
  return 'a few blank speech bubbles drifting by';
}

function streamLight(seconds: number): string {
  if (seconds < 120) return 'the first light of a fresh broadcast';
  if (seconds < 600) return 'bright, early-broadcast light';
  if (seconds < 3600) return 'warm mid-broadcast light';
  return 'late-night lamplight of a long broadcast';
}

function baseScene(moment: LiveMoment): string {
  const users = distinctUsers(moment);
  const messages = chatCount(moment);
  const seconds = Math.max(1, Math.round(moment.endAt - moment.startAt));
  const themes = chatThemeVisuals(moment);
  const reacting = themes.length ? `, ${themes.join(' and ')}` : '';
  // A first-class 'bits' or 'prediction' event opens a cheer or poll moment, so match by the kind it opens.
  const strong = moment.events.find((event) => event.type === moment.kind || strongSignalKind(event.type) === moment.kind);
  switch (moment.kind) {
    case 'raid': {
      const viewers = strong?.viewers ?? 0;
      const size = viewers ? crowdPhrase(viewers) : 'a crew of travellers';
      return `${size[0]!.toUpperCase()}${size.slice(1)} bursts through a bright doorway as new arrivals, motion lines trailing behind them${reacting ? `; the room greets them with ${themes.join(' and ')}` : ''}.`;
    }
    case 'cheer': {
      const bits = Number(/cheer(\d+)/i.exec(strong?.text ?? '')?.[1] ?? 0);
      const shower = bits >= 1000 ? 'a blinding downpour of glowing gems' : bits >= 100 ? 'a heavy shower of glowing gems' : 'a light sprinkle of glowing gems';
      return `${shower[0]!.toUpperCase()}${shower.slice(1)} rains down over a cheering silhouette crowd${reacting}.`;
    }
    case 'hype': {
      const level = Math.max(1, Math.min(10, strong?.level ?? 1));
      const cars = level <= 1 ? 'a glowing train of light, a single carriage long' : `a glowing train of light ${level} carriages long`;
      return `${cars[0]!.toUpperCase()}${cars.slice(1)} rolls through the panel, speed lines rising with each car, as a crowd cheers it on${reacting}.`;
    }
    case 'redemption':
      return `A single figure steps forward into a spotlight, ink rays radiating outward${reacting ? `, watched with ${themes.join(' and ')}` : ''}.`;
    case 'poll':
      return `Two paths split before a figure weighing a choice, screentone shading on either side${reacting ? `, onlookers showing ${themes.join(' and ')}` : ''}.`;
    case 'clip':
      return `A dramatic freeze-frame beat, motion lines frozen mid-action${reacting}.`;
    case 'spike':
      return `A wall of speech-shaped bursts crowds in around a startled figure: ${crowdPhrase(users)} under ${bubblePhrase(messages, seconds)}${themes.length ? `, all ${themes.join(' and ')}` : ''}.`;
    case 'burst': {
      const users = Math.max(1, tokenUsers(moment));
      return `A ring of identical small bursts surrounds a figure at the centre of the panel: ${crowdPhrase(users)} sharing ${emoteMeaning(moment)}.`;
    }
    default:
      return `A calm figure listens among ${crowdPhrase(users)}, with ${bubblePhrase(messages, seconds)} overhead${themes.length ? `; faces show ${themes.join(' and ')}` : '; everyone quiet and attentive'}.`;
  }
}

const framings = [
  'Wide establishing shot', 'Low-angle hero shot', 'Close-up on the faces', 'Over-the-shoulder view', "Bird's-eye view",
  'Dutch-angle tilt', 'Long shot down a corridor of figures', 'Silhouettes against a starburst', 'Extreme close-up on wide eyes', 'Split-panel cutaway',
];
const backdrops = ['', 'Speed lines fill the background.', 'Rain streaks the background.', 'Falling petals cross the frame.', 'Neon signs glow behind them.',
  'Heavy crosshatching darkens the edges.', 'Halftone dots fade into the distance.', 'A spiral of motion lines frames the scene.'];

/** Describes the scene for the art prompt from the panel's content. When the same content has
 * already been drawn (recentScenes), it changes framing and backdrop rather than repeating a
 * prompt, so no two live panels ask the image model for the same picture. */
export function describeScene(input: LiveMoment, recentScenes: readonly string[] = []): string {
  const moment = focusMoment(input);
  const base = `${baseScene(moment)} ${streamLight(moment.startAt)[0]!.toUpperCase()}${streamLight(moment.startAt).slice(1)}.`;
  const used = new Set(recentScenes);
  for (const backdrop of backdrops) {
    for (const framing of framings) {
      const candidate = `${framing}. ${base}${backdrop ? ` ${backdrop}` : ''}`;
      if (!used.has(candidate)) return candidate;
    }
  }
  return `${framings[0]}. ${base}`;
}

function withUniqueCaption(caption: string, moment: LiveMoment, recentCaptions: string[]): string {
  const used = new Set(recentCaptions);
  if (!used.has(caption)) return caption;
  const stem = caption.replace(/[.!?]+$/, '');
  const template = captionTemplates[moment.kind];
  const takesDetail = template('\u0000a') !== template('\u0000b');
  for (const detail of alternateDetails(moment)) {
    const candidate = takesDetail ? template(detail) : `${stem}, ${detail}.`;
    if (!used.has(candidate)) return candidate;
  }
  // Every content-based variant is taken (only possible after hundreds of near-identical
  // moments); repeat the primary caption rather than append a meaningless counter.
  return caption;
}

/** A burst is about the repeated reaction: keep only the lines that carry its token, so the
 * dialogue and sources are the reaction itself rather than chat that happened alongside it. */
function focusMoment(moment: LiveMoment): LiveMoment {
  if (moment.kind !== 'burst' || !moment.token) return moment;
  const token = moment.token.toLowerCase();
  const events = moment.events.filter((event) => event.type === 'chat' && safeText(event.text ?? '').toLowerCase().includes(token));
  if (!events.length) return moment;
  return { ...moment, events, sourceIds: events.map((event) => event.id).filter((id): id is string => !!id) };
}

/** Synchronous core used by Studio so panel creation stays synchronous; deterministicWriter
 * below simply wraps this in a Promise to satisfy the ComicWriter interface. */
export function writeCaptionSync(input: LiveMoment, context: WriterContext = {}): WrittenPanel {
  const moment = focusMoment(input);
  const detail = describeMoment(moment);
  const caption = withUniqueCaption(captionTemplates[moment.kind](detail), moment, context.recentCaptions ?? []);
  const sources = moment.sourceIds.length ? moment.sourceIds : moment.events.map((event) => event.id).filter((id): id is string => !!id);
  return { caption, beats: beatTemplates[moment.kind](detail), dialogue: chatLines(moment), sfx: sfxByKind[moment.kind], mood: moodByKind[moment.kind], scene: describeScene(moment, context.recentScenes ?? []), sources };
}

export const deterministicWriter: ComicWriter = { async write(moment, context) { return writeCaptionSync(moment, context); } };
