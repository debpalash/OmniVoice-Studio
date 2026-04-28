"""Built-in voice personality presets.

Each personality is a named set of TTS parameters (instruct text, style
hints) that users can pick from a strip in Voice Design.  The instruct
string is treated as a starting point — users can edit it after applying.
"""

PERSONALITIES = [
    {
        "id": "narrator",
        "name": "Narrator",
        "instruct": "Speak as a calm, authoritative documentary narrator with measured pacing",
        "icon": "📖",
    },
    {
        "id": "casual",
        "name": "Casual",
        "instruct": "Speak in a relaxed, conversational tone like talking to a friend",
        "icon": "😊",
    },
    {
        "id": "news_anchor",
        "name": "News Anchor",
        "instruct": "Speak clearly and professionally like a television news presenter",
        "icon": "📺",
    },
    {
        "id": "storyteller",
        "name": "Storyteller",
        "instruct": "Speak with dramatic flair and engaging pacing like reading a bedtime story",
        "icon": "🧙",
    },
    {
        "id": "corporate",
        "name": "Corporate",
        "instruct": "Speak in a polished, professional tone suitable for business presentations",
        "icon": "💼",
    },
    {
        "id": "energetic",
        "name": "Energetic",
        "instruct": "Speak with high energy and enthusiasm like a podcast host",
        "icon": "⚡",
    },
]


def get_personalities():
    """Return the full list of built-in personality presets."""
    return PERSONALITIES


def get_personality(personality_id: str):
    """Look up a single personality by ID, or None."""
    for p in PERSONALITIES:
        if p["id"] == personality_id:
            return p
    return None
