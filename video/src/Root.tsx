import "./loadFonts";
import React from "react";
import { AbsoluteFill, Composition, interpolate, Sequence, staticFile } from "remotion";
import { Audio } from "@remotion/media";
import { TransitionSeries, linearTiming } from "@remotion/transitions";
import { fade } from "@remotion/transitions/fade";
import { slide } from "@remotion/transitions/slide";
import { wipe } from "@remotion/transitions/wipe";
import { Captions, ScreenScene, type Callout, type Cap, type Track, type Zoom } from "./components";
import { Architecture, Intro, LiveSetup, Outro, Problem, TechStack, UseCase } from "./scenes";
import { FPS, H, sec, W } from "./theme";
import script from "../narration/script.json";
import manifest from "./voice-manifest.json";
import trackData from "./tracks.json";

// ---------------------------------------------------------------------------
// Narration timing: every scene is as long as its narration (plus a short lead
// and tail), and captions are the narrated sentences at their measured times.
// ---------------------------------------------------------------------------
const LEAD = 0.65; // seconds before the first sentence (covers the transition in)
const TAIL = 0.7;
const GAP = 0.4;

type Item = Cap & { file: string; dur: number };
type Narr = { items: Item[]; total: number; starts: number[] };

const scriptScenes = script.scenes as Record<string, { text: string }[]>;
const durations = manifest as Record<string, number[]>;

const narr = (id: string): Narr => {
  const texts = scriptScenes[id];
  const durs = durations[id];
  let t = LEAD;
  const items: Item[] = texts.map((x, i) => {
    const it = { from: t, to: t + durs[i] + 0.2, text: x.text, file: `voice/${id}-${i}.mp3`, dur: durs[i] };
    t += durs[i] + GAP;
    return it;
  });
  return { items, total: t - GAP + TAIL, starts: items.map((i) => i.from) };
};

const tracks = trackData as unknown as Record<string, Record<string, Track>>;
// A callout appears in scene seconds (after the narrator says the words) and follows a measured element.
const co = (from: number, to: number, target: string, label: string, side?: Callout["side"]): Callout => ({ from, to, target, label, side });
const zoom = (from: number, to: number, focus: [number, number], scale: number): Zoom => ({ from, to, focus, scale });

const LABEL = "Recorded from the Sample demo";

type Scene = { id: string; secs: number; node: React.ReactNode; tr?: "fade" | "slide" | "wipe"; capBottom?: number; n: Narr };

type ClipOpts = {
  clip: string; start: number; span: number; chapter: { n: string; label: string };
  track?: string; callouts?: Callout[]; zooms?: Zoom[]; bg?: "ink" | "teal"; frameLabel?: string; min?: number;
};

const clipScene = (id: string, o: ClipOpts, tr?: Scene["tr"]): Scene => {
  const n = narr(id);
  const secs = Math.max(o.min ?? 0, n.total);
  const speed = Math.min(2.2, Math.max(0.8, o.span / secs));
  return {
    id, secs, tr, n, capBottom: 18,
    node: <ScreenScene clip={o.clip} start={o.start} speed={speed} chapter={o.chapter} callouts={o.callouts} zooms={o.zooms} tracks={o.track ? tracks[o.track] : undefined} bg={o.bg} frameLabel={o.frameLabel ?? LABEL} />,
  };
};

const titleScene = (id: string, min: number, node: (n: Narr) => React.ReactNode, tr?: Scene["tr"]): Scene => {
  const n = narr(id);
  return { id, secs: Math.max(min, n.total), node: node(n), tr, n, capBottom: -1 };
};

const heroN = narr("what-hero");
const archN = narr("arch");
const conN = narr("connect");
const stuN = narr("studio");
const viewN = narr("viewers");

