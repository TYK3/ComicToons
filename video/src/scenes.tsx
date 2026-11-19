import React from "react";
import { AbsoluteFill, Easing, Img, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { Backdrop, Logo } from "./components";
import { C, DISPLAY, FPS, UI } from "./theme";

const ease = Easing.out(Easing.cubic);
const useT = () => useCurrentFrame() / FPS;
const reveal = (t: number, at: number, d = 0.5) => interpolate(t, [at, at + d], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: ease });

const Panel: React.FC<{ n: number; style: React.CSSProperties }> = ({ n, style }) => (
  <div style={{ position: "absolute", width: 420, height: 236, border: `6px solid ${C.ink}`, boxShadow: `10px 10px 0 ${C.ink}`, background: "#fff", overflow: "hidden", ...style }}>
    <Img src={staticFile(`art/panel-story-tabletop-${n}.png`)} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
  </div>
);

export const Intro: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame / fps;
  const logoP = spring({ frame: frame - 6, fps, config: { damping: 11, stiffness: 120 } });
  const word = "COMICTOONS";
  return (
    <AbsoluteFill>
      <Backdrop variant="wash" />
      <Panel n={0} style={{ left: 1260, top: 90, rotate: "4deg", opacity: reveal(t, 0.6), translate: `${(1 - reveal(t, 0.6)) * 200}px 0px` }} />
      <Panel n={2} style={{ left: 1340, top: 380, rotate: "-3deg", opacity: reveal(t, 1.0), translate: `${(1 - reveal(t, 1.0)) * 200}px 0px` }} />
      <Panel n={1} style={{ left: 1230, top: 680, rotate: "2deg", opacity: reveal(t, 1.4), translate: `${(1 - reveal(t, 1.4)) * 200}px 0px` }} />
      <div style={{ position: "absolute", left: 130, top: 250, display: "flex", alignItems: "center", gap: 36 }}>
        <div style={{ scale: String(logoP), rotate: `${(1 - logoP) * -20}deg` }}>
          <Logo size={190} />
        </div>
        <div style={{ fontFamily: DISPLAY, fontSize: 170, color: C.ink, letterSpacing: 6, textShadow: `7px 7px 0 ${C.cream}`, display: "flex" }}>
          {word.split("").map((ch, i) => {
            const p = spring({ frame: frame - 14 - i * 2, fps, config: { damping: 12, stiffness: 140 } });
            return (
              <span key={i} style={{ display: "inline-block", translate: `0px ${(1 - p) * 60}px`, opacity: Math.min(1, p) }}>
                {ch}
              </span>
            );
          })}
        </div>
      </div>
      <div style={{ position: "absolute", left: 140, top: 520, fontFamily: DISPLAY, fontSize: 92, color: C.ink, letterSpacing: 3, textShadow: `5px 5px 0 ${C.cream}`, opacity: reveal(t, 1.6), translate: `0px ${(1 - reveal(t, 1.6)) * 30}px` }}>
        YOUR STREAM, INKED LIVE.
      </div>
      <div style={{ position: "absolute", left: 144, top: 690, fontFamily: UI, fontWeight: 700, fontSize: 40, color: C.ink, maxWidth: 900, lineHeight: 1.3, opacity: reveal(t, 2.4) }}>
        Twitch chat moments become comic and manga pages that the streamer approves.
      </div>
      <div style={{ position: "absolute", left: 144, top: 900, display: "flex", gap: 18, opacity: reveal(t, 3.2) }}>
        {["Demo walkthrough", "Codex × TwitchCon hackathon"].map((s) => (
          <div key={s} style={{ background: C.ink, color: C.cream, fontFamily: UI, fontWeight: 700, fontSize: 28, padding: "10px 22px", letterSpacing: 1.5, textTransform: "uppercase" }}>
            {s}
          </div>
        ))}
      </div>
    </AbsoluteFill>
  );
};

const problems = [
  { n: "1", h: "Streams move fast", p: "The best moments scroll past in chat, then they are gone.", c: C.teal },
  { n: "2", h: "Late arrivals are lost", p: "A new viewer joins mid-stream and has no idea what just happened.", c: C.amber },
  { n: "3", h: "Clips miss the crowd", p: "A clip shows the video, but not what chat was saying at the time.", c: C.coral },
];

