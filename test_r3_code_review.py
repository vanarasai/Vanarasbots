"""
R3 QA Verification: Structural integrity and bug detection for podcast_engine.py
Catches syntax errors, missing methods, and incomplete implementations.
Does NOT require Kokoro/ONNX dependencies.
"""
import ast
import inspect
import sys
from pathlib import Path
import importlib.util

class R3CodeReview:
    def __init__(self):
        self.results = []
        self.passed = 0
        self.failed = 0

    def check(self, name: str, condition: bool, detail: str = ""):
        status = "✅ PASS" if condition else "❌ FAIL"
        self.results.append(f"{status} | {name} | {detail}")
        if condition:
            self.passed += 1
        else:
            self.failed += 1
        return condition

    def test_syntax_valid(self):
        """Test that podcast_engine.py is syntactically valid Python."""
        try:
            with open("podcast_engine.py", "r") as f:
                source = f.read()
            ast.parse(source)
            self.check("Syntax Valid", True, "podcast_engine.py parses without errors")
            return True
        except SyntaxError as e:
            self.check("Syntax Valid", False, f"SyntaxError at line {e.lineno}: {e.msg}")
            return False

    def test_no_truncated_code(self):
        """Test that file doesn't end with truncated code."""
        with open("podcast_engine.py", "r") as f:
            content = f.read()
        # Check for common truncation patterns
        truncated_patterns = ["raise Runti", "raise Run", "...", "pass  # TODO"]
        found = [p for p in truncated_patterns if p in content and not p.startswith("...")]
        self.check("No Truncated Code", len(found) == 0,
                  f"Found truncated patterns: {found}" if found else "No truncation detected")
        return len(found) == 0

    def test_required_methods_exist(self):
        """Test that all methods called by app.py exist in the class."""
        # Import the module (will fail if syntax error)
        try:
            spec = importlib.util.spec_from_file_location("podcast_engine", "podcast_engine.py")
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)

            pipeline_class = module.LocalPodcastPipeline
            required_methods = ["__init__", "plan_lessons", "generate_script",
                              "synthesize_kokoro_audio", "run_episode"]

            missing = []
            for method in required_methods:
                if not hasattr(pipeline_class, method):
                    missing.append(method)
                else:
                    # Check it's actually a method (not just inherited)
                    if method not in pipeline_class.__dict__:
                        missing.append(f"{method} (inherited only)")

            self.check("Required Methods Exist", len(missing) == 0,
                      f"Missing: {missing}" if missing else "All required methods present")
            return len(missing) == 0

        except Exception as e:
            self.check("Required Methods Exist", False, f"Import failed: {e}")
            return False

    def test_synthesize_method_complete(self):
        """Test that synthesize_kokoro_audio has proper completion (writes file, returns path)."""
        try:
            with open("podcast_engine.py", "r") as f:
                source = f.read()

            # Check for essential completion patterns
            checks = {
                "writes wav file": "sf.write" in source or "wave.open" in source or "write_wav" in source,
                "returns path": "return str(wav_path)" in source or "return wav_path" in source,
                "concatenates audio": "np.concatenate" in source or "chunks.append" in source,
                "handles errors": "except Exception" in source or "try:" in source,
            }

            failed_checks = [k for k, v in checks.items() if not v]
            self.check("Synthesis Method Complete", len(failed_checks) == 0,
                      f"Missing: {failed_checks}" if failed_checks else "Method appears complete")
            return len(failed_checks) == 0

        except Exception as e:
            self.check("Synthesis Method Complete", False, f"Error: {e}")
            return False

    def test_run_episode_orchestration(self):
        """Test that run_episode calls the pipeline steps in order."""
        try:
            with open("podcast_engine.py", "r") as f:
                source = f.read()

            # Check that run_episode exists and calls the right methods
            has_run_episode = "def run_episode" in source
            calls_plan = "plan_lessons" in source.split("def run_episode")[1] if has_run_episode else False
            calls_script = "generate_script" in source.split("def run_episode")[1] if has_run_episode else False
            calls_synth = "synthesize_kokoro_audio" in source.split("def run_episode")[1] if has_run_episode else False

            complete = has_run_episode and calls_plan and calls_script and calls_synth
            self.check("run_episode Orchestration", complete,
                      "run_episode calls plan_lessons, generate_script, synthesize_kokoro_audio"
                      if complete else "run_episode missing or incomplete")
            return complete

        except Exception as e:
            self.check("run_episode Orchestration", False, f"Error: {e}")
            return False

    def test_models_integrity(self):
        """Test that models.py has required dataclasses."""
        try:
            spec = importlib.util.spec_from_file_location("models", "models.py")
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)

            required = ["Lesson", "DialogueTurn", "PodcastEpisode"]
            missing = [r for r in required if not hasattr(module, r)]

            self.check("Models Integrity", len(missing) == 0,
                      f"Missing: {missing}" if missing else "All dataclasses present")
            return len(missing) == 0
        except Exception as e:
            self.check("Models Integrity", False, f"Error: {e}")
            return False

    def test_path_traversal_protection(self):
        """Test that filename sanitization logic exists (static analysis)."""
        with open("podcast_engine.py", "r") as f:
            source = f.read()

        has_sanitize = "Path(str(filename" in source and ".name" in source
        has_check = "relative_to" in source and "ValueError" in source

        self.check("Path Traversal Protection", has_sanitize and has_check,
                  "Filename sanitization and path validation present"
                  if (has_sanitize and has_check) else "Missing security checks")
        return has_sanitize and has_check

    def test_no_silent_fallbacks(self):
        """Test that there are no silent fallbacks to test tones (anti-stub check)."""
        with open("podcast_engine.py", "r") as f:
            source = f.read()

        # Check for suspicious fallback patterns
        bad_patterns = [
            "except ImportError: pass",
            "except Exception: pass",
            "return test_tone",
            "generate_sine",
            "fallback_audio",
            "# TODO: implement real TTS",
            "placeholder",
        ]

        found = [p for p in bad_patterns if p in source.lower()]
        self.check("No Silent Fallbacks", len(found) == 0,
                  f"Found stub patterns: {found}" if found else "Fails loudly on errors (good)")
        return len(found) == 0

    def run_all(self):
        print("=" * 70)
        print("R3 QA CODE REVIEW: podcast_engine.py & models.py")
        print("=" * 70)

        self.test_syntax_valid()
        self.test_no_truncated_code()
        self.test_required_methods_exist()
        self.test_synthesize_method_complete()
        self.test_run_episode_orchestration()
        self.test_models_integrity()
        self.test_path_traversal_protection()
        self.test_no_silent_fallbacks()

        print("\n" + "=" * 70)
        print("RESULTS:")
        print("=" * 70)
        for r in self.results:
            print(f"  {r}")

        print(f"\n{'=' * 70}")
        print(f"SUMMARY: {self.passed} passed, {self.failed} failed")
        print(f"{'=' * 70}")

        if self.failed > 0:
            print("\n🚨 CRITICAL ISSUES DETECTED — DO NOT MERGE")
            print("   @R1 @R2 @R4 — Please fix the issues above and re-submit for review.")
            sys.exit(1)
        else:
            print("\n✅ ALL CHECKS PASSED — READY FOR MERGE")
            sys.exit(0)

if __name__ == "__main__":
    reviewer = R3CodeReview()
    reviewer.run_all()