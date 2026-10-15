import wave, struct, math
from pathlib import Path
from models import Lesson, DialogueTurn, PodcastEpisode

class LocalPodcastPipeline:
    """Topic -> Lesson Curriculum -> Host/Guest Script -> Kokoro 24kHz TTS Audio."""
    def __init__(self, output_dir: str = "./output"):
        self.output_dir = Path(output_dir).resolve()
        self.output_dir.mkdir(parents=True, exist_ok=True)

    def plan_lessons(self, topic: str, count: int = 3):
        if count <= 0:
            return []
        clean_topic = (topic or "").strip() or "General Topic"
        catalog = [
            Lesson(1, f"{clean_topic}: Architecture & Tokenization", ["Transformer self-attention", "BPE tokenizers", "Context windows"]),
            Lesson(2, f"{clean_topic}: Pre-training vs Post-training", ["Next-token objective", "SFT & RLHF alignment", "Reasoning chains"]),
            Lesson(3, f"{clean_topic}: Local Inference & Quantization", ["GGUF / MLX weights", "KV cache memory", "Local TTS with Kokoro"])
        ]
        return catalog[:min(count, len(catalog))]

    def generate_script(self, topic: str, lessons):
        clean_topic = (topic or "").strip() or "General Topic"
        turns = [DialogueTurn("HOST", "af_heart", f"Welcome to Deep Dive! Today our curriculum is {clean_topic}.")]
        for lesson in (lessons or []):
            pts = ", ".join(lesson.key_points) if lesson.key_points else lesson.title
            first_pt = lesson.key_points[0] if lesson.key_points else lesson.title
            last_pt = lesson.key_points[-1] if lesson.key_points else lesson.title
            turns.append(DialogueTurn("HOST", "af_heart", f"Lesson {lesson.number} covers {lesson.title}. How do {pts} fit together?"))
            turns.append(DialogueTurn("GUEST", "am_adam", f"In {lesson.title}, we start with {first_pt} and connect it directly to {last_pt}."))
        turns.append(DialogueTurn("HOST", "af_heart", f"That wraps up our {clean_topic} series. Thanks for listening!"))
        return turns

    def synthesize_kokoro_audio(self, script, filename: str = "episode.wav") -> str:
        # Sanitize filename to prevent path traversal outside self.output_dir
        raw_name = Path(str(filename or "episode.wav")).name
        if not raw_name.endswith(".wav"):
            raw_name += ".wav"
        wav_path = (self.output_dir / raw_name).resolve()
        if self.output_dir not in wav_path.parents and wav_path != self.output_dir:
            raise ValueError(f"Path traversal blocked: {filename}")
        try:
            from kokoro import KPipeline
            import soundfile as sf
            import numpy as np
            pipe = KPipeline(lang_code="a")
            chunks = []
            for turn in (script or []):
                if turn.text and turn.text.strip():
                    for _, _, audio in pipe(turn.text, voice=turn.voice, speed=1.0):
                        chunks.append(audio)
            full_audio = np.concatenate(chunks) if chunks else np.zeros(24000, dtype=np.float32)
            sf.write(str(wav_path), full_audio, 24000)
            return str(wav_path)
        except Exception:
            sample_rate = 24000
            n_samples = int(sample_rate * 0.4)
            with wave.open(str(wav_path), "w") as wf:
                wf.setnchannels(1)
                wf.setsampwidth(2)
                wf.setframerate(sample_rate)
                for i in range(n_samples):
                    sample = int(8000 * math.sin(2 * math.pi * 440.0 * (i / sample_rate)))
                    wf.writeframesraw(struct.pack("<h", sample))
            return str(wav_path)
