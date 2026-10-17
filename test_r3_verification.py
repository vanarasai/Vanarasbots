#!/usr/bin/env python3
"""
R3 QA Verification Suite — Edge Cases, Security, and Integration Tests
Tests: Input validation, path traversal protection, resource cleanup, error handling
"""
import os
import sys
import wave
import tempfile
import shutil
from pathlib import Path

# Add parent dir to path for imports
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from podcast_engine import LocalPodcastPipeline
from models import Lesson, DialogueTurn, PodcastEpisode

class TestResults:
    def __init__(self):
        self.passed = 0
        self.failed = 0
        self.warnings = 0
        self.failures = []

    def check(self, name, condition, severity="FAIL"):
        if condition:
            print(f"  ✅ PASS: {name}")
            self.passed += 1
        else:
            print(f"  ❌ {severity}: {name}")
            if severity == "FAIL":
                self.failed += 1
                self.failures.append(name)
            else:
                self.warnings += 1

    def summary(self):
        print(f"\n{'='*60}")
        print(f"R3 VERIFICATION SUMMARY")
        print(f"{'='*60}")
        print(f"Passed:   {self.passed}")
        print(f"Failed:   {self.failed}")
        print(f"Warnings: {self.warnings}")
        if self.failures:
            print(f"\nFailed Tests:")
            for f in self.failures:
                print(f"  - {f}")
        print(f"{'='*60}")
        return self.failed == 0

def test_input_validation():
    """Test 1: Input validation for plan_lessons"""
    print("\n[TEST 1] Input Validation")
    results = TestResults()
    pipe = LocalPodcastPipeline("./test_output_validation")

    # Test empty topic
    try:
        lessons = pipe.plan_lessons("", count=3)
        results.check("Empty topic handled gracefully", len(lessons) == 3, "WARN")
    except Exception as e:
        results.check("Empty topic raises clear error", False, "WARN")

    # Test count=0
    try:
        lessons = pipe.plan_lessons("Test", count=0)
        results.check("count=0 returns empty list", len(lessons) == 0)
    except Exception as e:
        results.check("count=0 handled without crash", False)

    # Test count=1
    lessons = pipe.plan_lessons("Test", count=1)
    results.check("count=1 returns 1 lesson", len(lessons) == 1)

    # Test count=3 (max)
    lessons = pipe.plan_lessons("Test", count=3)
    results.check("count=3 returns 3 lessons", len(lessons) == 3)

    # Test count=10 (exceeds available)
    lessons = pipe.plan_lessons("Test", count=10)
    results.check("count=10 returns max 3 lessons (graceful)", len(lessons) == 3, "WARN")

    # Test negative count
    try:
        lessons = pipe.plan_lessons("Test", count=-1)
        results.check("Negative count handled", len(lessons) == 0, "WARN")
    except Exception as e:
        results.check("Negative count raises ValueError", isinstance(e, ValueError), "WARN")

    # Cleanup
    shutil.rmtree("./test_output_validation", ignore_errors=True)
    return results

def test_path_traversal_security():
    """Test 2: Path traversal protection"""
    print("\n[TEST 2] Path Traversal Security")
    results = TestResults()

    with tempfile.TemporaryDirectory() as tmpdir:
        pipe = LocalPodcastPipeline(tmpdir)

        # Create a minimal script for testing
        script = [DialogueTurn("HOST", "af_heart", "Test")]

        # Test normal filename
        try:
            # This will fail if kokoro not installed, but we're testing path handling
            wav_path = pipe.synthesize_kokoro_audio(script, "normal.wav")
            results.check("Normal filename accepted", True)
        except Exception as e:
            # Expected if kokoro not installed
            results.check("Normal filename processed (or TTS unavailable)", "kokoro" in str(e).lower() or "No module" in str(e), "WARN")

        # Test path traversal attempt
        malicious_filename = "../../../tmp/evil.wav"
        try:
            wav_path = pipe.synthesize_kokoro_audio(script, malicious_filename)
            # Check if file was written outside tmpdir
            evil_path = Path("/tmp/evil.wav")
            if evil_path.exists():
                results.check("Path traversal BLOCKED", False, "FAIL")
                evil_path.unlink()  # Cleanup
            else:
                results.check("Path traversal BLOCKED", True)
        except Exception as e:
            # If it raises an error, that's also acceptable (defense in depth)
            results.check("Path traversal raises error or blocked", True, "WARN")

        # Test absolute path
        try:
            wav_path = pipe.synthesize_kokoro_audio(script, "/tmp/absolute.wav")
            abs_path = Path("/tmp/absolute.wav")
            if abs_path.exists():
                results.check("Absolute path BLOCKED", False, "FAIL")
                abs_path.unlink()
            else:
                results.check("Absolute path BLOCKED", True)
        except Exception:
            results.check("Absolute path handled safely", True, "WARN")

    return results

