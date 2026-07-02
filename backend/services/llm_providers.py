"""LLM provider registry — the OpenAI-compatible providers OmniVoice can use
for Cinematic / Autofit translation (and any future LLM feature).

Every provider here speaks the OpenAI chat-completions shape, so a single
client (`llm_backend.OpenAICompatBackend`) drives all of them — the only
per-provider differences are ``base_url``, ``model``, and the API key. This
module is the one place that knows those defaults and resolves the live value
for the *active* provider.

Resolution precedence for every field (key / base_url / model), highest first:
    1. Environment variable  — power-user / `.env` override, wins always.
    2. Encrypted settings store (UI-entered) — `settings_store.get_secret` for
       keys, `get_text` for base_url/model overrides.
    3. Built-in default from the table below.

Local providers (Ollama, LM Studio) need no key — a "local" sentinel is used
so the OpenAI client is happy. This keeps the local-first path fully offline:
nothing is sent anywhere unless the user picks a remote provider *and* a
feature gate (quality="cinematic"/"autofit") fires.

Keys entered in the UI are stored **encrypted** (never in `.env`, never
returned to the client). `.env` keys remain a valid override for CI / power
users.
"""
from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Optional

# Settings-store row names (non-secret overrides live in the plaintext table;
# keys live in the encrypted secret table under ``llm_key.<id>``).
_ACTIVE_PROVIDER_KEY = "llm.active_provider"
_BASE_URL_KEY = "llm.base_url."   # + provider id
_MODEL_KEY = "llm.model."         # + provider id
SECRET_PREFIX = "llm_key."        # + provider id  → settings_store secret name


@dataclass(frozen=True)
class Provider:
    id: str
    display_name: str
    default_base_url: str
    default_model: str
    # Env var names checked (in order) for the API key. First one set wins.
    key_envs: tuple[str, ...] = ()
    base_url_env: Optional[str] = None
    model_env: Optional[str] = None
    local: bool = False           # runs on the user's machine → no key, offline
    # Key optional when a base_url is set (self-hosted OpenAI-compatible servers
    # — vLLM, LM Studio behind a custom URL — often ignore the key). Preserves
    # the pre-registry behaviour where a lone TRANSLATE_BASE_URL was usable
    # keyless.
    key_optional: bool = False
    needs_account: bool = False   # Cloudflare: base_url needs an account id
    account_env: Optional[str] = None
    signup_url: str = ""
    notes: str = ""


