from dataclasses import dataclass, field, asdict
from typing import List, Optional
from datetime import datetime, timezone
import json
import uuid

@dataclass
class Lesson:
    number: int
    title: str
    key_points: List[str] = field(default_factory=list)

@dataclass
class DialogueTurn:
    speaker: str  # "HOST" or "GUEST"
    voice: str    # "af_heart" or "am_adam"
    text: str
    start_ms: Optional[int] = None  # Filled during synthesis
    duration_ms: Optional[int] = None

@dataclass
class TranscriptSegment:
    """A timestamped segment of the transcript."""
    index: int
    speaker: str
    voice: str
    text: str
    start_ms: int
    end_ms: int
    duration_ms: int

@dataclass
class EpisodeMetadata:
    """Metadata sidecar for a podcast episode."""
    episode_id: str
    topic: str
    title: str
    lesson_count: int
    lessons: List[dict]
    turn_count: int
    duration_seconds: float
    sample_rate: int
    channels: int
    audio_filename: str
    transcript_filename: str
    voices: dict  # {"HOST": "af_heart", "GUEST": "am_adam"}
    created_at: str  # ISO 8601
    schema_version: int = 1

    def to_dict(self) -> dict:
        return asdict(self)

    def to_json(self) -> str:
        return json.dumps(self.to_dict(), indent=2)

@dataclass
class Transcript:
    """Full transcript with timestamped turns."""
    schema_version: int
    episode_id: str
    topic: str
    total_duration_ms: int
    turns: List[dict]  # List of TranscriptSegment dicts

    def to_dict(self) -> dict:
        return {
            "schemaVersion": self.schema_version,
            "episodeId": self.episode_id,
            "topic": self.topic,
            "totalDurationMs": self.total_duration_ms,
            "turns": self.turns
        }

    def to_json(self) -> str:
        return json.dumps(self.to_dict(), indent=2)

@dataclass
class PodcastEpisode:
    topic: str
    lessons: List[Lesson]
    script: List[DialogueTurn]
    audio_path: Optional[str] = None
    transcript_path: Optional[str] = None
    metadata_path: Optional[str] = None
    episode_id: str = field(default_factory=lambda: str(uuid.uuid4())[:8])
    created_at: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())
    duration_seconds: float = 0.0

def create_episode_metadata(
    episode: PodcastEpisode,
    audio_filename: str,
    transcript_filename: str,
    duration_seconds: float,
    sample_rate: int = 24000,
    channels: int = 1
) -> EpisodeMetadata:
    """Build metadata sidecar from a completed episode."""
    title = f"{episode.topic} — Deep Dive Podcast"
    return EpisodeMetadata(
        episode_id=episode.episode_id,
        topic=episode.topic,
        title=title,
        lesson_count=len(episode.lessons),
        lessons=[{"number": l.number, "title": l.title, "keyPoints": l.key_points} for l in episode.lessons],
        turn_count=len(episode.script),
        duration_seconds=round(duration_seconds, 2),
        sample_rate=sample_rate,
        channels=channels,
        audio_filename=audio_filename,
        transcript_filename=transcript_filename,
        voices={"HOST": "af_heart", "GUEST": "am_adam"},
        created_at=episode.created_at,
        schema_version=1
    )

def create_transcript(episode: PodcastEpisode, total_duration_ms: int) -> Transcript:
    """Build transcript with timestamped turns from episode script."""
    turns = []
    for i, turn in enumerate(episode.script):
        start_ms = turn.start_ms or 0
        duration_ms = turn.duration_ms or 0
        end_ms = start_ms + duration_ms
        turns.append({
            "index": i,
            "speaker": turn.speaker,
            "voice": turn.voice,
            "text": turn.text,
            "startMs": start_ms,
            "endMs": end_ms,
            "durationMs": duration_ms
        })
    return Transcript(
        schema_version=1,
        episode_id=episode.episode_id,
        topic=episode.topic,
        total_duration_ms=total_duration_ms,
        turns=turns
    )