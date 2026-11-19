/** How long the hype-train splash stays on stream. Short, so it never sits over the panels for long. */
export const HYPE_SPLASH_MS = 4000;

/**
 * HYPE-SPLASH: a short Festival splash on the overlay when a hype train begins. It letters only what the
 * server event carries (the train level); no names, counts or other Twitch data are made up.
 */
export function HypeSplash({ level }: { level: number }) {
  return <div className="ct-ov-hype" role="status" data-level={level}>
    <p className="ct-ov-hype__title">Hype train!</p>
    <p className="ct-ov-hype__level">Level {level}</p>
  </div>;
}
