# Translation engines (Dub tab)

OmniVoice dubs in two steps: **transcribe → translate → speak**. The *translate*
step is pluggable — pick the engine in the Dub tab's **Engine** dropdown. Two
engines are **built in** and always available offline; the rest need a small
optional Python package.

| Engine | Category | Needs a package? | Key needed? |
|--------|----------|------------------|-------------|
| **Argos** (Local, Fast) | offline | `argostranslate` (bundled) | no |
| **NLLB-200** (Local, Heavy) | offline | none (uses core `transformers`) | no |
| Google Translate (Free) | online | `deep_translator` | no |
| DeepL | online | `deep_translator` | yes (`DEEPL_API_KEY`) |
| Microsoft Translator | online | `deep_translator` | yes (`MICROSOFT_API_KEY`) |
| MyMemory | online | `deep_translator` | no |
| LLM (OpenAI-compatible) | llm | `openai` | usually yes |

If you pick an engine whose package isn't importable yet, the Engine label shows
a **highlighted Install affordance**, and — if you try to translate anyway — the
backend returns a single, actionable error telling you exactly what to install
(the install command is single-sourced, so the button and the error never
disagree).

## Installing optional translation engines (from-source vs packaged build)

How you add an engine depends on **how you installed OmniVoice**.

### From-source / dev install (one-click)

If you cloned the repo and run OmniVoice from source (`uv sync` + the dev
launcher) or via Docker, the app can install engines for you:

1. In the Dub tab, open the translation settings and pick the engine you want
   (e.g. **Google Translate**) from the **Engine** dropdown.
2. A highlighted **Install** button appears next to the *Engine* label. Click it.
3. OmniVoice runs the install into the **same** Python environment the backend
   is using (`uv pip install <package> --python <backend-interpreter>`), then
   re-probes. When it reports *"restart the backend to load it"*, restart so the
   freshly-installed module is importable.

You can also install by hand into the backend venv:

```
uv pip install deep_translator   # Google / DeepL / Microsoft / MyMemory
uv pip install argostranslate    # Argos (already bundled; rarely needed)
uv pip install openai            # LLM (OpenAI-compatible) provider
```

Then restart the backend.

### Packaged / installer build (read-only — use the popover)

The signed desktop installers (`.dmg`, `.msi`, AppImage, `.deb`) ship a
**read-only, code-signed Python environment**. Installing extra packages into it
would break the signature, so **in-app install is intentionally disabled** on
these builds. Selecting an uninstalled engine there shows a highlighted button
that opens a small popover with everything you need:

- **The exact command** to run (with a copy-to-clipboard button) if you *do*
  have a from-source checkout somewhere and want the online engines there.
- **Switch to Argos (bundled, offline)** — one click. Argos and NLLB are always
  importable in every build, so this is the guaranteed escape hatch: you can
  keep dubbing immediately, fully offline, no install required.
- A link back to this page.

**Recommendation for packaged builds:** just use **Argos** (fast, offline) or
**NLLB-200** (heavier, higher quality, offline). They need nothing installed and
never leave your machine. Reach for the online engines only from a from-source
install where you can add their package.

## Translation quality: Fast, Autofit, Cinematic

The **Quality** control in the Dub tab (and Settings → Translation) picks how the
translation is produced:

- **Fast** — a direct one-shot translation from the selected engine (Argos, NLLB,
  Google, …). No LLM, no timing awareness.
- **Cinematic** — an LLM refines the literal translation (reflect → adapt) for
  natural, in-context phrasing.
- **Autofit** — Cinematic **plus** a strict fit-to-time pass: the LLM rewrites
  each line so its target-language reading time fits **within** the segment's
  slot (never overruns it). This keeps the video timing intact and avoids the
  stressed audio time-stretch you get when a translation is too long for its
  slot. Fit is per-language pronunciation-speed aware.

Cinematic and Autofit **require an LLM** (below). If none is configured, they
fall back to Fast with a notice.

## Two-stage quality on the LLM engine (auto-glossary + reflect pass)

When the **LLM (OpenAI-compatible)** engine is the active translator, two extra
quality stages run by default. Both have checkboxes next to the Quality control
in the Dub tab's translation settings (they only appear for the LLM engine —
MT engines can't run either stage):

- **Auto glossary** — before the per-segment translation, ONE extra LLM pass
  reads the whole transcript and extracts a short theme summary plus a
  source → target terminology map. That brief rides every segment's translation
  prompt, so character names, places, and recurring domain terms come out the
  same in segment 3 and segment 300. It's merged with your manual glossary —
  **your entries always win** on a clashing term. The result is cached with the
  dub project per target language, so re-translating an unchanged transcript
  costs zero extra calls; editing segments re-extracts.
