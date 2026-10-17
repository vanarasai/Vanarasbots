import sys
import argparse
from pathlib import Path
from podcast_engine import LocalPodcastPipeline

def main():
    parser = argparse.ArgumentParser(description="Generate a Vanaras podcast episode")
    parser.add_argument("topic", nargs="?", default="LLM 101", help="Episode topic")
    parser.add_argument("--output-dir", "-o", default="./output", help="Output directory")
    parser.add_argument("--filename", "-f", default="episode.wav", help="Output WAV filename")
    parser.add_argument("--lessons", "-l", type=int, default=3, help="Number of lessons (1-10)")
    args = parser.parse_args()

    # Validate lesson count
    lesson_count = max(1, min(10, args.lessons))

    pipe = LocalPodcastPipeline(args.output_dir)

    # Full pipeline: plan → script → synthesize → transcript + metadata sidecars
    episode = pipe.generate_episode(
        topic=args.topic,
        lesson_count=lesson_count,
        filename=args.filename
    )

    print(f"TOPIC={episode.topic}")
    print(f"EPISODE_ID={episode.episode_id}")
    print(f"LESSONS={len(episode.lessons)}")
    print(f"TURNS={len(episode.script)}")
    print(f"AUDIO={episode.audio_path}")
    print(f"TRANSCRIPT={episode.transcript_path}")
    print(f"METADATA={episode.metadata_path}")
    print(f"DURATION={episode.duration_seconds:.1f}s")

if __name__ == "__main__":
    main()