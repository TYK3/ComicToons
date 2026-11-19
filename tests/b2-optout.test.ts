import assert from 'node:assert/strict';
import test from 'node:test';
import * as core from '../packages/core/src/index.ts';
import { eventBus } from '../packages/core/src/index.ts';
import { Studio } from '../apps/server/src/studio.ts';
import { createDirectAdapter } from '../scripts/s2-replay-core.ts';

const { optedInCharacters } = core;
const isOptOutCommand = (core as unknown as { isOptOutCommand: (text: string | undefined, sender?: { moderator?: boolean }) => boolean }).isOptOutCommand;
const optOutCommands = (core as unknown as { optOutCommands: ReadonlySet<string> }).optOutCommands;

test('N10-OPTOUT-01: one shared core list and matcher cover !noink, !optout and !ink no', () => {
  assert.equal(typeof isOptOutCommand, 'function', 'core exports isOptOutCommand');
  assert.deepEqual([...optOutCommands].sort(), ['!ink no', '!noink', '!optout']);
  // Same matching rules the existing command parsers use: the whole message, trimmed,
  // any letter case; the two words of "!ink no" may be split by any run of whitespace.
  for (const text of ['!noink', '!NoInk', '  !optout  ', '!OPTOUT', '!ink no', '!INK   No', '\t!ink\tno ']) assert.equal(isOptOutCommand(text), true, text);
  for (const text of ['!ink', '!ink yes', '!noinks', 'please !noink', '!noink now', '!ink no thanks', 'noink', '', undefined]) assert.equal(isOptOutCommand(text), false, String(text));
});

test('N10-OPTOUT-02: core cast selection honours every opt-out command, not only !noink', () => {
  const chat = (t: number, user: string, text: string) => ({ t, type: 'chat' as const, user, name: user.toUpperCase(), text });
  assert.deepEqual(optedInCharacters([
    chat(0, 'a', '!ink'), chat(1, 'a', '!OPTOUT'),
    chat(2, 'b', '!ink'), chat(3, 'b', '!ink no'), chat(4, 'b', '!ink'),
    chat(5, 'c', '!ink'), chat(6, 'd', '!ink'), chat(7, 'd', ' !NoInk '),
  ]), ['C']);
});

test('N10-OPTOUT-03: the studio treats "!ink no" like !noink: earlier lines are purged and later ones never quoted', () => {
  const direct = createDirectAdapter();
  let clock = 0;
  const studio = new Studio({ now: () => clock, adapterFactory: () => direct.adapter});
  try {
    studio.useSource('twitch', 'optout_channel');
    const say = (id: string, user: string, text: string, t: number) => { clock = t * 1000; direct.push({ id, t, type: 'chat', user, name: user, text }); };
    say('m1', 'shy', 'secret plan revealed', 1);
    say('m2', 'loud', 'what a play', 2);
    const text = () => JSON.stringify([...studio.state.panels, ...studio.state.pendingPanels]);
    assert.ok(text().includes('secret plan revealed'), 'the line is drafted before the opt-out');
    say('m3', 'shy', '!INK   No', 3);
    assert.ok(!text().includes('secret plan revealed'), 'an opted-out viewer\u2019s drafted line is purged');
    assert.ok(!/!ink\s+no/i.test(text()), 'the command itself is never lettered');
    say('m4', 'shy', 'another secret', 4);
    assert.ok(!text().includes('another secret'), 'later lines from the opted-out viewer are not quoted');
    say('m5', 'loud', 'still here', 5);
    assert.ok(text().includes('still here'), 'other viewers are unaffected');
  } finally { studio.close(); }
});

test('N10-OPTOUT-04: a moderator\u2019s "!ink no" rejects a cameo and opts nobody out; their !noink / !optout still do', () => {
  assert.equal(isOptOutCommand('!ink no', { moderator: true }), false, 'moderator !ink no is not an opt-out');
  assert.equal(isOptOutCommand('!INK  no', { moderator: false }), true, 'a viewer\u2019s !ink no is');
  for (const text of ['!noink', '!optout']) assert.equal(isOptOutCommand(text, { moderator: true }), true, `moderator ${text}`);
  const direct = createDirectAdapter();
  let clock = 0;
  const studio = new Studio({ now: () => clock, adapterFactory: () => direct.adapter});
  try {
    studio.useSource('twitch', 'mod_channel');
    const say = (id: string, user: string, text: string, t: number, moderator = false) => { clock = t * 1000; direct.push({ id, t, type: 'chat', user, name: user, text, moderator }); };
    say('k1', 'mod', 'mod line one', 1, true);
    say('k2', 'mod', '!ink no', 2, true);
    const denied = (studio as unknown as { deniedUsers: Set<string> }).deniedUsers;
    assert.equal(denied.has('mod'), false, 'the moderator is not opted out');
    const text = () => JSON.stringify([...studio.state.panels, ...studio.state.pendingPanels]);
    assert.ok(text().includes('mod line one'), 'the moderator\u2019s earlier line is kept');
    say('k3', 'mod', 'mod line two', 3, true);
    assert.ok(text().includes('mod line two'), 'and later lines still appear');
  } finally { studio.close(); }
});

test('N10-OPTOUT-05: a real tab in "!ink\\tno" opts a non-moderator out through both studio paths (IRC and bus); a moderator’s does not', () => {
  for (const path of ['irc', 'bus'] as const) {
    const direct = createDirectAdapter();
    let clock = 0;
    const studio = new Studio({ now: () => clock, adapterFactory: () => direct.adapter});
    try {
      studio.useSource('twitch', `tab_${path}`);
      const send = (id: string, user: string, text: string, t: number, moderator = false) => {
        clock = t * 1000;
        const event = { id, t, type: 'chat' as const, user, name: user, text, moderator };
        if (path === 'irc') direct.push(event); else eventBus.emit('stream-event', event);
      };
      const denied = (studio as unknown as { deniedUsers: Set<string> }).deniedUsers;
      const shown = () => JSON.stringify([...studio.state.panels, ...studio.state.pendingPanels]);
      // An IRC line first brings the session live (the direct adapter only reports "twitch"
      // active once chat flows), and it stays in its own per-minute panel (bucket 0) so the
      // live issue is never fully emptied by the opt-out purges below, which only clear the
      // one bucket the opted-out user's own line is in.
      direct.push({ id: 'anchor', t: 0, type: 'chat', user: 'anchor', name: 'anchor', text: 'anchor keeps the issue live' });
      send('v1', 'viewer', 'viewer line before', 100);
      assert.ok(shown().includes('viewer line before'), `${path}: the line is drafted before the opt-out`);
      send('v2', 'viewer', '!ink\tno', 101);
      assert.equal(denied.has('viewer'), true, `${path}: a real tab opts a non-moderator out`);
      assert.ok(!shown().includes('viewer line before'), `${path}: the opted-out viewer’s earlier line is purged`);
      send('v3', 'viewer', 'viewer line after', 102);
      assert.ok(!shown().includes('viewer line after'), `${path}: later lines from the opted-out viewer are never quoted`);
      send('m1', 'mod', 'mod line before', 200, true);
      send('m2', 'mod', '!ink\tno', 201, true);
      assert.equal(denied.has('mod'), false, `${path}: a moderator’s tab variant is not an opt-out`);
      send('m3', 'mod', 'mod line after', 202, true);
      assert.ok(shown().includes('mod line before') && shown().includes('mod line after'), `${path}: the moderator’s lines stay`);
    } finally { studio.close(); }
  }
});
