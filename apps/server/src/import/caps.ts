/**
 * IMPORT-1 caps (ruling 2026-10-31 18:46: "ignore the 20 min, suggest what's reasonable; we just need
 * to demo it works"). Config constants: the router enforces them and the tests assert the same numbers.
 */
/** A VOD import reads at most this much of the VOD, from its start: the clip window is capped here. */
export const MAX_VOD_SECONDS = 600;
/** At most this many panels: one per clip, for a VOD import or for several clip links. */
export const MAX_PANELS = 6;
/** A single clip link makes 1 to this many panels (its title and thumbnail, plus the optional chat log). */
export const SINGLE_CLIP_MAX_PANELS = 4;
/** Finished imports kept in memory so "Add to my manga series" can append one without re-importing. */
export const IMPORT_RESULTS_LIMIT = 20;

const wholeMinutes = (seconds: number) => Math.max(1, Math.round(seconds / 60));
/**
 * Plain words for a clamped VOD (the lead's ruling, 22:56): shown on the card and returned with the result,
 * e.g. "Used the first 10 min of a 47 min video." Undefined when the whole video was used.
 */
export function vodClampNote(vodSeconds: number, usedSeconds = Math.min(vodSeconds, MAX_VOD_SECONDS)): string | undefined {
  if (vodSeconds <= usedSeconds) return undefined;
  return `Used the first ${wholeMinutes(usedSeconds)} min of a ${wholeMinutes(vodSeconds)} min video.`;
}

/**
 * IMPORT-LIVE-1: the "no clips" error for a VOD, in the same plain words as the clamp note. A short VOD
 * was not cut, so it is never "the first N min"; and Get Clips filters on when a clip was made, so a
 * clip made now is outside the stream window: point to a clip link instead of "make a clip".
 */
export function vodNoClipsMessage(vodSeconds: number, usedSeconds = Math.min(vodSeconds, MAX_VOD_SECONDS)): string {
  const where = vodSeconds > usedSeconds ? `in the first ${wholeMinutes(usedSeconds)} min of this ${wholeMinutes(vodSeconds)} min video` : `during this ${wholeMinutes(vodSeconds)} min video`;
  return `No clips were made ${where}, so there is nothing to turn into panels. Paste a clip link instead.`;
}
