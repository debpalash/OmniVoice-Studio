/**
 * Settings category registry — the single source of truth for the sidebar IA.
 *
 * The Settings page is a sidebar-nav + content-pane hub (macOS System Settings
 * / VS Code style). This module declares the four sidebar GROUPS and their
 * categories (id, group, label, lucide icon, restart flag, and a small set of
 * searchable setting keywords). Settings.jsx renders the sidebar from GROUPS
 * and switches the content pane on the active category id.
 *
 * Keep this declarative — no JSX panels here (those need props/hooks and live
 * in Settings.jsx's renderCategory switch). `keywords` powers the bonus
 * "search matches a setting → jump to its category" behaviour.
 */
import {
  Palette,
  Settings2,
  Plug,
  Cpu,
  Mic,
  SpellCheck,
  Languages,
  Brain,
  Gauge,
  HardDrive,
  Wifi,
  Share2,
  KeyRound,
  Sparkles,
  ArrowDownToLine,
  ShieldCheck,
  FileText,
  Info,
} from 'lucide-react';

/** Sidebar groups, in display order. `labelKey` resolves via i18n. */
export const GROUPS = [
  {
    id: 'general',
    labelKey: 'settings.group_general',
    defaultLabel: 'General',
    items: [
      {
        id: 'appearance',
        labelKey: 'settings.appearance',
        defaultLabel: 'Appearance',
        icon: Palette,
        keywords: [
          'theme',
          'color theme',
          'ui scale',
          'font',
          'auto-play preview',
          'header live stats',
          'system metrics',
        ],
      },
      {
        id: 'general',
        labelKey: 'settings.general',
        defaultLabel: 'General',
        icon: Settings2,
        keywords: ['language', 'locale', 'interface language', 'review mode', 'stage checkpoints'],
      },
    ],
  },
  {
    id: 'voice',
    labelKey: 'settings.group_voice',
    defaultLabel: 'Voice & Engines',
    items: [
      {
        id: 'engines',
        labelKey: 'settings.engines',
        defaultLabel: 'Engines',
        icon: Plug,
        keywords: ['engine', 'tts engine', 'indextts', 'cosyvoice', 'compatibility', 'gpu'],
      },
      {
        id: 'models',
        labelKey: 'settings.models',
        defaultLabel: 'Models',
        icon: Cpu,
        restart: true,
        keywords: [
          'model',
          'download',
          'cache directory',
          'models directory',
          'hugging face mirror',
          'hf_endpoint',
        ],
      },
      {
        id: 'dictation',
        labelKey: 'settings.dictation',
        defaultLabel: 'Dictation',
        icon: Mic,
        keywords: [
          'dictation',
          'hotkey',
          'shortcut',
          'refinement',
          'echo cancellation',
          'aec',
          'microphone',
          'voice capture',
        ],
      },
      {
        id: 'pronunciation',
        labelKey: 'settings.pronunciation',
        defaultLabel: 'Pronunciation',
        icon: SpellCheck,
        keywords: ['pronunciation', 'lexicon', 'phoneme', 'g2p', 'dictionary'],
      },
      {
        id: 'translation',
        labelKey: 'settings.translation',
        defaultLabel: 'Translation',
        icon: Languages,
        keywords: [
          'translation',
          'translate quality',
          'cinematic',
          'llm endpoint',
          'deepl',
          'microsoft',
          'openai',
          'api key',
        ],
      },
    ],
  },
  {
    id: 'system',
    labelKey: 'settings.group_system',
    defaultLabel: 'System',
    items: [
      {
        id: 'performance',
        labelKey: 'settings.performance',
        defaultLabel: 'Performance & Device',
        icon: Gauge,
        restart: true,
        keywords: [
          'performance',
          'torch.compile',
          'device',
          'gpu',
          'ram',
          'vram',
          'compute',
          'platform',
        ],
      },
      {
        id: 'storage',
        labelKey: 'settings.storage',
        defaultLabel: 'Storage',
        icon: HardDrive,
        keywords: [
          'storage',
          'data directory',
          'outputs directory',
          'factory reset',
          'reset',
          'disk usage',
          'free space',
          'disk space',
          'model cache size',
          'engine venvs',
          'temp files',
          'clear logs',
        ],
      },
      {
        id: 'network',
        labelKey: 'settings.network',
        defaultLabel: 'Network',
        icon: Wifi,
        keywords: ['network', 'proxy', 'http proxy', 'socks', 'ffmpeg', 'ffmpeg path'],
      },
      {
        id: 'sharing',
        labelKey: 'settings.sharing',
        defaultLabel: 'Sharing & Remote',
        icon: Share2,
        restart: true,
        keywords: ['sharing', 'remote backend', 'mcp', 'tailscale', 'gpu box', 'bindings'],
      },
      {
        id: 'credentials',
        labelKey: 'settings.credentials',
        defaultLabel: 'Credentials',
        icon: KeyRound,
        keywords: ['credentials', 'hugging face token', 'hf token', 'api key', 'secret'],
      },
      {
        id: 'llm-providers',
        labelKey: 'settings.llm_providers',
        defaultLabel: 'LLM Providers',
        icon: Brain,
        keywords: [
          'llm',
          'provider',
          'api key',
          'openai',
          'openrouter',
          'groq',
          'ollama',
          'gemini',
          'cinematic',
          'autofit',
          'translation quality',
        ],
      },
      {
        id: 'llm-skills',
        labelKey: 'settings.llm_skills',
        defaultLabel: 'LLM Skills',
        icon: Sparkles,
        keywords: [
          'llm',
          'skills',
          'ai features',
          'routing',
          'local model',
          'ollama',
          'lm studio',
          'cinematic',
          'refinement',
          'glossary',
          'direction',
          'slot fitting',
        ],
      },
    ],
  },
  {
    id: 'app',
    labelKey: 'settings.group_app',
    defaultLabel: 'App',
    items: [
      {
        id: 'updates',
        labelKey: 'settings.updates',
        defaultLabel: 'Updates',
        icon: ArrowDownToLine,
        keywords: ['update', 'channel', 'stable', 'preview', 'releases', 'changelog'],
      },
      {
        id: 'privacy',
        labelKey: 'settings.privacy',
        defaultLabel: 'Privacy & Reporting',
        icon: ShieldCheck,
        keywords: ['privacy', 'reporting', 'telemetry', 'tracking', 'network calls'],
      },
      {
        id: 'logs',
        labelKey: 'settings.logs',
        defaultLabel: 'Logs',
        icon: FileText,
        keywords: ['logs', 'backend log', 'frontend log', 'tauri log', 'report a bug'],
      },
      {
        id: 'about',
        labelKey: 'settings.about',
        defaultLabel: 'About',
        icon: Info,
        keywords: ['about', 'version', 'license', 'diagnostics', 'self check'],
      },
    ],
  },
];

