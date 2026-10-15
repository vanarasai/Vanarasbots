import sys
from podcast_engine import LocalPodcastPipeline

def main():
    topic = sys.argv[1] if len(sys.argv) > 1 else "LLM 101"
    pipe = LocalPodcastPipeline("./output")
    lessons = pipe.plan_lessons(topic, count=3)
    script = pipe.generate_script(topic, lessons)
    wav_file = pipe.synthesize_kokoro_audio(script)
    print(f"TOPIC={topic} LESSONS={len(lessons)} TURNS={len(script)} AUDIO={wav_file}")

if __name__ == "__main__":
    main()