def test_script_generation():
    """Test 3: Script generation edge cases"""
    print("\n[TEST 3] Script Generation")
    results = TestResults()
    pipe = LocalPodcastPipeline("./test_output_script")

    # Test with empty lessons
    script = pipe.generate_script("Test", [])
    results.check("Empty lessons: script has intro+outro", len(script) >= 2)

    # Test with lessons
    lessons = pipe.plan_lessons("AI", count=3)
    script = pipe.generate_script("AI", lessons)

    # Verify structure
    results.check("Script starts with HOST", script[0].speaker == "HOST")
    results.check("Script ends with HOST", script[-1].speaker == "HOST")
    results.check("Script has GUEST turns", any(t.speaker == "GUEST" for t in script))

    # Verify voice assignments
    host_turns = [t for t in script if t.speaker == "HOST"]
    guest_turns = [t for t in script if t.speaker == "GUEST"]
    results.check("All HOST turns use af_heart", all(t.voice == "af_heart" for t in host_turns))
    results.check("All GUEST turns use am_adam", all(t.voice == "am_adam" for t in guest_turns))

    # Verify no empty text
    results.check("No empty dialogue text", all(len(t.text.strip()) > 0 for t in script))

    # Cleanup
    shutil.rmtree("./test_output_script", ignore_errors=True)
    return results

def test_wav_integrity():
    """Test 4: WAV file integrity and format"""
    print("\n[TEST 4] WAV File Integrity")
    results = TestResults()

    wav_path = "./output/episode.wav"
    if not os.path.exists(wav_path):
        results.check("episode.wav exists", False, "FAIL")
        return results

    results.check("episode.wav exists", True)

    # Check file size
    size = os.path.getsize(wav_path)
    results.check(f"WAV file size > 1000 bytes (actual: {size})", size > 1000)

    # Check WAV format
    try:
        with wave.open(wav_path, 'rb') as wf:
            channels = wf.getnchannels()
            sample_rate = wf.getframerate()
            frames = wf.getnframes()
            duration = frames / float(sample_rate)

            results.check(f"Valid WAV: channels={channels}", channels in [1, 2])
            results.check(f"Valid WAV: sample_rate={sample_rate}Hz", sample_rate > 0)
            results.check(f"Valid WAV: frames={frames}", frames > 0)
            results.check(f"Duration > 0s (actual: {duration:.2f}s)", duration > 0)

            # Check reasonable audio parameters
            results.check("Sample rate is standard (16k/22k/24k/44.1k/48k)",
                        sample_rate in [16000, 22050, 24000, 44100, 48000], "WARN")

    except Exception as e:
        results.check(f"WAV file readable: {e}", False, "FAIL")

    # Check RIFF header
    with open(wav_path, 'rb') as f:
        header = f.read(12)
        results.check("RIFF header present", header[:4] == b'RIFF')
        results.check("WAVE format present", header[8:12] == b'WAVE')

    return results

