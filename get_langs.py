import json
from omnivoice.utils.lang_map import LANG_NAMES, lang_display_name
languages = ["Auto"] + sorted(lang_display_name(n) for n in LANG_NAMES)
with open("frontend/src/languages.json", "w") as f:
    json.dump(languages, f)