- **Reflect pass** — after each segment's direct translation, the LLM critiques
  the draft for wordiness and stiff/unnatural register, then rewrites it as
  natural spoken dialogue. **This uses 3 LLM calls per segment instead of 1** —
  turn it off for long videos on slow or metered providers. If any refinement
  step fails or times out, the direct translation is kept silently; refinement
  can never fail a segment.
### Fit prediction (all quality levels)

Every translation additionally gets a **pre-synthesis fit check** — no LLM
needed. For each segment, OmniVoice predicts how long the translated line will
take to speak (self-calibrating to your voice/engine from segments already
generated in the job, with a per-language rate table as the cold-start
fallback) and compares it against the slot plus the silence it can borrow
before the next line. Segments the Smart Fit caps can only absorb with an
audible speed-up get a **Tight fit** badge; segments no fitting can save get a
**Won't fit +Ns** badge — so you can shorten the text *before* burning GPU
time on a line that would end up trimmed. Badges are informational only:
generation is never blocked.

**Suggest shorter lines** (checkbox under Quality, off by default) goes one
step further: for every "Won't fit" segment it asks the configured LLM for a
meaning-preserving shorter rewrite and offers it on the row as a one-click
**Use shorter rewrite** suggestion. It never rewrites anything automatically,
and with no LLM configured (or on any LLM error) it simply does nothing.

## LLM Providers (for Cinematic / Autofit)

**Settings → System → LLM Providers** is the one place to set up the LLM. Pick a
provider, paste its API key, choose a model, **Test** it, and "use for
translation." Supported: OpenAI, OpenRouter, Groq, Cerebras, Google AI (Gemini),
Mistral, Cohere, NVIDIA, GitHub Models, Cloudflare, Hugging Face, SambaNova,
SiliconFlow, **local Ollama / LM Studio** (offline, no key), and a **Custom**
OpenAI-compatible endpoint.

Keys entered here are stored **encrypted** on your machine and never returned to
the UI. For a fully offline setup, pick **Ollama** (`ollama pull llama3.1`) or
**LM Studio** — nothing leaves the machine. Power users can still override any
provider via environment variables (e.g. `GROQ_API_KEY`, or the legacy
`TRANSLATE_BASE_URL` / `TRANSLATE_API_KEY` / `TRANSLATE_MODEL`, which map to the
**Custom** provider).

### Pinning the active provider with `LLM_DEFAULT_PROVIDER`

By default the LLM used for Cinematic/Autofit is the one you mark "use for
translation" in **Settings → LLM Providers**. To force a specific provider
regardless of that stored selection — handy for headless/CI/Docker runs or a
shared machine — set the `LLM_DEFAULT_PROVIDER` environment variable to a
provider id before launching the backend:

```
LLM_DEFAULT_PROVIDER=groq        # or openai, openrouter, cerebras, ollama, custom, …
```

Resolution order for the active provider is: `LLM_DEFAULT_PROVIDER` (env) →
your saved selection → the first provider that has a key → none. The id must be
one OmniVoice knows (the ids shown in **Settings → LLM Providers**); an unknown
value is ignored and resolution falls through to your saved selection. While
this env var is set it wins over the in-app picker, so if the UI selection
appears to have "no effect," check whether `LLM_DEFAULT_PROVIDER` is exported.

## LLM Skills (per-feature routing)

**Settings → System → LLM Skills** lists every LLM-powered feature — Cinematic &
Autofit translation, speech-rate slot fitting, glossary auto-extract, direction
parsing, and dictation cleanup — and lets you toggle each one or route it to a
specific provider instead of the global active one. That way sensitive work
(e.g. dictation cleanup) can stay on a local Ollama/LM Studio model while
heavier jobs use a remote provider. A disabled skill degrades exactly like
having no LLM configured: Cinematic/Autofit falls back to Fast, dictation
cleanup passes the raw transcript through, direction parsing uses the keyword
heuristic. Everything defaults to enabled + "use active provider", so existing
setups behave unchanged.

## API keys (online MT engines)

The non-LLM online engines need a key, set as an environment variable before
launching the backend (or in **Settings → Credentials**):

- **DeepL:** `DEEPL_API_KEY` (optionally `DEEPL_BASE_URL` for a self-hosted /
  pro endpoint).
- **Microsoft Translator:** `MICROSOFT_API_KEY` (optionally `MICROSOFT_BASE_URL`).

## Troubleshooting

- **"The 'google' translation engine needs the optional deep_translator Python
  package…"** — the package isn't installed. On a from-source install, click the
  Install button (or run the command above) and restart. On a packaged build,
  switch to Argos/NLLB via the popover.
- **Install button does nothing / says "disabled in packaged builds"** — you're
  on a signed installer build (expected). Use Argos/NLLB, or add the package in a
  from-source checkout.
- **Installed it but still "needs install"** — restart the backend so Python
  picks up the newly-installed module.