# Order here is the display order in the settings page. OpenAI first (the
# canonical), then the free/fast cloud providers from the shipped .env, then
# the local engines, then Custom.
_PROVIDERS: tuple[Provider, ...] = (
    Provider("openai", "OpenAI", "https://api.openai.com/v1", "gpt-4o-mini",
             key_envs=("OPENAI_API_KEY", "TRANSLATE_API_KEY"),
             base_url_env="OPENAI_BASE_URL", model_env="OPENAI_MODEL",
             signup_url="https://platform.openai.com/api-keys",
             notes="GPT-4o / o-series. Highest quality; paid."),
    Provider("openrouter", "OpenRouter", "https://openrouter.ai/api/v1",
             "openai/gpt-4o-mini",
             key_envs=("OPENROUTER_API_KEY",), base_url_env="OPENROUTER_BASE_URL",
             model_env="OPENROUTER_MODEL",
             signup_url="https://openrouter.ai/keys",
             notes="One key, hundreds of models incl. free tiers."),
    Provider("groq", "Groq", "https://api.groq.com/openai/v1",
             "llama-3.3-70b-versatile",
             key_envs=("GROQ_API_KEY",), base_url_env="GROQ_BASE_URL",
             model_env="GROQ_MODEL", signup_url="https://console.groq.com/keys",
             notes="Very fast Llama/Mixtral inference. Generous free tier."),
    Provider("cerebras", "Cerebras", "https://api.cerebras.ai/v1",
             "llama-3.3-70b",
             key_envs=("CEREBRAS_API_KEY",), base_url_env="CEREBRAS_BASE_URL",
             model_env="CEREBRAS_MODEL", signup_url="https://cloud.cerebras.ai",
             notes="Fastest Llama inference. Free tier."),
    Provider("google-ai", "Google AI (Gemini)",
             "https://generativelanguage.googleapis.com/v1beta/openai",
             "gemini-2.0-flash",
             key_envs=("GOOGLE_AI_API_KEY",), base_url_env="GOOGLE_AI_BASE_URL",
             model_env="GOOGLE_AI_MODEL",
             signup_url="https://aistudio.google.com/app/apikey",
             notes="Gemini via OpenAI-compatible endpoint. Free tier."),
    Provider("mistral", "Mistral", "https://api.mistral.ai/v1",
             "mistral-small-latest",
             key_envs=("MISTRAL_API_KEY",), base_url_env="MISTRAL_BASE_URL",
             model_env="MISTRAL_MODEL", signup_url="https://console.mistral.ai/api-keys",
             notes="Strong multilingual models. Free tier."),
    Provider("cohere", "Cohere", "https://api.cohere.ai/compatibility/v1",
             "command-r-08-2024",
             key_envs=("COHERE_API_KEY",), base_url_env="COHERE_BASE_URL",
             model_env="COHERE_MODEL", signup_url="https://dashboard.cohere.com/api-keys",
             notes="Command models; good for RAG/translation. Free trial keys."),
    Provider("nvidia", "NVIDIA NIM", "https://integrate.api.nvidia.com/v1",
             "meta/llama-3.3-70b-instruct",
             key_envs=("NVIDIA_API_KEY",), base_url_env="NVIDIA_BASE_URL",
             model_env="NVIDIA_MODEL", signup_url="https://build.nvidia.com",
             notes="NIM-hosted open models. Free credits."),
    Provider("github-models", "GitHub Models",
             "https://models.github.ai/inference", "openai/gpt-4o-mini",
             key_envs=("GITHUB_MODELS_API_KEY",), base_url_env="GITHUB_MODELS_BASE_URL",
             model_env="GITHUB_MODELS_MODEL",
             signup_url="https://github.com/settings/tokens",
             notes="Uses a GitHub PAT. Free for dev, rate-limited."),
    Provider("cloudflare", "Cloudflare Workers AI",
             "https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/v1",
             "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
             key_envs=("CLOUDFLARE_API_KEY",), base_url_env="CLOUDFLARE_BASE_URL",
             model_env="CLOUDFLARE_MODEL", needs_account=True,
             account_env="CLOUDFLARE_ACCOUNT_ID",
             signup_url="https://dash.cloudflare.com/profile/api-tokens",
             notes="Needs an Account ID. Free tier."),
    Provider("huggingface", "Hugging Face", "https://router.huggingface.co/v1",
             "meta-llama/Llama-3.3-70B-Instruct",
             key_envs=("HUGGINGFACE_API_KEY", "HF_TOKEN"),
             base_url_env="HUGGINGFACE_BASE_URL", model_env="HUGGINGFACE_MODEL",
             signup_url="https://huggingface.co/settings/tokens",
             notes="HF Inference router. Reuses your HF token."),
    Provider("sambanova", "SambaNova", "https://api.sambanova.ai/v1",
             "Meta-Llama-3.3-70B-Instruct",
             key_envs=("SAMBANOVA_API_KEY",), base_url_env="SAMBANOVA_BASE_URL",
             model_env="SAMBANOVA_MODEL", signup_url="https://cloud.sambanova.ai",
             notes="Fast open models. Free tier."),
    Provider("siliconflow", "SiliconFlow", "https://api.siliconflow.com/v1",
             "Qwen/Qwen2.5-7B-Instruct",
             key_envs=("SILICONFLOW_API_KEY",), base_url_env="SILICONFLOW_BASE_URL",
             model_env="SILICONFLOW_MODEL", signup_url="https://siliconflow.com",
             notes="Qwen/DeepSeek and more. Strong for CJK."),
    Provider("ollama", "Ollama (local)", "http://localhost:11434/v1",
             "llama3.1", local=True,
             base_url_env="OLLAMA_BASE_URL", model_env="OLLAMA_MODEL",
             signup_url="https://ollama.com",
             notes="Fully offline. Run `ollama pull llama3.1` first."),
    Provider("lmstudio", "LM Studio (local)", "http://localhost:1234/v1",
             "local-model", local=True,
             base_url_env="LMSTUDIO_BASE_URL", model_env="LMSTUDIO_MODEL",
             signup_url="https://lmstudio.ai",
             notes="Fully offline. Start the LM Studio local server."),
    Provider("custom", "Custom (OpenAI-compatible)", "", "",
             key_envs=("TRANSLATE_API_KEY",), base_url_env="TRANSLATE_BASE_URL",
             model_env="TRANSLATE_MODEL", key_optional=True,
             notes="Any OpenAI-compatible host. Set Base URL + Model (+ key)."),
)

