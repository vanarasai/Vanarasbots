from dataclasses import dataclass, field
from typing import List, Optional

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

@dataclass
class PodcastEpisode:
    topic: str
    lessons: List[Lesson]
    script: List[DialogueTurn]
    audio_path: Optional[str] = None
