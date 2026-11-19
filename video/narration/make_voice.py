"""Generates the narration with Microsoft neural TTS (edge-tts, no key needed).

Reads video/narration/script.json, writes one MP3 per sentence to video/public/voice/
and the measured durations to video/src/voice-manifest.json.

    python3 -m venv .venv && .venv/bin/pip install edge-tts
    .venv/bin/python video/narration/make_voice.py
"""
import asyncio, json, subprocess, sys
from pathlib import Path
import edge_tts

ROOT = Path(__file__).resolve().parent.parent
script = json.loads((ROOT / "narration" / "script.json").read_text())
voice = script["voice"]
out_dir = ROOT / "public" / "voice"
out_dir.mkdir(parents=True, exist_ok=True)

def duration(p: Path) -> float:
    r = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(p)], capture_output=True, text=True, check=True)
    return float(r.stdout.strip())

async def one(scene: str, i: int, item: dict) -> float:
    raw = out_dir / f"{scene}-{i}.raw.mp3"
    final = out_dir / f"{scene}-{i}.mp3"
    for attempt in range(4):
        try:
            await edge_tts.Communicate(item.get("say", item["text"]), voice, rate="+0%").save(str(raw))
            break
        except Exception as e:  # network hiccup: retry
            if attempt == 3:
                raise
            print("retry", scene, i, e, file=sys.stderr)
            await asyncio.sleep(2)
    # Even loudness per sentence (about -16 LUFS), trimmed of leading/trailing silence
    subprocess.run([
        "ffmpeg", "-y", "-loglevel", "error", "-i", str(raw),
        "-af", "silenceremove=start_periods=1:start_threshold=-50dB,areverse,silenceremove=start_periods=1:start_threshold=-50dB,areverse,loudnorm=I=-16:TP=-1.5:LRA=7",
        "-ar", "44100", "-ac", "1", "-b:a", "128k", str(final),
    ], check=True)
    raw.unlink()
    return round(duration(final), 3)

async def main():
    manifest = {}
    for scene, items in script["scenes"].items():
        manifest[scene] = [await one(scene, i, it) for i, it in enumerate(items)]
        print(scene, manifest[scene])
    (ROOT / "src" / "voice-manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    total = sum(sum(v) for v in manifest.values())
    print("voice total", round(total, 1), "s")

asyncio.run(main())