_BY_ID: dict[str, Provider] = {p.id: p for p in _PROVIDERS}


def all_providers() -> tuple[Provider, ...]:
    return _PROVIDERS


def get_provider(pid: str) -> Optional[Provider]:
    return _BY_ID.get(pid)


# ── Field resolution (env → store → default) ──────────────────────────────

def _env_first(names: tuple[str, ...]) -> Optional[str]:
    for n in names:
        v = os.environ.get(n)
        if v:
            return v
    return None


def resolve_account_id(p: Provider) -> str:
    """The Cloudflare-style account id: env override → stored → empty."""
    from services import settings_store
    return (
        (p.account_env and os.environ.get(p.account_env))
        or settings_store.get_text(f"llm.account.{p.id}")
        or ""
    )


def resolve_base_url(p: Provider, *, substitute: bool = True) -> str:
    """Resolve a provider's base URL (env → stored override → default).

    ``substitute`` interpolates ``{account_id}`` for account-scoped providers
    (Cloudflare) so the *client* gets a working URL. The UI passes
    ``substitute=False`` so the field shows/saves the raw template — baking the
    substituted value back into a stored override would freeze the URL and make
    later account-id changes silently no-op (the bug this guards against).
    """
    from services import settings_store
    val = (
        (p.base_url_env and os.environ.get(p.base_url_env))
        or settings_store.get_text(_BASE_URL_KEY + p.id)
        or p.default_base_url
    )
    if substitute and p.needs_account and val and "{account_id}" in val:
        val = val.replace("{account_id}", resolve_account_id(p))
    return val or ""


def resolve_model(p: Provider) -> str:
    from services import settings_store
    return (
        (p.model_env and os.environ.get(p.model_env))
        or settings_store.get_text(_MODEL_KEY + p.id)
        or p.default_model
    )


def resolve_api_key(p: Provider) -> Optional[str]:
    """Env key → encrypted stored key → 'local' sentinel for local/keyless."""
    from services import settings_store
    env_key = _env_first(p.key_envs)
    if env_key:
        return env_key
    stored = settings_store.get_secret(SECRET_PREFIX + p.id)
    if stored:
        return stored
    if p.local or (p.key_optional and resolve_base_url(p)):
        return "local"  # self-hosted OpenAI-compatible servers ignore the key
    return None


def has_key(p: Provider) -> bool:
    """True if a usable key is resolvable (local, or keyless-with-base_url)."""
    if p.local:
        return True
    if _env_first(p.key_envs) or _key_in_store(p.id):
        return True
    return bool(p.key_optional and resolve_base_url(p))


def _key_in_store(pid: str) -> bool:
    from services import settings_store
    return (SECRET_PREFIX + pid) in settings_store.list_secret_names()


def is_configured(p: Provider) -> bool:
    """Usable end-to-end: has a base_url (custom needs one set) and a key."""
    if not resolve_base_url(p):
        return False
    return has_key(p)


# ── Active provider selection ─────────────────────────────────────────────

