#!/usr/bin/env python3
"""
R3 Final Verification Suite - Comprehensive audit of podcast_engine.py fixes.
Uses unittest (stdlib) - no pytest dependency required.

Checks:
- Syntax validity (no truncation)
- Method completeness (run_episode, synthesize_kokoro_audio)
- Security (path traversal protection)
- Input validation
- No silent fallbacks
- Orchestration correctness
"""

import ast
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).parent))

from podcast_engine import LocalPodcastPipeline
from models import Lesson, DialogueTurn, PodcastEpisode


class TestR3CodeIntegrity(unittest.TestCase):
    """Verify podcast_engine.py is complete and syntactically valid."""

    @classmethod
    def setUpClass(cls):
        cls.engine_path = Path(__file__).parent / "podcast_engine.py"
        cls.source = cls.engine_path.read_text()
        cls.tree = ast.parse(cls.source)

    def test_file_not_truncated(self):
        """podcast_engine.py should end with a complete statement."""
        lines = self.source.rstrip().split('\n')
        last_line = lines[-1].strip()
        # Should end with a return statement or method definition, not mid-expression
        self.assertFalse(
            last_line.endswith(('e', '(', ',', '.', '\\\\')),
            f"File appears truncated. Last line: {last_line!r}"
        )

    def test_no_incomplete_raise_statements(self):
        """All raise statements must have an exception."""
        for node in ast.walk(self.tree):
            if isinstance(node, ast.Raise):
                self.assertIsNotNone(
                    node.exc,
                    f"Incomplete raise at line {node.lineno}"
                )

    def test_required_class_structure(self):
        """LocalPodcastPipeline must have all required methods."""
        pipeline_class = None
        for node in ast.walk(self.tree):
            if isinstance(node, ast.ClassDef) and node.name == "LocalPodcastPipeline":
                pipeline_class = node
                break

        self.assertIsNotNone(pipeline_class, "LocalPodcastPipeline class must exist")

        method_names = {
            n.name for n in pipeline_class.body
            if isinstance(n, ast.FunctionDef)
        }
        required = {
            "__init__", "plan_lessons", "generate_script",
            "_ensure_kokoro_models", "_compute_sha256",
            "synthesize_kokoro_audio", "run_episode"
        }
        missing = required - method_names
        self.assertEqual(missing, set(), f"Missing methods: {missing}")

    def test_synthesize_method_complete(self):
        """synthesize_kokoro_audio must have return, WAV write, and validation."""
        for node in ast.walk(self.tree):
            if isinstance(node, ast.FunctionDef) and node.name == "synthesize_kokoro_audio":
                source_segment = ast.get_source_segment(self.source, node)
                self.assertIn("sf.write", source_segment, "Must write WAV file")
                self.assertIn("return str(wav_path)", source_segment, "Must return path")
                self.assertIn("relative_to", source_segment, "Must have path traversal check")
                return
        self.fail("synthesize_kokoro_audio not found")

    def test_run_episode_orchestration(self):
        """run_episode must call plan_lessons, generate_script, synthesize_kokoro_audio."""
        for node in ast.walk(self.tree):
            if isinstance(node, ast.FunctionDef) and node.name == "run_episode":
                called = set()
                for n in ast.walk(node):
                    if isinstance(n, ast.Attribute) and isinstance(n.value, ast.Name):
                        if n.value.id == "self":
                            called.add(n.attr)
                self.assertIn("plan_lessons", called)
                self.assertIn("generate_script", called)
                self.assertIn("synthesize_kokoro_audio", called)
                # Must return PodcastEpisode
                has_return = any(
                    isinstance(n, ast.Return) and n.value is not None
                    for n in ast.walk(node)
                )
                self.assertTrue(has_return, "run_episode must return a value")
                return
        self.fail("run_episode not found")


