import "./loadFonts";
import React from "react";
import { AbsoluteFill, Composition, interpolate, staticFile } from "remotion";
import { Audio } from "@remotion/media";
import { TransitionSeries, linearTiming } from "@remotion/transitions";
import { fade } from "@remotion/transitions/fade";
import { slide } from "@remotion/transitions/slide";
import { wipe } from "@remotion/transitions/wipe";
import { ScreenScene, type Callout, type Cap, type Zoom } from "./components";
import { Architecture, Intro, Outro, Problem, TechStack, UseCase } from "./scenes";
import { FPS, H, sec, W } from "./theme";

type S = { id: string; secs: number; node: React.ReactNode; tr?: "fade" | "slide" | "wipe" };

const cap = (from: number, to: number, text: string): Cap => ({ from, to, text });
const co = (from: number, to: number, box: [number, number, number, number], label: string, side?: Callout["side"]): Callout => ({ from, to, box, label, side });
const zoom = (from: number, to: number, focus: [number, number], scale: number): Zoom => ({ from, to, focus, scale });

const LABEL = "Recorded from the Sample demo";

const scenes: S[] = [
  { id: "intro", secs: 8, node: <Intro /> },
  { id: "problem", secs: 14, node: <Problem />, tr: "slide" },
  {
    id: "what-hero", secs: 9, tr: "wipe",
    node: (
      <ScreenScene
        clip="" still="clips/hero.png" chapter={{ n: "01", label: "WHAT IT IS" }} frameLabel={LABEL}
        captions={[cap(0.5, 4.5, "ComicToons turns Twitch stream moments into comic pages."), cap(4.7, 8.6, "Connect your channel, or try the Sample with no sign-in.")]}
        callouts={[co(1.2, 4.4, [535, 150, 853, 281], "Chat becomes panels", "right"), co(4.9, 8.6, [716, 572, 250, 52], "Your channel", "left"), co(5.3, 8.6, [982, 572, 222, 52], "Or the Sample", "right")]}
        zooms={[zoom(0.4, 4.8, [960, 330], 1.25)]}
      />
    ),
  },
  {
    id: "what-scroll", secs: 8,
    node: (
      <ScreenScene
        clip="landing" start={3.2} speed={1.5} chapter={{ n: "01", label: "WHAT IT IS" }} frameLabel={LABEL}
        captions={[cap(0.3, 4.1, "The best chat moments land on the overlay as panels."), cap(4.3, 7.8, "Log off, and the whole night is a comic to share.")]}
      />
    ),
  },
  { id: "arch", secs: 33, node: <Architecture captions={[cap(1, 7.5, "Twitch chat, events and live video feed the server."), cap(7.8, 14, "Ingest and detection find the moments worth drawing."), cap(14.4, 20.6, "Frames and chat become a page, lettered with editable balloons."), cap(21, 27.5, "The streamer reviews every page, then it publishes."), cap(27.8, 32.4, "Nothing airs until the streamer says so.")]} />, tr: "slide" },
  { id: "usecase", secs: 6, node: <UseCase />, tr: "wipe" },
  {
    id: "connect", secs: 10,
    node: (
      <ScreenScene
        clip="connect" start={1.5} chapter={{ n: "02", label: "CONNECT TWITCH" }} frameLabel={LABEL}
        captions={[cap(0.4, 5, "Sign in with Twitch, or read any public chat read-only."), cap(5.3, 9.4, "Tokens stay in the API server's memory.")]}
        callouts={[co(1.5, 5, [366, 520, 420, 66], "Sign in with Twitch", "right")]}
      />
    ),
  },
  {
    id: "studio", secs: 30,
    node: (
      <ScreenScene
        clip="studio" start={2} chapter={{ n: "03", label: "STUDIO" }} frameLabel={LABEL}
        captions={[cap(0.4, 6, "In Sample mode, Run demo replays a fictional stream."), cap(6.3, 13, "Panels release automatically as the scenes unfold."), cap(13.3, 21, "Chat is simulated locally, and every panel says Sample."), cap(21.3, 29.5, "Twenty scenes later, the issue is ready to read.")]}
        callouts={[co(0.3, 2.9, [452, 74, 100, 44], "Run demo", "bottom"), co(3.1, 6, [16, 78, 150, 34], "Sample or Live", "bottom"), co(7, 12, [1130, 169, 342, 52], "Live counters", "bottom"), co(14, 20, [1494, 140, 396, 490], "Audience preview", "left")]}
      />
    ),
  },
  {
    id: "viewers", secs: 18,
    node: (
      <ScreenScene
        clip="studio" start={34.5} chapter={{ n: "03", label: "STUDIO · VIEWERS" }} frameLabel={LABEL}
        captions={[cap(0.4, 5, "Simulate a viewer joining, a raid, or a chat vote."), cap(5.3, 11, "Each one shows up in the audience preview on the same page."), cap(11.3, 17.4, "Chat votes pick the dialogue for a panel.")]}
        callouts={[co(5.5, 11, [1494, 140, 396, 490], "What viewers see", "left")]}
      />
    ),
  },
  {
    id: "audience", secs: 16, tr: "slide",
    node: (
      <ScreenScene
        clip="audience" start={1.5} chapter={{ n: "04", label: "AUDIENCE VIEW" }} frameLabel={LABEL}
        captions={[cap(0.4, 5.4, "The audience view shows released panels, with chat and votes."), cap(5.7, 10.4, "Catch-up gives late arrivals a quick recap."), cap(10.7, 15.4, "Viewers can join as a newcomer and take part.")]}
      />
    ),
  },
  {
    id: "catchup", secs: 10,
    node: (
      <ScreenScene
        clip="catchup" start={2.5} chapter={{ n: "04", label: "CATCH-UP" }} frameLabel={LABEL}
        captions={[cap(0.3, 5, "Previously on... a short preview with a 5, 15 or 30 minute window."), cap(5.2, 9.5, "Late arrivals are caught up in seconds.")]}
      />
    ),
  },
  {
    id: "library", secs: 12, tr: "wipe",
    node: (
      <ScreenScene
        clip="output" start={2} speed={1.4} chapter={{ n: "05", label: "LIBRARY & EXPORT" }} frameLabel={LABEL}
        captions={[cap(0.3, 5.8, "The Library saves every issue and bundles the outputs."), cap(6, 11.5, "Recap, comic book, manga series and catch-up, as links or PNGs.")]}
      />
    ),
  },
  {
    id: "recap", secs: 10,
    node: <ScreenScene clip="recap" start={2} speed={1.6} chapter={{ n: "05", label: "RECAP" }} frameLabel={LABEL} captions={[cap(0.3, 9.4, "The recap shows every page at a glance, with PNG downloads.")]} />,
  },
  {
    id: "book", secs: 11,
    node: <ScreenScene clip="book" start={2} speed={1.3} chapter={{ n: "05", label: "COMIC BOOK" }} frameLabel={LABEL} captions={[cap(0.3, 10.4, "The comic book reads cover to back page, two pages at a time.")]} />,
  },
  {
    id: "manga", secs: 10,
    node: <ScreenScene clip="manga" start={2} speed={1.7} chapter={{ n: "05", label: "MANGA SERIES" }} frameLabel={LABEL} captions={[cap(0.3, 9.4, "The same story reads as a manga series, episode by episode.")]} />,
  },
  {
    id: "overlay", secs: 20, tr: "slide",
    node: (
      <ScreenScene
        clip="overlay" start={8} speed={1.4} chapter={{ n: "06", label: "OBS OVERLAY" }} frameLabel="Overlay shown on a dark stand-in canvas" bg="teal"
        captions={[cap(0.4, 6, "For broadcast, the clean overlay is an OBS Browser Source."), cap(6.3, 13, "Released panels, votes and catch-up cards appear over the stream."), cap(13.3, 19.4, "Panic hide blanks the output instantly.")]}
      />
    ),
  },
  { id: "tech", secs: 13, node: <TechStack captions={[cap(0.8, 6.3, "React and Vite up front. Fastify and Node on the server."), cap(6.6, 12.4, "Twitch OAuth, IRC and EventSub, tested with Playwright.")]} /> },
  { id: "outro", secs: 9, node: <Outro />, tr: "fade" },
];

