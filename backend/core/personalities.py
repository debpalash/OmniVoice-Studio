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
        "attrs": {
            "Gender": "male",
            "Age": "middle-aged",
            "Pitch": "low pitch",
            "Style": "Auto",
            "EnglishAccent": "british accent",
            "ChineseDialect": "Auto",
        },
        "icon": "📖",
    },
    {
        "id": "casual",
        "name": "Casual",
        "instruct": "Speak in a relaxed, conversational tone like talking to a friend",
        "attrs": {
            "Gender": "female",
            "Age": "young adult",
            "Pitch": "moderate pitch",
            "Style": "Auto",
            "EnglishAccent": "Auto",
            "ChineseDialect": "Auto",
        },
        "icon": "😊",
    },
    {
        "id": "news_anchor",
        "name": "News Anchor",
        "instruct": "Speak clearly and professionally like a television news presenter",
        "attrs": {
            "Gender": "female",
            "Age": "middle-aged",
            "Pitch": "moderate pitch",
            "Style": "Auto",
            "EnglishAccent": "american accent",
            "ChineseDialect": "Auto",
        },
        "icon": "📺",
    },
    {
        "id": "storyteller",
        "name": "Storyteller",
        "instruct": "Speak with dramatic flair and engaging pacing like reading a bedtime story",
        "attrs": {
            "Gender": "male",
            "Age": "middle-aged",
            "Pitch": "moderate pitch",
            "Style": "Auto",
            "EnglishAccent": "british accent",
            "ChineseDialect": "Auto",
        },
        "icon": "🧙",
    },
    {
        "id": "corporate",
        "name": "Corporate",
        "instruct": "Speak in a polished, professional tone suitable for business presentations",
        "attrs": {
            "Gender": "male",
            "Age": "middle-aged",
            "Pitch": "moderate pitch",
            "Style": "Auto",
            "EnglishAccent": "american accent",
            "ChineseDialect": "Auto",
        },
        "icon": "💼",
    },
    {
        "id": "energetic",
        "name": "Energetic",
        "instruct": "Speak with high energy and enthusiasm like a podcast host",
        "attrs": {
            "Gender": "male",
            "Age": "young adult",
            "Pitch": "high pitch",
            "Style": "Auto",
            "EnglishAccent": "Auto",
            "ChineseDialect": "Auto",
        },
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
