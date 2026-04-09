# Voice Design

Voice Design mode lets you describe the desired speaker through speaker attributes (`instruct` parameter) — no reference audio needed. The model
generates a matching voice on the fly.

## Quick Example

```python
import torch
from omnivoice import OmniVoice

model = OmniVoice.from_pretrained(
    "k2-fsa/OmniVoice",
    device_map="cuda:0",
    dtype=torch.float16
)

audio = model.generate(
    text="This is a test for voice design.",
    instruct="female, young adult, high pitch, british accent",
)
```

## How It Works

The `instruct` parameter accepts a comma-separated string of speaker attributes.
Each attribute belongs to a **category** (gender, age, pitch, style, accent,
or dialect). Within a category, only one attribute may be selected at a time.
Attributes from different categories can be freely combined.

The model auto-detects the language of the instruct text and normalises it
internally — you can write in English, Chinese, or a mix of both.

## Supported Attributes

### Gender

| English | Chinese |
|---------|---------|
| male | 男 |
| female | 女 |

### Age

| English | Chinese |
|---------|---------|
| child | 儿童 |
| teenager | 少年 |
| young adult | 青年 |
| middle-aged | 中年 |
| elderly | 老年 |

### Pitch

| English | Chinese |
|---------|---------|
| very low pitch | 极低音调 |
| low pitch | 低音调 |
| moderate pitch | 中音调 |
| high pitch | 高音调 |
| very high pitch | 极高音调 |

### Style

| English | Chinese |
|---------|---------|
| whisper | 耳语 |

### English Accent

Only effective when the synthesis text is in English.

| Accent |
|--------|
| american accent |
| british accent |
| australian accent |
| canadian accent |
| indian accent |
| chinese accent |
| korean accent |
| japanese accent |
| portuguese accent |
| russian accent |

### Chinese Dialect

Only effective when the synthesis text is in Chinese.

| Dialect |
|---------|
| 河南话 |
| 陕西话 |
| 四川话 |
| 贵州话 |
| 云南话 |
| 桂林话 |
| 济南话 |
| 石家庄话 |
| 甘肃话 |
| 宁夏话 |
| 青岛话 |
| 东北话 |

## Writing Instruct Strings

Separate attributes with commas (half-width `,` for English, full-width `，`
for Chinese — the model auto-fixes mismatches).

```
# English
"female, young adult, high pitch, british accent"

# Chinese
"女，青年，高音调，四川话"

# Mixed (auto-normalised)
"female, young adult, 四川话"
```

### Tips

- **Combine freely** across categories: `"male, elderly, low pitch, whisper"`.
- **Leave it to the model**: omit attributes you don't care about — the model
  fills in the rest. For example `"female"` alone is valid.
- **Case-insensitive**: `"Male"`, `"MALE"`, and `"male"` are all accepted, the code will normalize them to lower case.

- **Accent vs Dialect**: English accents are only applied to English speech, Chinese dialects are only applied to Chinese speech.