export const Problem: React.FC<{ at: number[] }> = ({ at }) => {
  const t = useT();
  return (
    <AbsoluteFill>
      <Backdrop variant="ink" />
      <div style={{ position: "absolute", left: 120, top: 70, fontFamily: DISPLAY, fontSize: 40, color: C.amber, letterSpacing: 4, opacity: reveal(t, 0.1) }}>THE PROBLEM</div>
      <div style={{ position: "absolute", left: 120, top: 120, fontFamily: DISPLAY, fontSize: 112, color: C.cream, letterSpacing: 2, opacity: reveal(t, at[0]), translate: `0px ${(1 - reveal(t, at[0])) * 30}px` }}>
        A STREAM IS GREAT LIVE. THEN IT VANISHES.
      </div>
      <div style={{ position: "absolute", left: 120, right: 120, top: 330, display: "flex", gap: 40 }}>
        {problems.map((x, i) => {
          const p = reveal(t, at[1 + i], 0.6);
          return (
            <div key={x.n} style={{ flex: 1, background: C.cream, border: `6px solid ${C.ink}`, boxShadow: `12px 12px 0 ${x.c}`, padding: "30px 34px", height: 500, opacity: p, translate: `0px ${(1 - p) * 60}px` }}>
              <div style={{ fontFamily: DISPLAY, fontSize: 88, color: x.c === C.amber ? C.ink : x.c, WebkitTextStroke: x.c === C.amber ? "0" : "0", lineHeight: 1 }}>{x.n}</div>
              <div style={{ fontFamily: DISPLAY, fontSize: 58, color: C.ink, letterSpacing: 1, marginTop: 6 }}>{x.h.toUpperCase()}</div>
              <div style={{ fontFamily: UI, fontWeight: 500, fontSize: 36, color: C.ink2, marginTop: 14, lineHeight: 1.3 }}>{x.p}</div>
            </div>
          );
        })}
      </div>
      <div style={{ position: "absolute", left: 0, right: 0, bottom: 70, textAlign: "center", fontFamily: DISPLAY, fontSize: 84, color: C.amber, letterSpacing: 3, opacity: reveal(t, at[4], 0.7), scale: String(0.9 + 0.1 * reveal(t, at[4], 0.7)) }}>
        WHAT IF THE NIGHT BECAME A COMIC?
      </div>
    </AbsoluteFill>
  );
};

const stages: { n: string; h: string; p: string; tag: string }[] = [
  { n: "1", h: "Twitch", p: "Chat over IRC, EventSub events and the live video", tag: "SOURCE" },
  { n: "2", h: "Ingest", p: "De-duplicate, honour deletes and opt-outs, cap at 60 events a second", tag: "SERVER" },
  { n: "3", h: "Moments", p: "Chat spikes, repeated-emote bursts and clip clusters become candidates", tag: "DETECT" },
  { n: "4", h: "Capture", p: "Real video frames plus attributed chat, at least four distinct frames per page", tag: "SCENE" },
  { n: "5", h: "Compose", p: "A source-frame comic, or an illustrated page from the provider you choose", tag: "PAGE" },
  { n: "6", h: "Letter", p: "Editable speech balloons placed in reviewed pockets of the art", tag: "TEXT" },
  { n: "7", h: "Review", p: "The streamer chooses Release, Reject or Edit caption. Nothing airs unapproved", tag: "STUDIO" },
  { n: "8", h: "Publish", p: "Audience view, OBS overlay, and a Library of recap, comic book and manga", tag: "OUTPUT" },
];