const T = 15;
const total = scenes.reduce((a, s) => a + sec(s.secs), 0) - T * (scenes.length - 1);

const presentation = (kind: S["tr"]) => (kind === "slide" ? slide({ direction: "from-right" }) : kind === "wipe" ? (wipe({ direction: "from-left" }) as unknown as ReturnType<typeof slide>) : (fade() as unknown as ReturnType<typeof slide>));

export const Demo: React.FC = () => {
  return (
    <AbsoluteFill style={{ background: "#0d1b22" }}>
      <Audio
        src={staticFile("audio/bed.mp3")}
        volume={(f) => interpolate(f, [0, 60, total - 120, total], [0, 0.32, 0.32, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })}
      />
      <TransitionSeries>
        {scenes.flatMap((s, i) => {
          const items: React.ReactNode[] = [];
          if (i > 0) items.push(<TransitionSeries.Transition key={`t-${s.id}`} presentation={presentation(s.tr)} timing={linearTiming({ durationInFrames: T })} />);
          items.push(
            <TransitionSeries.Sequence key={s.id} durationInFrames={sec(s.secs)} premountFor={FPS}>
              {s.node}
            </TransitionSeries.Sequence>,
          );
          return items;
        })}
      </TransitionSeries>
    </AbsoluteFill>
  );
};

export const RemotionRoot: React.FC = () => (
  <Composition id="ComicToonsDemo" component={Demo} durationInFrames={total} fps={FPS} width={W} height={H} />
);
