import wave, struct, math, json
from pathlib import Path
from datetime import datetime, timezone
from models import (
    Lesson, DialogueTurn, PodcastEpisode,
    create_episode_metadata, create_transcript
)

# Average speaking rate for timestamp estimation (words per minute)
AVG_WPM = 150
MS_PER_WORD = 60000 / AVG_WPM  # ~400ms per word

class LocalPodcastPipeline:
    """Topic → Lesson Curriculum → Host/Guest Script → Kokoro 24kHz TTS Audio + Transcript + Metadata."""

    def __init__(self, output_dir: str = "./output"):
        self.output_dir = Path(output_dir).resolve()
        self.output_dir.mkdir(parents=True, exist_ok=True)

    def plan_lessons(self, topic: str, count: int = 3):
        if count <= 0:
            return []
        clean_topic = (topic or "").strip() or "General Topic"
        catalog = [
            Lesson(1, f"{clean_topic}: Architecture & Tokenization",
                   ["Transformer self-attention", "BPE tokenizers", "Context windows"]),
            Lesson(2, f"{clean_topic}: Pre-training vs Post-training",
                   ["Next-token objective", "SFT & RLHF alignment", "Reasoning chains"]),
            Lesson(3, f"{clean_topic}: Local Inference & Quantization",
                   ["GGUF / MLX weights", "KV cache memory", "Local TTS with Kokoro"]),
            Lesson(4, f"{clean_topic}: Attention Mechanisms Deep Dive",
                   ["Multi-head attention", "KV cache optimization", "Flash attention"]),
            Lesson(5, f"{clean_topic}: Training at Scale",
                   ["Data parallelism", "Pipeline parallelism", "Mixed precision training"]),
            Lesson(6, f"{clean_topic}: Alignment & Safety",
                   ["RLHF pipeline", "Constitutional AI", "Red-teaming"]),
            Lesson(7, f"{clean_topic}: Inference Optimization",
                   ["Speculative decoding", "Continuous batching", "PagedAttention"]),
            Lesson(8, f"{clean_topic}: Evaluation & Benchmarks",
                   ["Perplexity metrics", "Human eval", "MT-bench"]),
            Lesson(9, f"{clean_topic}: Deployment Patterns",
                   ["vLLM serving", "TensorRT-LLM", "Edge deployment"]),
            Lesson(10, f"{clean_topic}: Future Directions",
                   ["Mixture of experts", "Multimodal models", "Agentic systems"]),
        ]
        return catalog[:min(count, len(catalog))]

    def generate_script(self, topic: str, lessons):
        clean_topic = (topic or "").strip() or "General Topic"
        turns = [
            DialogueTurn("HOST", "af_heart",
                        f"Welcome to Deep Dive! Today we're exploring {clean_topic} across {len(lessons)} lessons.")
        ]
        for lesson in (lessons or []):
            pts = ", ".join(lesson.key_points) if lesson.key_points else lesson.title
            first_pt = lesson.key_points[0] if lesson.key_points else lesson.title
            last_pt = lesson.key_points[-1] if lesson.key_points else lesson.title
            turns.append(DialogueTurn("HOST", "af_heart",
                f"Lesson {lesson.number}: {lesson.title}. How do {pts} fit together?"))
            turns.append(DialogueTurn("GUEST", "am_adam",
                f"Great question. In {lesson.title}, we start with {first_pt}, build through the middle, and land on {last_pt}."))
        turns.append(DialogueTurn("HOST", "af_heart",
            f"That wraps up our deep dive into {clean_topic}. Thanks for listening!"))
        return turns

    def _estimate_turn_timings(self, script: list) -> tuple:
        """Estimate start_ms and duration_ms for each turn based on text length."""
        current_ms = 0
        for turn in script:
            word_count = len(turn.text.split())
            duration_ms = max(1000, int(word_count * MS_PER_WORD))  # Min 1 second
            turn.start_ms = current_ms
            turn.duration_ms = duration_ms
            current_ms += duration_ms
        return script, current_ms

    def synthesize_kokoro_audio(self, script, filename: str = "episode.wav") -> tuple:
        """
        Synthesize audio and return (wav_path, actual_duration_seconds, timed_script).
        Falls back to sine wave if Kokoro is unavailable.
        """
        raw_name = Path(str(filename or "episode.wav")).name
        if not raw_name.endswith(".wav"):
            raw_name += ".wav"
        wav_path = (self.output_dir / raw_name).resolve()

        # Path traversal protection
        if self.output_dir not in wav_path.parents and wav_path != self.output_dir:
            raise ValueError(f"Path traversal blocked: {filename}")

        sample_rate = 24000
        actual_duration = 0.0
        timed_script = list(script)

        try:
            from kokoro import KPipeline
            import soundfile as sf
            import numpy as np

            pipe = KPipeline(lang_code="a")
            chunks = []
            current_ms = 0

            for turn in script:
                if turn.text and turn.text.strip():
                    turn_chunks = []
                    for _, _, audio in pipe(turn.text, voice=turn.voice, speed=1.0):
                        turn_chunks.append(audio)
                        chunks.append(audio)

                    if turn_chunks:
                        turn_audio = np.concatenate(turn_chunks)
                        duration_sec = len(turn_audio) / sample_rate
                        turn.start_ms = current_ms
                        turn.duration_ms = int(duration_sec * 1000)
                        current_ms += turn.duration_ms

            full_audio = np.concatenate(chunks) if chunks else np.zeros(sample_rate, dtype=np.float32)
            sf.write(str(wav_path), full_audio, sample_rate)
            actual_duration = len(full_audio) / sample_rate
            timed_script = script

        except Exception as e:
            print(f"⚠️  Kokoro TTS unavailable ({e}), generating placeholder audio...")
            # Fallback: generate sine wave with estimated duration
            timed_script, estimated_total_ms = self._estimate_turn_timings(list(script))
            total_samples = int(sample_rate * (estimated_total_ms / 1000))
            n_samples = max(sample_rate, total_samples)  # At least 1 second

            with wave.open(str(wav_path), "w") as wf:
                wf.setnchannels(1)
                wf.setsampwidth(2)
                wf.setframerate(sample_rate)
                # Generate a pleasant chord progression as placeholder
                for i in range(n_samples):
                    t = i / sample_rate
                    sample = int(6000 * (
                        math.sin(2 * math.pi * 220.0 * t) * 0.3 +
                        math.sin(2 * math.pi * 330.0 * t) * 0.3 +
                        math.sin(2 * math.pi * 440.0 * t) * 0.4
                    ))
                    wf.writeframesraw(struct.pack("<h", sample))
            actual_duration = n_samples / sample_rate

        return str(wav_path), actual_duration, timed_script

    def generate_episode(
        self,
        topic: str,
        lesson_count: int = 3,
        filename: str = "episode.wav"
    ) -> PodcastEpisode:
        """
        Full pipeline: plan → script → synthesize → write sidecars.
        Returns a complete PodcastEpisode with all paths.
        """
        # Sanitize filename
        raw_name = Path(str(filename or "episode.wav")).name
        if not raw_name.endswith(".wav"):
            raw_name += ".wav"
        base_name = raw_name[:-4]  # Remove .wav

        # 1. Plan lessons
        lessons = self.plan_lessons(topic, count=lesson_count)

        # 2. Generate script
        script = self.generate_script(topic, lessons)

        # 3. Create episode object
        episode = PodcastEpisode(
            topic=topic.strip() or "General Topic",
            lessons=lessons,
            script=script
        )

        # 4. Synthesize audio
        wav_path, duration, timed_script = self.synthesize_kokoro_audio(script, raw_name)
        episode.audio_path = wav_path
        episode.script = timed_script
        episode.duration_seconds = duration

        # 5. Write transcript sidecar
        total_ms = int(duration * 1000)
        transcript = create_transcript(episode, total_ms)
        transcript_filename = f"{base_name}.transcript.json"
        transcript_path = self.output_dir / transcript_filename
        transcript_path.write_text(transcript.to_json(), encoding="utf-8")
        episode.transcript_path = str(transcript_path)

        # 6. Write metadata sidecar
        metadata = create_episode_metadata(
            episode=episode,
            audio_filename=raw_name,
            transcript_filename=transcript_filename,
            duration_seconds=duration
        )
        metadata_filename = f"{base_name}.metadata.json"
        metadata_path = self.output_dir / metadata_filename
        metadata_path.write_text(metadata.to_json(), encoding="utf-8")
        episode.metadata_path = str(metadata_path)

        print(f"✅ Episode generated: {raw_name}")
        print(f"   📄 Transcript: {transcript_filename}")
        print(f"   🏷️  Metadata: {metadata_filename}")
        print(f"   ⏱️  Duration: {duration:.1f}s | Lessons: {len(lessons)} | Turns: {len(script)}")

        return episode