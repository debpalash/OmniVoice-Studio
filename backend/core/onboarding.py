"""First-run onboarding — seeds a demo voice profile so the Launchpad
isn't empty on initial launch.  Runs once; skips silently if any
profiles already exist.
"""

import os
import shutil
import time
import logging

from core.db import get_db
from core.config import VOICES_DIR

logger = logging.getLogger(__name__)

# Bundled demo clip — a short reference audio for the sample profile.
_DEMO_AUDIO = os.path.join(
    os.path.dirname(__file__), os.pardir, "assets", "samples", "demo_voice.wav"
)

DEMO_PROFILE_ID = "demo0001"
DEMO_PROFILE_NAME = "OmniVoice Demo"
DEMO_REF_TEXT = "Welcome to OmniVoice Studio. Clone any voice, design new ones, or dub videos into hundreds of languages."


def seed_sample_project():
    """Create the demo voice profile if no profiles exist yet."""
    conn = get_db()
    try:
        count = conn.execute("SELECT COUNT(*) FROM voice_profiles").fetchone()[0]
        if count > 0:
            return  # Not first run — skip

        # Check if demo audio exists
        if not os.path.isfile(_DEMO_AUDIO):
            logger.warning("Demo audio not found at %s — skipping onboarding seed", _DEMO_AUDIO)
            return

        # Copy demo audio to voices directory
        os.makedirs(VOICES_DIR, exist_ok=True)
        dest = os.path.join(VOICES_DIR, f"{DEMO_PROFILE_ID}.wav")
        shutil.copy2(_DEMO_AUDIO, dest)

        conn.execute(
            "INSERT OR IGNORE INTO voice_profiles "
            "(id, name, ref_audio_path, ref_text, instruct, language, personality, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (
                DEMO_PROFILE_ID,
                DEMO_PROFILE_NAME,
                f"{DEMO_PROFILE_ID}.wav",
                DEMO_REF_TEXT,
                "",
                "English",
                "",
                time.time(),
            ),
        )
        conn.commit()
        logger.info("🎉 Seeded demo voice profile '%s'", DEMO_PROFILE_NAME)
    finally:
        conn.close()
