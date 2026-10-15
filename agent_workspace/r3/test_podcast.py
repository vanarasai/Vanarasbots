import os, wave
from podcast_engine import LocalPodcastPipeline

def test_end_to_end():
    pipe = LocalPodcastPipeline("./output_test")
    lessons = pipe.plan_lessons("LLM 101", count=3)
    assert len(lessons) == 3, "Expected 3 structured lessons"
    assert pipe.plan_lessons("LLM 101", count=0) == [], "Expected empty list for count=0"
    assert pipe.plan_lessons("LLM 101", count=-1) == [], "Expected empty list for negative count"
    script = pipe.generate_script("LLM 101", lessons)
    assert any(t.speaker == "HOST" and t.voice == "af_heart" for t in script)
    assert any(t.speaker == "GUEST" and t.voice == "am_adam" for t in script)
    wav_path = pipe.synthesize_kokoro_audio(script, "../../../tmp/evil.wav")
    assert not os.path.exists("/tmp/evil.wav"), "Path traversal must be blocked"
    assert os.path.exists(wav_path) and os.path.getsize(wav_path) > 100
    with wave.open(wav_path, "rb") as wf:
        sr = wf.getframerate()
        frames = wf.getnframes()
        dur = frames / float(sr)
    print(f"PODCAST_PIPELINE_VERIFIED_OK: path={wav_path} bytes={os.path.getsize(wav_path)} sample_rate={sr}Hz duration={dur:.2f}s")

if __name__ == "__main__":
    test_end_to_end()
