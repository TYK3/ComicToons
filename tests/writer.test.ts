import assert from 'node:assert/strict';
import test from 'node:test';
import { writeCaptionSync, deterministicWriter, describeScene } from '../apps/server/src/pipeline/writer.ts';
import { buildArtPrompt } from '../apps/server/src/pipeline/imagegen.ts';
import type { LiveMoment } from '../apps/server/src/pipeline/moments.ts';
import type { StreamEvent } from '../packages/core/src/index.ts';

function moment(kind: LiveMoment['kind'], events: StreamEvent[]): LiveMoment {
  return { kind, startAt: events[0]?.t ?? 0, endAt: events.at(-1)?.t ?? 0, score: events.length, events, sourceIds: events.map((e) => e.id).filter((id): id is string => !!id) };
}

test('WRITER-01: dialogue is drawn only from real chat lines, escaped, deduplicated and capped at four', () => {
  const events: StreamEvent[] = [
    { id: 'a', t: 0, type: 'chat', user: 'u1', text: '<script>alert(1)</script> nice one' },
    { id: 'b', t: 1, type: 'chat', user: 'u2', text: 'nice one' },
    { id: 'c', t: 2, type: 'chat', user: 'u3', text: 'me@example.com should be redacted' },
    { id: 'd', t: 3, type: 'chat', user: 'u4', text: 'wow' },
    { id: 'e', t: 4, type: 'chat', user: 'u5', text: 'incredible' },
    { id: 'f', t: 5, type: 'chat', user: 'u6', text: 'LETS GO' },
  ];
  const written = writeCaptionSync(moment('spike', events));
  assert.ok(written.dialogue.length <= 4);
  assert.ok(!written.dialogue.some((line) => line.includes('<script>')));
  assert.ok(written.dialogue.some((line) => line.includes('[redacted]')));
  assert.equal(new Set(written.dialogue).size, written.dialogue.length, 'dialogue is deduplicated');
});

test('WRITER-02: sources list the contributing message ids', () => {
  const events: StreamEvent[] = [{ id: 'msg-1', t: 0, type: 'raid', from: 'Crew', viewers: 12 }];
  const written = writeCaptionSync(moment('raid', events));
  assert.deepEqual(written.sources, ['msg-1']);
});

test('WRITER-03: two different moments never produce the same caption', () => {
  const a = moment('spike', [{ id: 'a1', t: 0, type: 'chat', user: 'u1', text: 'GO GO GO' }]);
  const b = moment('spike', [{ id: 'b1', t: 10, type: 'chat', user: 'u2', text: 'GO GO GO' }]);
  const firstCaption = writeCaptionSync(a).caption;
  const secondCaption = writeCaptionSync(b, { recentCaptions: [firstCaption] }).caption;
  assert.notEqual(firstCaption, secondCaption);
});

test('WRITER-04: captions vary by moment kind and are never the old fixed string', () => {
  const kinds: LiveMoment['kind'][] = ['raid', 'cheer', 'hype', 'redemption', 'poll', 'clip', 'spike', 'burst', 'chat'];
  const captions = kinds.map((kind) => writeCaptionSync(moment(kind, [{ id: `${kind}-1`, t: 0, type: kind === 'chat' ? 'chat' : kind === 'spike' || kind === 'burst' ? 'chat' : kind, text: 'hooray', user: 'u1' }])).caption);
  assert.equal(new Set(captions).size, captions.length);
  assert.ok(captions.every((caption) => caption !== 'A selected chat moment.'));
});

test('WRITER-05: raw chat text and usernames never appear in the art-prompt scene description', () => {
  const events: StreamEvent[] = [{ id: 'a', t: 0, type: 'chat', user: 'secretUser123', text: 'a very specific raw chat line nobody should quote' }];
  const scene = describeScene(moment('spike', events));
  assert.ok(!scene.includes('secretUser123'));
  assert.ok(!scene.includes('a very specific raw chat line'));
});

test('WRITER-06: deterministicWriter resolves the same synchronous result wrapped in a promise', async () => {
  const events: StreamEvent[] = [{ id: 'a', t: 0, type: 'cheer', user: 'u1', text: 'cheer!' }];
  const sync = writeCaptionSync(moment('cheer', events));
  const written = await deterministicWriter.write(moment('cheer', events));
  assert.deepEqual(written, sync);
});