export const Architecture: React.FC<{ at: number[] }> = ({ at: starts }) => {
  const t = useT();
  const W = 400;
  const Hh = 290;
  const gapX = 60;
  const left = 110;
  return (
    <AbsoluteFill>
      <Backdrop variant="teal" />
      <div style={{ position: "absolute", left: 110, top: 40, fontFamily: DISPLAY, fontSize: 96, color: C.cream, letterSpacing: 3, textShadow: `5px 5px 0 ${C.ink}`, opacity: reveal(t, 0.1) }}>HOW IT WORKS</div>
      {stages.map((s, i) => {
        const row = Math.floor(i / 4);
        const col = i % 4;
        const at = starts[i];
        const p = spring({ frame: Math.round((t - at) * FPS), fps: FPS, config: { damping: 15, stiffness: 130 } });
        const x = left + col * (W + gapX);
        const y = 200 + row * (Hh + 90);
        const isLast = i === stages.length - 1;
        return (
          <React.Fragment key={s.n}>
            <div
              style={{
                position: "absolute", left: x, top: y, width: W, height: Hh,
                background: C.cream, border: `6px solid ${C.ink}`, boxShadow: `10px 10px 0 ${isLast ? C.coral : C.amber}`,
                padding: "22px 26px", opacity: Math.min(1, p), scale: String(0.85 + 0.15 * Math.min(1, p)),
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
                <div style={{ width: 56, height: 56, borderRadius: 28, background: C.ink, color: C.amber, fontFamily: DISPLAY, fontSize: 40, display: "flex", alignItems: "center", justifyContent: "center" }}>{s.n}</div>
                <div style={{ fontFamily: DISPLAY, fontSize: 58, color: C.ink, letterSpacing: 1.5 }}>{s.h.toUpperCase()}</div>
              </div>
              <div style={{ fontFamily: UI, fontWeight: 700, fontSize: 19, letterSpacing: 3, color: C.tealDeep, marginTop: 12 }}>{s.tag}</div>
              <div style={{ fontFamily: UI, fontWeight: 500, fontSize: 29, color: C.ink2, marginTop: 8, lineHeight: 1.28 }}>{s.p}</div>
            </div>
            {col < 3 ? (
              <svg style={{ position: "absolute", left: x + W + 4, top: y + Hh / 2 - 22, opacity: reveal(t, at + 1.4, 0.4) }} width={gapX - 8} height="44" viewBox="0 0 52 44">
                <path d="M2 22h38M30 8l16 14-16 14" fill="none" stroke={C.cream} strokeWidth="6" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            ) : null}
            {i === 3 ? (
              <svg style={{ position: "absolute", left: 0, top: 0, width: 1920, height: 1080, opacity: reveal(t, at + 1.4, 0.4) }} viewBox="0 0 1920 1080">
                <path
                  d={`M ${left + 3 * (W + gapX) + W / 2} ${y + Hh + 8} V ${y + Hh + 45} H ${left + W / 2} V ${y + Hh + 90 - 6}`}
                  fill="none" stroke={C.cream} strokeWidth="6" strokeLinecap="round" strokeLinejoin="round" strokeDasharray="2 14"
                />
                <path d={`M ${left + W / 2 - 16} ${y + Hh + 66} l 16 20 l 16 -20`} fill="none" stroke={C.cream} strokeWidth="6" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            ) : null}
          </React.Fragment>
        );
      })}
    </AbsoluteFill>
  );
};

export const UseCase: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame / fps;
  return (
    <AbsoluteFill>
      <Backdrop variant="wash" />
      <Panel n={3} style={{ left: 1150, top: 250, width: 640, height: 360, rotate: "3deg", opacity: reveal(t, 0.4), translate: `${(1 - reveal(t, 0.4)) * 160}px 0px` }} />
      <div style={{ position: "absolute", left: 130, top: 190, fontFamily: DISPLAY, fontSize: 48, color: C.ink, letterSpacing: 5, opacity: reveal(t, 0.1) }}>SAMPLE USE CASE</div>
      <div style={{ position: "absolute", left: 130, top: 250, fontFamily: DISPLAY, fontSize: 168, color: C.ink, letterSpacing: 3, textShadow: `7px 7px 0 ${C.cream}`, opacity: reveal(t, 0.3), translate: `0px ${(1 - reveal(t, 0.3)) * 40}px` }}>
        CRITICAL MESS
      </div>
      <div style={{ position: "absolute", left: 136, top: 470, fontFamily: UI, fontWeight: 700, fontSize: 40, color: C.ink, maxWidth: 940, lineHeight: 1.3, opacity: reveal(t, 1.2) }}>
        A fictional tabletop night streamed by @juniper_rolls. Everything you are about to see is the built-in Sample: no Twitch account and no keys.
      </div>
      <div style={{ position: "absolute", left: 136, top: 760, display: "flex", gap: 16, opacity: reveal(t, 2.2) }}>
        {["Connect", "Studio", "Audience", "Library", "OBS overlay"].map((s, i) => (
          <div key={s} style={{ background: i % 2 ? C.coral : C.teal, color: "#fff", fontFamily: DISPLAY, fontSize: 38, letterSpacing: 2, padding: "4px 22px", border: `4px solid ${C.ink}`, boxShadow: `5px 5px 0 ${C.ink}` }}>
            {s.toUpperCase()}
          </div>
        ))}
      </div>
    </AbsoluteFill>
  );
};

const groups: { h: string; items: string[]; c: string }[] = [
  { h: "Front end", items: ["React 19", "Vite 6", "TypeScript"], c: C.teal },
  { h: "Server", items: ["Node 24", "Fastify 5", "sharp"], c: C.coral },
  { h: "Twitch", items: ["OAuth", "IRC chat", "EventSub", "Helix API"], c: C.twitch },
  { h: "Illustration", items: ["Source frames", "OpenAI", "Gemini", "Pollinations", "Cloudflare"], c: C.amber },
  { h: "Quality", items: ["Playwright", "axe-core", "Mock Twitch harness", "Secret scan"], c: C.tealDeep },
  { h: "Hosting", items: ["Vercel (Sample demo)", "OBS Browser Source"], c: C.ink2 },
];

export const TechStack: React.FC = () => {
  const t = useT();
  return (
    <AbsoluteFill>
      <Backdrop variant="ink" />
      <div style={{ position: "absolute", left: 120, top: 60, fontFamily: DISPLAY, fontSize: 104, color: C.cream, letterSpacing: 3, opacity: reveal(t, 0.1) }}>
        BUILT WITH
      </div>
      <div style={{ position: "absolute", left: 120, right: 120, top: 220, display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 36 }}>
        {groups.map((g, i) => {
          const p = reveal(t, 0.6 + i * 0.5, 0.5);
          return (
            <div key={g.h} style={{ background: C.cream, border: `6px solid ${C.ink}`, boxShadow: `10px 10px 0 ${g.c}`, padding: "20px 26px 26px", opacity: p, translate: `0px ${(1 - p) * 40}px`, minHeight: 300 }}>
              <div style={{ fontFamily: DISPLAY, fontSize: 56, color: C.ink, letterSpacing: 1.5 }}>{g.h.toUpperCase()}</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 10, marginTop: 14 }}>
                {g.items.map((s) => (
                  <span key={s} style={{ fontFamily: UI, fontWeight: 700, fontSize: 28, color: C.ink, background: C.amber, border: `3px solid ${C.ink}`, padding: "4px 14px" }}>
                    {s}
                  </span>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};

export const Outro: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame / fps;
  const p = spring({ frame: frame - 4, fps, config: { damping: 12, stiffness: 110 } });
  return (
    <AbsoluteFill>
      <Backdrop variant="wash" />
      <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 10 }}>
        <div style={{ scale: String(p) }}>
          <Logo size={170} />
        </div>
        <div style={{ fontFamily: DISPLAY, fontSize: 168, color: C.ink, letterSpacing: 6, textShadow: `7px 7px 0 ${C.cream}`, opacity: reveal(t, 0.4) }}>COMICTOONS</div>
        <div style={{ fontFamily: DISPLAY, fontSize: 74, color: C.ink, letterSpacing: 3, textShadow: `4px 4px 0 ${C.cream}`, opacity: reveal(t, 1.0) }}>YOUR STREAM, INKED LIVE.</div>
        <div style={{ marginTop: 34, display: "flex", gap: 22, opacity: reveal(t, 1.8) }}>
          <div style={{ background: C.ink, color: C.amber, fontFamily: UI, fontWeight: 700, fontSize: 42, padding: "14px 34px", boxShadow: `8px 8px 0 ${C.coral}` }}>Try the Sample demo</div>
          <div style={{ background: C.cream, color: C.ink, fontFamily: UI, fontWeight: 700, fontSize: 42, padding: "14px 34px", border: `5px solid ${C.ink}`, boxShadow: `8px 8px 0 ${C.teal}` }}>comictoons-demo.vercel.app</div>
        </div>
        <div style={{ marginTop: 26, fontFamily: UI, fontWeight: 600, fontSize: 30, color: C.ink, opacity: reveal(t, 2.6) }}>Built for the Codex × TwitchCon hackathon</div>
      </div>
    </AbsoluteFill>
  );
};
