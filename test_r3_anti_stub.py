#!/usr/bin/env python3
"""
R3 Anti-Stub Verification: Ensures TTS produces real speech, not test tones.
Fails if audio duration is constant regardless of text length or if audio is a pure sine wave.
"""
import os
import sys
import wave
import struct
import math
import tempfile
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from podcast_engine import LocalPodcastPipeline
from models import DialogueTurn

def analyze_wav(filepath):
    """Return (duration, is_pure_sine, rms_variance)"""
    with wave.open(filepath, 'rb') as wf:
        n_frames = wf.getnframes()
        framerate = wf.getframerate()
        n_channels = wf.getnchannels()
        sampwidth = wf.getsampwidth()

        duration = n_frames / float(framerate)
        raw_data = wf.readframes(n_frames)

        # Convert to samples
        if sampwidth == 2:
            samples = struct.unpack(f'<{len(raw_data)//2}h', raw_data)
        else:
            samples = [0] * n_frames  # fallback

        if not samples:
            return duration, True, 0.0

        # Check for pure sine wave: zero crossings should be regular and RMS should be constant
        # Real speech has irregular zero crossings and amplitude modulation
        zero_crossings = sum(1 for i in range(1, len(samples))
                           if (samples[i-1] < 0) != (samples[i] < 0))
        zc_rate = zero_crossings / duration if duration > 0 else 0

        # Pure sine at 440Hz would have ~880 zero crossings per second
        # Real speech has 100-1000 Hz fundamental but with harmonics and noise
        is_likely_sine = 800 < zc_rate < 950  # Narrow band for 440Hz sine

        # Check RMS variance across windows (speech has prosody, sine is flat)
        window_size = framerate // 10  # 100ms windows
        rms_values = []
        for i in range(0, len(samples) - window_size, window_size):
            window = samples[i:i+window_size]
            rms = math.sqrt(sum(s*s for s in window) / len(window))
            rms_values.append(rms)

        if len(rms_values) > 1:
            mean_rms = sum(rms_values) / len(rms_values)
            variance = sum((r - mean_rms)**2 for r in rms_values) / len(rms_values)
            rms_cv = math.sqrt(variance) / mean_rms if mean_rms > 0 else 0
        else:
            rms_cv = 0

        # Pure sine has very low coefficient of variation in RMS
        is_pure_sine = is_likely_sine or (rms_cv < 0.05 and duration < 1.0)

        return duration, is_pure_sine, rms_cv

def test_tts_duration_scales_with_text():
    """CRITICAL: Audio duration must scale with text length. Stub fails this."""
    print("\n[TEST] TTS Duration Scaling (Anti-Stub)")
    pipe = LocalPodcastPipeline(tempfile.mkdtemp())

    # Short text (1 turn, ~10 words)
    short_script = [DialogueTurn("HOST", "af_heart", "Hello world.")]
    short_wav = pipe.synthesize_kokoro_audio(short_script, "short.wav")
    short_dur, short_is_sine, _ = analyze_wav(short_wav)

    # Long text (8 turns, ~200 words)
    long_script = [
        DialogueTurn("HOST", "af_heart", f"Welcome to lesson {i}. Today we discuss important concepts about artificial intelligence and machine learning.") +
        DialogueTurn("GUEST", "am_adam", f"Thank you for having me. Let's dive deep into the technical details of lesson {i}.")
        for i in range(4)
    ]
    long_wav = pipe.synthesize_kokoro_audio(long_script, "long.wav")
    long_dur, long_is_sine, _ = analyze_wav(long_wav)

    print(f"  Short script ({len(short_script)} turns): {short_dur:.2f}s")
    print(f"  Long script ({len(long_script)} turns): {long_dur:.2f}s")

    # Real TTS: long text should be significantly longer than short text
    # Stub: both might be ~0.4s or fixed duration
    assert long_dur > short_dur * 2, \
        f"FAIL: Duration does not scale with text length (short={short_dur:.2f}s, long={long_dur:.2f}s). Likely a stub."

    # Real speech: at least 0.5s per turn on average
    assert long_dur > len(long_script) * 0.5, \
        f"FAIL: Duration too short for {len(long_script)} turns ({long_dur:.2f}s). Expected >{len(long_script)*0.5}s. Likely a stub."

    print("  ✅ PASS: Duration scales with text length")

def test_audio_is_not_pure_sine():
    """CRITICAL: Audio must not be a pure sine wave test tone."""
    print("\n[TEST] Spectral Analysis (Anti-Test-Tone)")
    pipe = LocalPodcastPipeline(tempfile.mkdtemp())

    script = [DialogueTurn("HOST", "af_heart", "This is a test of the emergency broadcast system.")]
    wav_path = pipe.synthesize_kokoro_audio(script, "test.wav")
    duration, is_sine, rms_cv = analyze_wav(wav_path)

    print(f"  Duration: {duration:.2f}s")
    print(f"  RMS Coefficient of Variation: {rms_cv:.4f}")
    print(f"  Detected as pure sine: {is_sine}")

    assert not is_sine, \
        f"FAIL: Audio appears to be a pure sine wave test tone (duration={duration:.2f}s, RMS CV={rms_cv:.4f}). Real TTS required."

    print("  ✅ PASS: Audio is not a test tone")

def test_kokoro_dependency_actually_used():
    """Verify Kokoro is imported and instantiated, not just listed in requirements."""
    print("\n[TEST] Kokoro Integration Check")
    try:
        import kokoro
        print("  ✅ kokoro package is importable")
    except ImportError:
        print("  ❌ FAIL: kokoro not installed (listed in requirements.txt but not used)")
        raise AssertionError("Kokoro TTS library not available")

    # Check if podcast_engine actually uses kokoro
    import inspect
    import podcast_engine
    source = inspect.getsource(podcast_engine)

    if 'kokoro' not in source.lower() and 'KPipeline' not in source:
        print("  ❌ FAIL: podcast_engine.py does not reference kokoro/KPipeline")
        raise AssertionError("Kokoro not used in implementation - likely a stub")
    else:
        print("  ✅ podcast_engine.py references kokoro")

if __name__ == "__main__":
    print("="*60)
    print("R3 ANTI-STUB VERIFICATION SUITE")
    print("="*60)

    failures = 0
    try:
        test_tts_duration_scales_with_text()
    except AssertionError as e:
        print(f"  ❌ {e}")
        failures += 1

    try:
        test_audio_is_not_pure_sine()
    except AssertionError as e:
        print(f"  ❌ {e}")
        failures += 1

    try:
        test_kokoro_dependency_actually_used()
    except (AssertionError, ImportError) as e:
        print(f"  ❌ {e}")
        failures += 1

    print(f"\n{'='*60}")
    if failures > 0:
        print(f"RESULT: {failures} CRITICAL FAILURES - STUB DETECTED")
        print("The synthesize_kokoro_audio method is not producing real TTS audio.")
        sys.exit(1)
    else:
        print("RESULT: ALL CHECKS PASSED - Real TTS verified")
        sys.exit(0)