const scenes: Scene[] = [
  titleScene("intro", 7, () => <Intro />),
  titleScene("problem", 0, (n) => <Problem at={n.starts} />, "slide"),
  {
    id: "what-hero", secs: heroN.total, tr: "wipe", n: heroN, capBottom: 18,
    node: (
      <ScreenScene
        clip="" still="clips/hero.png" chapter={{ n: "01", label: "WHAT IT IS" }} frameLabel={LABEL}
        tracks={tracks.hero}
        callouts={[
          co(heroN.starts[0] + 1.4, heroN.starts[0] + heroN.items[0].dur + 0.3, "title", "Chat becomes panels", "top"),
          co(heroN.starts[1] + 1.2, heroN.starts[1] + 3.6, "connectBtn", "Your channel", "left"),
          co(heroN.starts[1] + 3.7, heroN.starts[1] + heroN.items[1].dur, "sampleBtn", "Or the Sample", "right"),
        ]}
        zooms={[zoom(heroN.starts[0], heroN.starts[0] + heroN.items[0].dur + 1.2, [960, 330], 1.25)]}
      />
    ),
  },
  clipScene("what-scroll", { clip: "landing", start: 3.2, span: 12, chapter: { n: "01", label: "WHAT IT IS" } }),
  { id: "arch", secs: archN.total, tr: "slide", n: archN, capBottom: 30, node: <Architecture at={archN.starts} /> },
  titleScene("usecase", 7, () => <UseCase />, "wipe"),
  clipScene("connect", { clip: "connect", track: "connect", start: 0.9, span: 10, chapter: { n: "02", label: "CONNECT TWITCH" }, callouts: [co(conN.starts[0] + 0.9, conN.starts[0] + conN.items[0].dur - 0.6, "connect", "Sign in with Twitch", "right")] }),
  titleScene("keys", 0, (n) => <LiveSetup at={n.starts} />, "wipe"),
  clipScene("studio", {
    clip: "studio", track: "studio", start: 2, span: 27, chapter: { n: "03", label: "STUDIO" },
    callouts: [
      co(stuN.starts[0] + 0.5, stuN.starts[0] + 2.6, "sampleSwitch", "Sample mode", "bottom"),
      co(stuN.starts[0] + 2.8, stuN.starts[0] + stuN.items[0].dur + 0.2, "runDemo", "Run demo", "bottom"),
      co(stuN.starts[1] + 2.8, stuN.starts[1] + stuN.items[1].dur + 0.9, "stats", "Live counters", "bottom"),
    ],
  }),
  clipScene("viewers", { clip: "studio", track: "studio", start: 34.5, span: 18, chapter: { n: "03", label: "STUDIO · VIEWERS" }, callouts: [co(viewN.starts[1] + 1.5, viewN.starts[1] + viewN.items[1].dur + 0.2, "audiencePreview", "Audience preview", "left")] }, undefined),
  clipScene("audience", { clip: "audience", start: 1.5, span: 16, chapter: { n: "04", label: "AUDIENCE VIEW" } }, "slide"),
  clipScene("catchup", { clip: "catchup", start: 2.5, span: 12, chapter: { n: "04", label: "CATCH-UP" } }),
  clipScene("library", { clip: "output", start: 2, span: 16, chapter: { n: "05", label: "LIBRARY & EXPORT" } }, "wipe"),
  clipScene("recap", { clip: "recap", start: 2, span: 17, chapter: { n: "05", label: "RECAP" }, min: 8 }),
  clipScene("book", { clip: "book", start: 2, span: 14.5, chapter: { n: "05", label: "COMIC BOOK" }, min: 8 }),
  clipScene("manga", { clip: "manga", start: 2, span: 18, chapter: { n: "05", label: "MANGA SERIES" }, min: 8 }),
  clipScene("overlay", { clip: "overlay", start: 8, span: 28, chapter: { n: "06", label: "OBS OVERLAY" }, bg: "teal", frameLabel: "Overlay shown on a dark stand-in canvas" }, "slide"),
  titleScene("tech", 0, () => <TechStack />),
  titleScene("outro", 9, () => <Outro />, "fade"),
];

const T = 15;
const frames = scenes.map((s) => sec(s.secs));
const starts: number[] = [];
frames.reduce((acc, f, i) => {
  starts.push(acc);
  return acc + f - (i < frames.length - 1 ? T : 0);
}, 0);
const total = starts[starts.length - 1] + frames[frames.length - 1];

// Voice windows on the global timeline, used to duck the music bed under speech.
const windows = scenes.flatMap((s, i) => s.n.items.map((it) => [starts[i] + Math.round(it.from * FPS), starts[i] + Math.round((it.from + it.dur) * FPS)] as const));
const MUSIC = 0.34;
const DUCK = 0.1; // -20 dB under speech
const musicGain = (f: number) => {
  let d = 0;
  for (const [a, b] of windows) {
    const g = interpolate(f, [a - 12, a, b, b + 24], [0, 1, 1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
    if (g > d) d = g;
  }
  return MUSIC * (1 - (1 - DUCK) * d);
};

const presentation = (kind: Scene["tr"]) =>
  kind === "slide"
    ? slide({ direction: "from-right" })
    : kind === "wipe"
      ? (wipe({ direction: "from-left" }) as unknown as ReturnType<typeof slide>)
      : (fade() as unknown as ReturnType<typeof slide>);

export const Demo: React.FC = () => (
  <AbsoluteFill style={{ background: "#0d1b22" }}>
    <Audio
      src={staticFile("audio/bed.mp3")}
      volume={(f) => musicGain(f) * interpolate(f, [0, 60, total - 120, total], [0, 1, 1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })}
    />
    <TransitionSeries>
      {scenes.flatMap((s, i) => {
        const items: React.ReactNode[] = [];
        if (i > 0) items.push(<TransitionSeries.Transition key={`t-${s.id}`} presentation={presentation(s.tr)} timing={linearTiming({ durationInFrames: T })} />);
        items.push(
          <TransitionSeries.Sequence key={s.id} durationInFrames={frames[i]} premountFor={FPS}>
            {s.node}
            {s.capBottom !== undefined && s.capBottom >= 0 ? <Captions items={s.n.items} bottom={s.capBottom} /> : null}
            {s.n.items.map((it) => (
              <Sequence key={it.file} from={Math.round(it.from * FPS)} durationInFrames={Math.round(it.dur * FPS) + 6} layout="none">
                <Audio src={staticFile(it.file)} volume={1} premountFor={FPS} />
              </Sequence>
            ))}
          </TransitionSeries.Sequence>,
        );
        return items;
      })}
    </TransitionSeries>
  </AbsoluteFill>
);

export const RemotionRoot: React.FC = () => (
  <Composition id="ComicToonsDemo" component={Demo} durationInFrames={total} fps={FPS} width={W} height={H} />
);