test('WRITER-07: the uniqueness guard varies real content before ever falling back to a numeric suffix', () => {
  const crowd = (prefix: string, t: number, extra: string): StreamEvent[] => [
    ...Array.from({ length: 5 }, (_, i): StreamEvent => ({ id: `${prefix}-${i}`, t: t + i, type: 'chat', user: `u${i}`, text: 'GO GO GO' })),
    { id: `${prefix}-x`, t: t + 5, type: 'chat', user: 'u9', text: extra },
  ];
  const first = writeCaptionSync(moment('spike', crowd('a', 0, 'what a play'))).caption;
  const second = writeCaptionSync(moment('spike', crowd('b', 300, 'unreal timing')), { recentCaptions: [first] }).caption;
  assert.notEqual(first, second);
  assert.match(first, /"GO GO GO"/);
  assert.match(second, /"GO GO GO", 5:00 in\.$/, 'the same crowd line is anchored to its own moment in the stream');
  const third = writeCaptionSync(moment('spike', crowd('b', 300, 'unreal timing')), { recentCaptions: [first, second] }).caption;
  assert.match(third, /"unreal timing"/, 'next, a different real line is quoted');
  for (const caption of [second, third]) assert.doesNotMatch(caption, /\(#?\d+\)/);
  const cheerA = moment('cheer', [{ id: 'c1', t: 30, type: 'cheer', user: 'u1' }]);
  const cheerB = moment('cheer', [{ id: 'c2', t: 95, type: 'cheer', user: 'u2' }]);
  const cheer1 = writeCaptionSync(cheerA).caption;
  const cheer2 = writeCaptionSync(cheerB, { recentCaptions: [cheer1] }).caption;
  assert.notEqual(cheer1, cheer2);
  assert.match(cheer2, /at 1:35 into the stream/);
});

test('WRITER-08: burst captions name the repeated emote and count only the viewers who used it', () => {
  const events: StreamEvent[] = [
    { id: 'k1', t: 0, type: 'chat', user: 'a', text: 'KEKW' },
    { id: 'k2', t: 1, type: 'chat', user: 'b', text: 'KEKW' },
    { id: 'n1', t: 1.5, type: 'chat', user: 'z', text: 'anyway' },
    { id: 'k3', t: 2, type: 'chat', user: 'c', text: 'KEKW KEKW' },
  ];
  const written = writeCaptionSync({ ...moment('burst', events), token: 'kekw' });
  assert.equal(written.caption, 'The same reaction floods chat: 3 viewers spam KEKW at once.');
  assert.equal(written.sfx, 'SURGE!');
  assert.equal(written.dialogue[0], 'KEKW');
});

function chatEvents(prefix: string, lines: string[], users: number, start = 100, step = 0.3): StreamEvent[] {
  return lines.map((text, i) => ({ id: `${prefix}-${i}`, t: start + i * step, type: 'chat' as const, user: `${prefix}-user-${i % users}`, name: `${prefix}Name${i % users}`, text }));
}

test('WRITER-09: the art scene is built from the panel content: kind, chat themes, emote meaning, crowd size and event detail', () => {
  const scene = (m: LiveMoment) => describeScene(m);
  // Crowd size and intensity change a spike's scene.
  const smallSpike = scene(moment('spike', chatEvents('s', Array(6).fill('lets go'), 3)));
  const hugeSpike = scene(moment('spike', chatEvents('h', Array(40).fill('lets go'), 30)));
  assert.notEqual(smallSpike, hugeSpike);
  assert.match(smallSpike, /small knot/);
  assert.match(hugeSpike, /vast, overflowing crowd/);
  // Paraphrased chat themes change it too.
  const laughing = scene(moment('chat', chatEvents('l', ['lol', 'haha that was funny', 'lmao'], 3)));
  const worried = scene(moment('chat', chatEvents('w', ['oh no', 'that was close', 'yikes'], 3)));
  assert.notEqual(laughing, worried);
  assert.match(laughing, /laughter/);
  assert.match(worried, /held breath/);
  // A burst is drawn by the emote's meaning.
  const kekw = scene({ ...moment('burst', chatEvents('k', ['KEKW', 'KEKW', 'KEKW'], 3)), token: 'kekw' });
  const pog = scene({ ...moment('burst', chatEvents('p', ['PogChamp', 'PogChamp', 'PogChamp'], 3)), token: 'pogchamp' });
  assert.notEqual(kekw, pog);
  assert.match(kekw, /wheezing, tearful laughter/);
  assert.match(pog, /astonishment/);
  // Event detail: raid size, hype level, cheer size.
  const raid = (viewers: number) => scene(moment('raid', [{ id: `r${viewers}`, t: 5, type: 'raid', from: 'SomeCrew', viewers }]));
  assert.notEqual(raid(3), raid(500));
  const hype = (level: number) => scene(moment('hype', [{ id: `h${level}`, t: 5, type: 'hype', level }]));
  assert.notEqual(hype(1), hype(4));
  assert.match(hype(4), /4 carriages/);
  const cheer = (text: string) => scene(moment('cheer', [{ id: text, t: 5, type: 'cheer', user: 'c', text }]));
  assert.notEqual(cheer('cheer10 nice'), cheer('cheer5000 wow'));
  // Every kind still reads as its own kind.
  const kinds = new Set((['raid', 'cheer', 'hype', 'redemption', 'poll', 'clip', 'spike', 'burst', 'chat'] as const)
    .map((kind) => scene(moment(kind, [{ id: kind, t: 5, type: kind === 'spike' || kind === 'burst' ? 'chat' : kind, user: 'u', text: 'hello' }]))));
  assert.equal(kinds.size, 9);
});

test('WRITER-10: art scenes and prompts never carry raw chat, emote tokens or usernames, for any kind', () => {
  const raw = ['zorblax wins the flumph cup', 'no way', 'KEKW', 'PogChamp', 'GO GO GO!!', 'I did not expect that', 'that was close'];
  const users = ['secretUser123', 'quuxDisplay'];
  const events: StreamEvent[] = raw.map((text, i) => ({ id: `x${i}`, t: 50 + i, type: 'chat', user: users[i % 2], name: `${users[i % 2]}Name`, text }));
  const forbidden = [...raw.filter((line) => line.length >= 4), 'zorblax', 'flumph', 'kekw', 'pogchamp', ...users];
  const kinds = ['raid', 'cheer', 'hype', 'redemption', 'poll', 'clip', 'spike', 'burst', 'chat'] as const;
  for (const kind of kinds) {
    const strong: StreamEvent[] = kind === 'spike' || kind === 'burst' || kind === 'chat' ? [] : [{ id: `${kind}-e`, t: 49, type: kind, user: 'secretUser123', from: 'quuxDisplay', viewers: 77, level: 3, text: 'cheer100 zorblax' }];
    const m: LiveMoment = { ...moment(kind, [...strong, ...events]), token: kind === 'burst' ? 'kekw' : undefined };
    const written = writeCaptionSync(m);
    for (const text of [written.scene, buildArtPrompt(written.scene)]) {
      for (const word of forbidden) assert.ok(!text.toLowerCase().includes(word.toLowerCase()), `${kind} scene must not contain "${word}": ${text}`);
    }
  }
});

test('WRITER-11: the same content drawn again gets a different scene, so two panels never request the same image', () => {
  const m = moment('spike', chatEvents('d', Array(12).fill('GO GO GO'), 6));
  const scenes: string[] = [];
  for (let i = 0; i < 25; i++) scenes.push(writeCaptionSync(m, { recentScenes: scenes }).scene);
  assert.equal(new Set(scenes).size, scenes.length);
  assert.equal(new Set(scenes.map((scene) => buildArtPrompt(scene))).size, scenes.length);
  assert.ok(scenes.every((scene) => scene.includes('wall of speech-shaped bursts')), 'variants keep the content, changing only framing and backdrop');
});

test('WRITER-12: repeated captions vary by content and never fall back to a numeric counter', () => {
  const m = moment('cheer', [{ id: 'c1', t: 10, type: 'cheer', user: 'u', text: 'cheer100' }]);
  const captions: string[] = [];
  for (let i = 0; i < 12; i++) captions.push(writeCaptionSync(m, { recentCaptions: captions }).caption);
  assert.ok(captions.every((caption) => !/\(#?\d+\)/.test(caption)), captions.join(' | '));
});
