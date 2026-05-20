"""Built-in voice personality presets.

Each personality is a named bundle of TTS-instruct taxonomy tokens (gender,
age, pitch, accent, dialect, style — see ``omnivoice.utils.voice_design``)
that users can pick from a strip in the Voice Design tab.

Why taxonomy tokens and not prose
=================================
OmniVoice's ``model.generate(instruct=...)`` runs every instruct string
through ``_resolve_instruct``, which splits on commas and validates each
item against a fixed vocabulary (e.g. ``male``, ``middle-aged``,
``moderate pitch``, ``british accent``). Anything outside that vocabulary
raises ``ValueError`` and surfaces to the user as a generation failure.

Earlier versions of this file shipped prose like
``"Speak clearly and professionally like a television news presenter"``
which always failed the validator — clicking *any* personality button in
the Design tab made the next Synthesize call crash (issue #89). Each
personality below maps to a comma-separated list of valid taxonomy
tokens so the picked instruct string is accepted by the model.

The ``description`` field is the human-readable explanation kept for
parity with the old field and for any future UI tooltips; the frontend
today only renders ``name`` and ``icon``. ``instruct`` is what flows into
``setInstruct`` on click.
"""

PERSONALITIES = [
    {
        "id": "narrator",
        "name": "Narrator",
        # Calm documentary-narrator vibe: settled adult, mid-low pitch.
        "instruct": "middle-aged, low pitch",
        "description": "Calm, authoritative documentary narrator with measured pacing",
        "icon": "📖",
    },
    {
        "id": "casual",
        "name": "Casual",
        # Relaxed, conversational — younger speaker, neutral pitch.
        "instruct": "young adult, moderate pitch",
        "description": "Relaxed, conversational tone like talking to a friend",
        "icon": "😊",
    },
    {
        "id": "news_anchor",
        "name": "News Anchor",
        # Clear, professional broadcaster — adult voice with US accent.
        "instruct": "middle-aged, moderate pitch, american accent",
        "description": "Clear, professional television news presenter",
        "icon": "📺",
    },
    {
        "id": "storyteller",
        "name": "Storyteller",
        # Dramatic bedtime-story flair — British accent reads well here.
        "instruct": "middle-aged, moderate pitch, british accent",
        "description": "Dramatic flair and engaging pacing like reading a bedtime story",
        "icon": "🧙",
    },
    {
        "id": "corporate",
        "name": "Corporate",
        # Polished business-presentation register.
        "instruct": "middle-aged, moderate pitch",
        "description": "Polished, professional tone suitable for business presentations",
        "icon": "💼",
    },
    {
        "id": "energetic",
        "name": "Energetic",
        # High-energy podcast host — younger speaker, higher pitch.
        "instruct": "young adult, high pitch",
        "description": "High energy and enthusiasm like a podcast host",
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