/** Flat list of every category, in sidebar order. */
export const CATEGORIES = GROUPS.flatMap((g) => g.items.map((it) => ({ ...it, group: g.id })));

/** Fast lookup: category id → category record. */
export const CATEGORY_BY_ID = Object.fromEntries(CATEGORIES.map((c) => [c.id, c]));

/** The category shown on first open (and the deep-link/persist fallback). */
export const DEFAULT_CATEGORY = 'general';

/**
 * Map legacy Settings tab ids (the old 11-tab shell, still used by deep-links
 * like the footer version badge → 'updates') onto the new category ids. Any id
 * not listed is assumed to already be a valid new category id.
 */
export const LEGACY_TAB_MAP = {
  capture: 'dictation',
};

/** Resolve any incoming tab/category id to a valid new category id. */
export function resolveCategoryId(id) {
  if (!id) return DEFAULT_CATEGORY;
  const mapped = LEGACY_TAB_MAP[id] || id;
  return CATEGORY_BY_ID[mapped] ? mapped : DEFAULT_CATEGORY;
}

/**
 * Given a lowercased query, return the set of category ids whose label OR any
 * keyword matches. Used to filter the sidebar and to power "search a setting →
 * jump to its category".
 */
export function matchCategories(query, labelFor) {
  const q = query.trim().toLowerCase();
  if (!q) return CATEGORIES.map((c) => c.id);
  return CATEGORIES.filter((c) => {
    const label = (labelFor ? labelFor(c) : c.defaultLabel).toLowerCase();
    if (label.includes(q)) return true;
    return (c.keywords || []).some((k) => k.toLowerCase().includes(q));
  }).map((c) => c.id);
}
