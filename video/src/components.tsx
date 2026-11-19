import React from "react";
import { AbsoluteFill, Easing, Img, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { Video } from "@remotion/media";
import { C, DISPLAY, FPS, UI } from "./theme";

export const Logo: React.FC<{ size?: number }> = ({ size = 120 }) => (
  <svg viewBox="0 0 32 28" width={size} height={(size * 28) / 32}>
    <path d="M2 2h28v18H14l-7 6v-6H2z" fill={C.cream} stroke={C.ink} strokeWidth="2" strokeLinejoin="round" />
    <path d="M8 8h16M8 13h10" stroke={C.ink} strokeWidth="2.6" strokeLinecap="square" />
  </svg>
);

/** Halftone dot backdrop that drifts slowly. */
export const Backdrop: React.FC<{ variant?: "ink" | "wash" | "teal" | "cream" }> = ({ variant = "ink" }) => {
  const frame = useCurrentFrame();
  const bg =
    variant === "wash"
      ? "linear-gradient(145deg,#4cc3cf 0%,#ffd27a 50%,#ff8a8a 100%)"
      : variant === "teal"
        ? `linear-gradient(160deg, ${C.teal} 0%, ${C.tealDeep} 100%)`
        : variant === "cream"
          ? C.cream
          : `linear-gradient(160deg, ${C.night} 0%, #17323d 100%)`;
  const dot = variant === "cream" || variant === "wash" ? "rgba(20,43,54,0.10)" : "rgba(255,255,255,0.07)";
  return (
    <AbsoluteFill style={{ background: bg }}>
      <AbsoluteFill
        style={{
          backgroundImage: `radial-gradient(${dot} 3px, transparent 3.5px)`,
          backgroundSize: "34px 34px",
          backgroundPosition: `${frame * 0.25}px ${frame * 0.15}px`,
        }}
      />
    </AbsoluteFill>
  );
};

export type Cap = { from: number; to: number; text: string };

/** Lower-third caption pill. Times are seconds inside the current scene. */
export const Captions: React.FC<{ items: Cap[]; bottom?: number; dark?: boolean }> = ({ items, bottom = 28, dark = true }) => {
  const frame = useCurrentFrame();
  const t = frame / FPS;
  const active = items.find((c) => t >= c.from && t < c.to);
  if (!active) return null;
  const local = t - active.from;
  const dur = active.to - active.from;
  const inP = interpolate(local, [0, 0.35], [0, 1], { extrapolateRight: "clamp", easing: Easing.out(Easing.cubic) });
  const outP = interpolate(local, [dur - 0.3, dur], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const p = Math.min(inP, outP);
  return (
    <div style={{ position: "absolute", left: 0, right: 0, bottom, display: "flex", justifyContent: "center", opacity: p, translate: `0px ${(1 - inP) * 24}px` }}>
      <div
        style={{
          maxWidth: 1560,
          padding: "16px 34px",
          background: dark ? "rgba(13,27,34,0.92)" : C.cream,
          color: dark ? "#fff" : C.ink,
          border: `4px solid ${dark ? C.amber : C.ink}`,
          boxShadow: `8px 8px 0 ${dark ? C.coral : C.teal}`,
          fontFamily: UI,
          fontWeight: 600,
          fontSize: active.text.length > 84 ? 32 : 38,
          lineHeight: 1.22,
          textAlign: "center",
        }}
      >
        {active.text}
      </div>
    </div>
  );
};

export const Chip: React.FC<{ n: string; label: string }> = ({ n, label }) => {
  const frame = useCurrentFrame();
  const p = interpolate(frame, [0, 14], [0, 1], { extrapolateRight: "clamp", easing: Easing.out(Easing.cubic) });
  return (
    <div style={{ position: "absolute", left: 160, top: 12, display: "flex", alignItems: "center", gap: 0, opacity: p, translate: `${(1 - p) * -30}px 0px` }}>
      <div style={{ background: C.amber, color: C.ink, fontFamily: DISPLAY, fontSize: 34, padding: "2px 16px", border: `3px solid ${C.ink}` }}>{n}</div>
      <div style={{ background: C.cream, color: C.ink, fontFamily: DISPLAY, fontSize: 34, letterSpacing: 1.5, padding: "2px 18px", border: `3px solid ${C.ink}`, borderLeft: 0 }}>{label}</div>
    </div>
  );
};

// Seconds between a page's creation (the tracker's t=0) and the first frame of its recorded video.
export const TRACK_LAG = 0;
// The recording is shown at 1520x855 so even two-line captions sit clear of its bottom edge.
const FRAME_W = 1520;

export type Callout = { from: number; to: number; target: string; label: string; side?: "top" | "bottom" | "left" | "right" };
export type Zoom = { from: number; to: number; focus: [number, number]; scale: number };
export type Track = number[][]; // rows of [t, x, y, w, h] sampled from the live page while it was recorded
type Box = [number, number, number, number];

// Where the target element really was at source time `ts`: interpolated between the sampled boxes.
export const boxAt = (track: Track | undefined, ts: number): Box | null => {
  if (!track || track.length === 0) return null;
  let i = 0;
  while (i < track.length - 1 && track[i + 1][0] <= ts) i++;
  const a = track[i];
  const b = track[Math.min(i + 1, track.length - 1)];
  if (a[3] === 0 || b[3] === 0) return null; // not on screen
  const p = b[0] === a[0] ? 0 : Math.min(1, Math.max(0, (ts - a[0]) / (b[0] - a[0])));
  const box = [1, 2, 3, 4].map((k) => a[k] + (b[k] - a[k]) * p) as Box;
  // clip to the 1920x1080 page
  const x0 = Math.max(0, box[0]);
  const y0 = Math.max(0, box[1]);
  const x1 = Math.min(1920, box[0] + box[2]);
  const y1 = Math.min(1080, box[1] + box[3]);
  if (x1 - x0 < 8 || y1 - y0 < 8) return null;
  return [x0, y0, x1 - x0, y1 - y0];
};

const CalloutView: React.FC<{ c: Callout; box: Box | null }> = ({ c, box: bx }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame / fps;
  if (t < c.from || t > c.to || !bx) return null;
  const enter = spring({ frame: frame - c.from * fps, fps, config: { damping: 16, stiffness: 160 } });
  const exit = interpolate(t, [c.to - 0.25, c.to], [1, 0], { extrapolateLeft: "clamp" });
  const o = Math.min(1, enter) * exit;
  const [x, y, w, h] = bx;
  const side = c.side ?? "bottom";
  const pill: React.CSSProperties = {
    position: "absolute",
    background: C.coral,
    color: "#fff",
    fontFamily: DISPLAY,
    fontSize: 46,
    letterSpacing: 1.5,
    padding: "2px 22px",
    border: `4px solid ${C.ink}`,
    boxShadow: `6px 6px 0 ${C.ink}`,
    whiteSpace: "nowrap",
  };
  if (side === "bottom") Object.assign(pill, { left: 0, top: h + 18 });
  if (side === "top") Object.assign(pill, { left: 0, bottom: h + 18 });
  if (side === "left") Object.assign(pill, { right: w + 22, top: 0 });
  if (side === "right") Object.assign(pill, { left: w + 22, top: 0 });
  // The red outline sits exactly 8px outside the element, so it frames it without covering it.
  return (
    <div style={{ position: "absolute", left: x, top: y, width: w, height: h, opacity: o }}>
      <div style={{ position: "absolute", inset: -8, border: `6px solid ${C.coral}`, borderRadius: 12, boxShadow: "0 0 0 4px rgba(255,255,255,0.9), 0 0 40px rgba(238,100,113,0.6)", opacity: 0.88 + 0.12 * Math.sin(frame / 5) }} />
      <div style={pill}>{c.label}</div>
    </div>
  );
};

export const ScreenScene: React.FC<{
  clip: string;
  start?: number;
  speed?: number;
  chapter: { n: string; label: string };
  callouts?: Callout[];
  zooms?: Zoom[];
  bg?: "ink" | "teal";
  frameLabel?: string;
  still?: string;
  tracks?: Record<string, Track>;
}> = ({ clip, still, start = 0, speed = 1, chapter, callouts = [], zooms = [], bg = "ink", frameLabel, tracks }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame / fps; // scene time; zooms and callouts follow the narration
  const ts = start + t * speed + TRACK_LAG; // time inside the recording
  const k = FRAME_W / 1920;
  // Smooth zoom: blend all active zooms
  let scale = 1;
  let fx = 960;
  let fy = 540;
  for (const z of zooms) {
    const p = interpolate(t, [z.from, z.from + 0.9, z.to - 0.9, z.to], [0, 1, 1, 0], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
      easing: Easing.inOut(Easing.cubic),
    });
    if (p > 0) {
      scale = 1 + (z.scale - 1) * p;
      fx = 960 + (z.focus[0] - 960) * p;
      fy = 540 + (z.focus[1] - 540) * p;
    }
  }
  return (
    <AbsoluteFill>
      <Backdrop variant={bg} />
      <Chip n={chapter.n} label={chapter.label} />
      <div style={{ position: "absolute", left: (1920 - FRAME_W - 12) / 2, top: 66, width: FRAME_W, height: FRAME_W * 0.5625, border: `6px solid ${C.cream}`, boxShadow: `14px 14px 0 ${C.amber}`, overflow: "hidden", background: "#fff" }}>
        <div style={{ width: 1920, height: 1080, transformOrigin: "0 0", scale: String(k), position: "relative" }}>
          <div style={{ position: "absolute", inset: 0, transformOrigin: `${fx}px ${fy}px`, scale: String(scale) }}>
            {still ? (
              <Img src={staticFile(still)} style={{ width: 1920, height: 1080 }} />
            ) : (
              <Video src={staticFile(`clips/${clip}.mp4`)} trimBefore={Math.round(start * fps)} playbackRate={speed} muted style={{ width: 1920, height: 1080 }} />
            )}
            {callouts.map((c, i) => (
              <CalloutView key={i} c={c} box={boxAt(tracks?.[c.target], still ? 0 : ts)} />
            ))}
          </div>
        </div>
      </div>
      {frameLabel ? (
        <div style={{ position: "absolute", right: 160, top: 14, fontFamily: UI, fontWeight: 700, fontSize: 24, color: C.cream, letterSpacing: 2, textTransform: "uppercase", opacity: 0.85 }}>{frameLabel}</div>
      ) : null}
    </AbsoluteFill>
  );
};