class TestR3SecurityAndValidation(unittest.TestCase):
    """Security and input validation tests."""

    def setUp(self):
        self.pipe = LocalPodcastPipeline("./output_test_r3")

    def test_path_traversal_protection(self):
        """Path traversal in filename must be blocked."""
        turns = [DialogueTurn("HOST", "af_heart", "Hello")]
        with self.assertRaises(ValueError):
            self.pipe.synthesize_kokoro_audio(turns, filename="../../../etc/evil.wav")

    def test_input_validation_empty_script(self):
        """Empty script must raise ValueError."""
        with self.assertRaises(ValueError):
            self.pipe.synthesize_kokoro_audio([])

    def test_input_validation_empty_turns(self):
        """All-empty turns must raise ValueError."""
        turns = [
            DialogueTurn("HOST", "af_heart", ""),
            DialogueTurn("GUEST", "am_adam", "   "),
        ]
        with self.assertRaises(ValueError):
            self.pipe.synthesize_kokoro_audio(turns)

    def test_no_silent_fallbacks(self):
        """Verify no fallback to test tones — check source code."""
        source = (Path(__file__).parent / "podcast_engine.py").read_text()
        # Should NOT contain silent fallback patterns
        forbidden_patterns = [
            "except.*:\\s*pass",
            "except.*:\\s*return None",
            "test_tone",
            "sine.*fallback",
            "440.*Hz",  # test tone frequency
        ]
        for pattern in forbidden_patterns:
            self.assertNotIn(
                pattern.lower(),
                source.lower().replace(" ", ""),
                f"Found forbidden pattern: {pattern}"
            )


class TestR3FunctionalLogic(unittest.TestCase):
    """Functional tests for non-TTS logic."""

    def setUp(self):
        self.pipe = LocalPodcastPipeline("./output_test_r3")

    def test_plan_lessons_edge_cases(self):
        """Test plan_lessons with various inputs."""
        # Normal
        lessons = self.pipe.plan_lessons("AI", count=2)
        self.assertEqual(len(lessons), 2)

        # Zero
        self.assertEqual(self.pipe.plan_lessons("AI", count=0), [])

        # Negative
        self.assertEqual(self.pipe.plan_lessons("AI", count=-5), [])

        # Empty topic
        lessons = self.pipe.plan_lessons("", count=1)
        self.assertEqual(len(lessons), 1)
        self.assertIn("General Topic", lessons[0].title)

        # Over max
        lessons = self.pipe.plan_lessons("AI", count=100)
        self.assertEqual(len(lessons), 3)

    def test_generate_script_structure(self):
        """Test generate_script produces valid dialogue."""
        lessons = self.pipe.plan_lessons("Test", count=2)
        script = self.pipe.generate_script("Test", lessons)

        self.assertIsInstance(script, list)
        self.assertTrue(all(isinstance(t, DialogueTurn) for t in script))

        # Check speakers alternate properly
        speakers = [t.speaker for t in script]
        self.assertEqual(speakers[0], "HOST")  # Intro
        self.assertEqual(speakers[-1], "HOST")  # Outro

        # Check voices are valid
        valid_voices = {"af_heart", "am_adam"}
        for turn in script:
            self.assertIn(turn.voice, valid_voices)

        # Check no empty text
        for turn in script:
            self.assertTrue(turn.text.strip(), "Dialogue turn has empty text")


class TestR3FileIntegrity(unittest.TestCase):
    """Verify all project files are complete."""

    def test_app_py_complete(self):
        """app.py should be syntactically valid and complete."""
        app_path = Path(__file__).parent / "app.py"
        source = app_path.read_text()
        tree = ast.parse(source)  # Will raise if truncated
        self.assertIn("run_episode", source)

    def test_models_py_complete(self):
        """models.py should define all dataclasses."""
        models_path = Path(__file__).parent / "models.py"
        source = models_path.read_text()
        tree = ast.parse(source)

        class_names = {
            n.name for n in ast.walk(tree)
            if isinstance(n, ast.ClassDef)
        }
        self.assertIn("Lesson", class_names)
        self.assertIn("DialogueTurn", class_names)
        self.assertIn("PodcastEpisode", class_names)

    def test_test_podcast_py_complete(self):
        """test_podcast.py should be syntactically valid."""
        test_path = Path(__file__).parent / "test_podcast.py"
        source = test_path.read_text()
        ast.parse(source)  # Will raise SyntaxError if truncated
        self.assertIn("unittest.main()", source)


if __name__ == "__main__":
    unittest.main(verbosity=2)