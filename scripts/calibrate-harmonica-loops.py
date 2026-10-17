"""Derive loop offsets from decoded MP3 PCM (mono float32, 44100 Hz).

Decode the unchanged bundled samples with Web Audio first, then run:
python scripts/calibrate-harmonica-loops.py <pcm-directory> <output.json>
Requires numpy for correlation; it is a development tool, not a runtime dependency.
"""
import json
import math
from pathlib import Path
import sys
import numpy as np

RATE = 44100


def midi(name):
    pitch = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}[name[0]]
    return (int(name[-1]) + 1) * 12 + pitch + (1 if "#" in name else -1 if "b" in name else 0)


def find_loop(wave, frequency, musyngkite=False):
    # Match both sides of a seam in the steady region, after the original attack.
    width = max(256, min(4096, round(RATE / frequency * 4)))
    if width % 2:
        width += 1
    half = width // 2
    best = None
    tolerance = 0.12 if musyngkite else 0.02
    search = range(round(0.60 * RATE), round(2.0 * RATE), 401) if musyngkite else range(round(0.85 * RATE), round(1.10 * RATE), 137)
    for start in search:
        reference = wave[start - half:start + half]
        lo = start + round((0.10 if musyngkite else 0.30) * RATE)
        hi = min(start + round(0.75 * RATE), len(wave) - half - 1)
        region = wave[lo - half:hi + half]
        size = 1 << (len(region) + width - 1).bit_length()
        correlation = np.fft.irfft(np.fft.rfft(region, size) * np.fft.rfft(reference[::-1], size), size)[width - 1:len(region)]
        energy = np.concatenate(([0.0], np.cumsum(region * region)))
        energy = energy[width:] - energy[:-width]
        error = np.maximum(0, energy + np.sum(reference * reference) - 2 * correlation)
        normalized = error / (energy + np.sum(reference * reference) + 1e-20)
        index = int(np.argmin(normalized))
        candidate = (float(normalized[index]), start, lo + index)
        if best is None or candidate < best:
            best = candidate
    if best is None or not math.isfinite(best[0]) or best[0] > tolerance:
        raise ValueError(f"No stable loop for {frequency:.2f} Hz: {best}")
    _, start, end = best
    # Keep the matched period but place the join where value and slope agree best.
    offsets = np.arange(-half // 2, half // 2 + 1)
    left, right = start + offsets, end + offsets
    delta = wave[left] - wave[right]
    slope = (wave[left + 1] - wave[left - 1]) - (wave[right + 1] - wave[right - 1])
    shift = int(offsets[np.argmin(delta * delta + slope * slope)])
    start, end = start + shift, end + shift
    a, b = wave[start - half:start + half], wave[end - half:end + half]
    error = float(np.sum((a - b) ** 2) / (np.sum(a * a + b * b) + 1e-20))
    if not math.isfinite(error) or error > tolerance:
        raise ValueError(f"Shifted loop is not stable: {frequency:.2f} Hz, {error}")
    return error, start, end


def main():
    if len(sys.argv) not in (3, 4) or (len(sys.argv) == 4 and sys.argv[3] != "--musyngkite"):
        raise SystemExit("Usage: calibrate-harmonica-loops.py <pcm-directory> <output.json> [--musyngkite]")
    source, target = map(Path, sys.argv[1:3])
    musyngkite = len(sys.argv) == 4
    loops, evidence = {}, []
    paths = sorted(source.glob("*.f32"), key=lambda p: midi(p.stem))
    if [midi(p.stem) for p in paths] != list(range(21, 109)):
        raise ValueError("Expected the complete A0–C8 bank (88 decoded PCM samples)")
    for path in paths:
        wave = np.fromfile(path, dtype="<f4").astype(np.float64)
        frequency = 440 * 2 ** ((midi(path.stem) - 69) / 12)
        error, start, end = find_loop(wave, frequency, musyngkite)
        loops[path.stem] = [start, end]
        evidence.append({"note": path.stem, "midi": midi(path.stem), "frequency": frequency, "start": start, "end": end, "seamError": error})
    target.write_text(json.dumps(loops, separators=(",", ":")) + "\n", encoding="utf-8")
    Path("work").mkdir(exist_ok=True)
    (Path("work") / ("musyngkite-calibration-evidence.json" if musyngkite else "harmonica-calibration-evidence.json")).write_text(json.dumps(evidence, indent=2), encoding="utf-8")
    print(json.dumps({"notes": len(loops), "worstSeamError": max(n["seamError"] for n in evidence)}, indent=2))


if __name__ == "__main__":
    main()
