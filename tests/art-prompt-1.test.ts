import assert from 'node:assert/strict';
import test from 'node:test';
import * as imagegen from '../apps/server/src/pipeline/imagegen.ts';

// ART-PROMPT-1: buildArtPrompt hard-coded "Black-and-white manga ink ... Blank empty speech bubbles",
// so every live Studio panel came back black and white with fake bubbles. Live and import art now share
// one prompt helper: the active theme's colour words (Festival by default), no text of any kind in the
// art, clear space for the caption that is laid over it later, no face under that space, no viewer names.
type PanelPrompt = (input: { scene: string; theme?: string; names?: readonly string[] }) => string;
const buildArtPrompt = imagegen.buildArtPrompt as (scene: string, theme?: string) => string;
const buildPanelArtPrompt = (imagegen as Record<string, unknown>).buildPanelArtPrompt as PanelPrompt;
const NO_TEXT = /No text[^.]*\./;
const LAYOUT = /Leave clear empty space[^.]*\./;
/** The prompt without its no-text and layout sentences: whatever is left is what the model is asked to draw. */
const drawn = (prompt: string) => prompt.replace(NO_TEXT, '').replace(LAYOUT, '');
const writerScene = 'A calm figure listens among a handful of viewers, with a torrent of blank speech bubbles stacked edge to edge overhead. Neon signs glow behind them.';

test('ART-PROMPT-1-01: a live panel prompt asks for full colour in the Festival palette by default, not black-and-white ink', () => {
  const prompt = buildArtPrompt(writerScene);
  assert.match(prompt, /full colou?r/i);
  for (const word of ['teal', 'amber', 'coral']) assert.ok(prompt.toLowerCase().includes(word), `Festival word "${word}"`);
  assert.doesNotMatch(prompt, /black-and-white|black and white|monochrome|greyscale|grayscale|screentone/i);
});

test('ART-PROMPT-1-02: the prompt never asks for speech bubbles, captions, letters or signs, and says so outright', () => {
  const prompt = buildArtPrompt(writerScene);
  assert.match(prompt, NO_TEXT, 'one explicit no-text sentence');
  const clause = NO_TEXT.exec(prompt)![0];
  for (const word of ['letters', 'words', 'speech bubbles', 'captions', 'logos', 'signs']) assert.ok(clause.includes(word), `no-text clause names "${word}"`);
  assert.doesNotMatch(drawn(prompt), /bubble|balloon|speech|caption|letter|\bsigns?\b|text/i, `outside the no-text clause: ${drawn(prompt)}`);
});

test('ART-PROMPT-1-03: the prompt leaves clear space for the caption and keeps every face out from under it', () => {
  const prompt = buildArtPrompt(writerScene);
  assert.match(prompt, /empty space along the top/i);
  assert.match(prompt, /face/i);
  assert.match(prompt, /never cover|not cover|uncovered|clear of the top/i);
});

test('ART-PROMPT-1-04: the active theme sets the colour words; legacy or unknown themes fall back to Festival', () => {
  assert.match(buildArtPrompt(writerScene, 'sunset'), /magenta/i);
  assert.match(buildArtPrompt(writerScene, 'lagoon'), /cobalt/i);
  assert.match(buildArtPrompt(writerScene, 'blossom'), /violet/i);
  assert.equal(buildArtPrompt(writerScene, 'ink'), buildArtPrompt(writerScene));
  assert.equal(buildArtPrompt(writerScene, 'not-a-theme'), buildArtPrompt(writerScene, 'festival'));
});

test('ART-PROMPT-1-05: no viewer names reach the art prompt, whether passed in or handle-shaped', () => {
  assert.equal(typeof buildPanelArtPrompt, 'function', 'shared helper buildPanelArtPrompt is exported');
  const prompt = buildPanelArtPrompt({ scene: 'A cheer from @sample_viewer and Sample_Viewer2 lights up the stage for RaidFriend.', names: ['RaidFriend'] });
  for (const name of ['sample_viewer', 'Sample_Viewer2', 'RaidFriend', '@']) assert.ok(!prompt.includes(name), `"${name}" must not reach the prompt: ${prompt}`);
  assert.match(prompt, /A cheer lights up the stage\./);
});

test('ART-PROMPT-1-06: live and import share one helper; the live entry point is that helper with the default theme', () => {
  assert.equal(typeof buildPanelArtPrompt, 'function');
  assert.equal(buildArtPrompt(writerScene), buildPanelArtPrompt({ scene: writerScene }));
  assert.equal(buildArtPrompt(writerScene, 'lagoon'), buildPanelArtPrompt({ scene: writerScene, theme: 'lagoon' }));
});