def active_provider_id() -> Optional[str]:
    """The provider Cinematic/Autofit should use.

    Precedence: env ``LLM_DEFAULT_PROVIDER`` → stored selection → first
    configured provider → None. Legacy ``TRANSLATE_BASE_URL`` users with no
    explicit selection resolve to ``custom`` (its envs are TRANSLATE_*).
    """
    from services import settings_store
    env_pick = os.environ.get("LLM_DEFAULT_PROVIDER")
    if env_pick and env_pick in _BY_ID:
        return env_pick
    stored = settings_store.get_text(_ACTIVE_PROVIDER_KEY)
    if stored and stored in _BY_ID:
        return stored
    # Legacy: a lone TRANSLATE_BASE_URL means the old single-endpoint setup.
    if os.environ.get("TRANSLATE_BASE_URL"):
        return "custom"
    # Auto-select only a provider with a real key. Local providers (Ollama/
    # LM Studio) are *always* "configured" (no key needed) but we must NOT
    # assume their server is running — they require an explicit selection.
    for p in _PROVIDERS:
        if not p.local and is_configured(p):
            return p.id
    return None


def set_active_provider(pid: str) -> None:
    from services import settings_store
    if pid not in _BY_ID:
        raise ValueError(f"unknown provider {pid!r}")
    settings_store.set_text(_ACTIVE_PROVIDER_KEY, pid)


def active_provider() -> Optional[Provider]:
    pid = active_provider_id()
    return _BY_ID.get(pid) if pid else None


# ── UI + persistence helpers ──────────────────────────────────────────────

def save_key(pid: str, api_key: str) -> None:
    """Persist (encrypted) or clear an API key for a provider."""
    from services import settings_store
    if pid not in _BY_ID:
        raise ValueError(f"unknown provider {pid!r}")
    settings_store.set_secret(SECRET_PREFIX + pid, api_key or "")


def save_overrides(pid: str, *, base_url: Optional[str] = None,
                   model: Optional[str] = None,
                   account_id: Optional[str] = None) -> None:
    from services import settings_store
    if pid not in _BY_ID:
        raise ValueError(f"unknown provider {pid!r}")
    p = _BY_ID[pid]
    if base_url is not None:
        bu = base_url.strip()
        # Never freeze an override that equals the built-in default. Critical
        # for account-templated URLs (Cloudflare): persisting the shown value
        # would pin the base_url and stop later account-id edits from taking
        # effect. Clearing (→ empty) falls the resolver back to the default
        # template so substitution stays live. Also self-heals a stale override
        # if a provider's default URL changes in a future release.
        settings_store.set_text(_BASE_URL_KEY + pid, "" if bu == p.default_base_url else bu)
    if model is not None:
        settings_store.set_text(_MODEL_KEY + pid, model.strip())
    if account_id is not None:
        settings_store.set_text(f"llm.account.{pid}", account_id.strip())


def _active_env_pin() -> Optional[str]:
    """The provider id pinned by ``LLM_DEFAULT_PROVIDER`` (if set + valid)."""
    pick = os.environ.get("LLM_DEFAULT_PROVIDER")
    return pick if pick and pick in _BY_ID else None


def describe(p: Provider) -> dict:
    """Client-safe provider descriptor — NEVER includes the key material.

    The ``*_from_env`` booleans mirror ``key_from_env`` so the UI can disable an
    env-pinned field (and the make-active button) with an explainer instead of
    letting the user edit a value the resolver will silently override. ``base_url``
    is the RAW template (``substitute=False``) so an account-scoped default shows
    ``{account_id}`` rather than a baked-in value; ``account_id`` is returned
    separately for account-scoped providers so the field can round-trip.
    """
    d = {
        "id": p.id,
        "display_name": p.display_name,
        "local": p.local,
        "needs_account": p.needs_account,
        "signup_url": p.signup_url,
        "notes": p.notes,
        "base_url": resolve_base_url(p, substitute=False),
        "model": resolve_model(p),
        "has_key": has_key(p),
        "key_from_env": bool(_env_first(p.key_envs)),
        "base_url_from_env": bool(p.base_url_env and os.environ.get(p.base_url_env)),
        "model_from_env": bool(p.model_env and os.environ.get(p.model_env)),
        "active_from_env": _active_env_pin() is not None,
        "configured": is_configured(p),
    }
    if p.needs_account:
        d["account_id"] = resolve_account_id(p)
        d["account_from_env"] = bool(p.account_env and os.environ.get(p.account_env))
    return d
