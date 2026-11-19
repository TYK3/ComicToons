"""Synthesises an original, royalty-free ambient bed (pads + soft pulse) for the demo video."""
import numpy as np, wave, subprocess, sys
SR = 44100
DUR = float(sys.argv[1]) if len(sys.argv) > 1 else 250
out = sys.argv[2] if len(sys.argv) > 2 else "public/audio/bed.mp3"
rng = np.random.default_rng(7)
t = np.arange(int(SR * DUR)) / SR
def hz(m): return 440.0 * 2 ** ((m - 69) / 12)
# Am - F - C - G, 8 seconds per chord
chords = [[57, 60, 64, 69], [53, 57, 60, 65], [48, 55, 60, 64], [55, 59, 62, 67]]
bar = 8.0
sig = np.zeros_like(t)
for i in range(int(DUR // bar) + 1):
    notes = chords[i % 4]
    t0, t1 = i * bar, min((i + 1) * bar, DUR)
    m = (t >= t0) & (t < t1)
    lt = t[m] - t0
    env = np.minimum(1, lt / 1.5) * np.minimum(1, (bar - lt) / 1.5)
    s = np.zeros(lt.size)
    for n in notes:
        for det in (-0.3, 0.3):
            f = hz(n) * (1 + det / 100)
            s += np.sin(2 * np.pi * f * lt) * 0.5 + np.sin(2 * np.pi * 2 * f * lt) * 0.12
    sig[m] += s * env / (len(notes) * 2)
# gentle arpeggio pulse every 0.5s
pulse = np.zeros_like(t)
step = 0.5
for k in range(int(DUR / step)):
    n = chords[int(k * step // bar) % 4][k % 4] + 12
    a = int(k * step * SR); L = int(0.45 * SR)
    seg = np.arange(min(L, t.size - a)) / SR
    pulse[a:a + seg.size] += np.sin(2 * np.pi * hz(n) * seg) * np.exp(-seg * 7) * 0.10
sig = sig + pulse
sig *= 0.6 + 0.4 * (0.5 + 0.5 * np.sin(2 * np.pi * t / 16))
sig /= np.max(np.abs(sig))
sig *= 0.8
pcm = (sig * 32767).astype(np.int16)
with wave.open("/tmp/bed.wav", "wb") as w:
    w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR); w.writeframes(pcm.tobytes())
subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", "/tmp/bed.wav", "-ac", "2", "-b:a", "96k", out], check=True)
print("wrote", out)