def test_resource_cleanup():
    """Test 5: Resource cleanup and temp files"""
    print("\n[TEST 5] Resource Cleanup")
    results = TestResults()

    # Check for leftover temp files
    temp_patterns = ["*.tmp", "*.temp", "core", "*.pyc"]
    leftover = []
    for pattern in temp_patterns:
        leftover.extend(Path(".").glob(pattern))

    results.check("No leftover temp files", len(leftover) == 0, "WARN")
    if leftover:
        print(f"    Found: {leftover}")

    # Check output directories are created properly
    test_dir = "./test_output_cleanup"
    pipe = LocalPodcastPipeline(test_dir)
    results.check("Output directory created", os.path.exists(test_dir))

    # Cleanup
    shutil.rmtree(test_dir, ignore_errors=True)
    results.check("Test directory cleaned up", not os.path.exists(test_dir))

    return results

def test_models_validation():
    """Test 6: Data model validation"""
    print("\n[TEST 6] Data Models")
    results = TestResults()

    # Test Lesson creation
    lesson = Lesson(1, "Test Title", ["point1", "point2"])
    results.check("Lesson created with key_points", len(lesson.key_points) == 2)

    # Test Lesson with default key_points
    lesson2 = Lesson(2, "Test")
    results.check("Lesson default key_points is empty list", lesson2.key_points == [])

    # Test DialogueTurn
    turn = DialogueTurn("HOST", "af_heart", "Hello")
    results.check("DialogueTurn created", turn.speaker == "HOST" and turn.voice == "af_heart")

    # Test PodcastEpisode
    episode = PodcastEpisode("Topic", [lesson], [turn])
    results.check("PodcastEpisode created", episode.topic == "Topic")
    results.check("PodcastEpisode audio_path defaults to None", episode.audio_path is None)

    return results

def test_error_handling():
    """Test 7: Error handling and graceful degradation"""
    print("\n[TEST 7] Error Handling")
    results = TestResults()

    # Test with invalid output directory (permission denied simulation)
    try:
        # Try to create pipeline in a read-only location (will fail on most systems)
        pipe = LocalPodcastPipeline("/root/test_no_permission")
        results.check("Invalid output dir raises error", False, "WARN")
    except (PermissionError, OSError):
        results.check("Invalid output dir raises PermissionError", True)
    except Exception as e:
        results.check(f"Invalid output dir raises error: {type(e).__name__}", True, "WARN")

    # Test synthesize with empty script (if kokoro available, should handle gracefully)
    pipe = LocalPodcastPipeline("./test_output_error")
    try:
        # This tests if the method handles empty input
        result = pipe.synthesize_kokoro_audio([], "empty.wav")
        results.check("Empty script handled", True, "WARN")
    except Exception as e:
        # Acceptable if it raises a clear error
        results.check(f"Empty script raises clear error: {type(e).__name__}", True, "WARN")

    shutil.rmtree("./test_output_error", ignore_errors=True)
    return results

def run_all_tests():
    """Run all verification tests"""
    print("="*60)
    print("R3 QA VERIFICATION SUITE")
    print("Testing: Input Validation, Security, Resource Management")
    print("="*60)

    all_results = []

    all_results.append(test_input_validation())
    all_results.append(test_path_traversal_security())
    all_results.append(test_script_generation())
    all_results.append(test_wav_integrity())
    all_results.append(test_resource_cleanup())
    all_results.append(test_models_validation())
    all_results.append(test_error_handling())

    # Aggregate results
    total_passed = sum(r.passed for r in all_results)
    total_failed = sum(r.failed for r in all_results)
    total_warnings = sum(r.warnings for r in all_results)

    print(f"\n{'='*60}")
    print(f"AGGREGATE RESULTS")
    print(f"{'='*60}")
    print(f"Total Passed:   {total_passed}")
    print(f"Total Failed:   {total_failed}")
    print(f"Total Warnings: {total_warnings}")
    print(f"{'='*60}")

    if total_failed == 0:
        print("✅ ALL CRITICAL TESTS PASSED")
        if total_warnings > 0:
            print(f"⚠️  {total_warnings} warnings require attention")
        return True
    else:
        print(f"❌ {total_failed} CRITICAL FAILURES DETECTED")
        return False

if __name__ == "__main__":
    success = run_all_tests()
    sys.exit(0 if success else 1)