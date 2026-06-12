# Voice Console 10/10 — polish spec

**Goal:** take the consolidated Voice workspace from ~7/10 to reference-quality (Linear/Raycast tier) without losing the studio identity. The thesis: **three questions, three zones** — *What should it say?* (Script) · *Who says it?* (Voice) · *Go* (a pinned action bar). Everything else is progressive disclosure.

Scope: the `studio` workspace only (CloneDesignTab + right rail). No backend changes.

---

## 0 — Wireframe

```
┌────────────────────────────────────────────────────────────────────────────────────────────┐
│ ◉ Voice                          ⊙ OmniVoice                            🔔2  ● Idle  ⚡Flush │
├──┬──────────────────────────────────────────────────────┬──────────────────────────────────┤
│  │  SCRIPT                                              │ ┌─ ACTIVE VOICE ───────────────┐ │
│◉ │ ┌──────────────────────────────────────────────────┐ │ │ ◉ Maya — designed            │ │
│  │ │ You came a long way for an answer you already    │ │ │ male · elderly · very low    │ │
│◌ │ │ had. Sit. The fire is warm, and the truth▌       │ │ │ ▶ ▁▂▅▇▅▂▁ sample · 0:03      │ │
│  │ │                                                  │ │ │ [Edit voice]    [+ New]     │ │
│◌ │ │                                       ⊕ Insert ▾ │ │ └──────────────────────────────┘ │
│  │ └──────────────────────────────────────────────────┘ │                                  │
│◌ │     └ tag popover: [laughter][sigh][question-…]      │  SAVED VOICES            search ⌕│
│  │                                                      │ │ ◉ Maya        designed   ▶   │ │
│◌ │  VOICE            ( From audio ) (● By design )      │ │ ◌ The Anchor  clone      ▶   │ │
│  │ ┌──────────────────────────────────────────────────┐ │ │ ◌ Storyteller clone      ▶   │ │
│◌ │ │ ✎ warm elderly storyteller, slightly raspy…      │ │                                  │
│  │ └──────────────────────────────────────────────────┘ │  HISTORY      [All][Clone][Des] │
│  │  Starting points                                  ‹ ›│ │ ⬢ DESIGN   English · 19.8s   │ │
│  │  (Narrator)(Casual)(News)(Story)(Corporate)(Energ…   │ │ You came a long way for an…  │ │
│  │                                                      │ │ ▶ ▂▅▇▅▂▇▅▂  0:08 · seed 32…  │ │
│  │  Identity   male · elderly · very low pitch    ⌄     │ │ 💾 🔒 ⤓ 📂 🗑                 │ │
│  │  ┌─ expanded ──────────────────────────────────────┐ │ ├──────────────────────────────┤ │
│  │  │ Gender  (✦Auto)(●male)(female)                  │ │ │ ⬡ CLONE    0:12              │ │
│  │  │ Age     (✦Auto)(child)(teen)(young)(mid)(●eld)  │ │ │ …                            │ │
│  │  │ Pitch   (✦Auto)(v.low●)(low)(mod)(high)(v.high) │ │ └──────────────────────────────┘ │
│  │  │ Style   (●Auto)(whisper)   Accent[Auto▾] Dial[▾]│ │                                  │
│  │  └─────────────────────────────────────────────────┘ │                                  │
│  ├──────────────────────────────────────────────────────┤                                  │
│  │  Fr French ▾   Steps ── 10   ⚙ Overrides ▸          │                                  │
│  │ ┃            ▷  SYNTHESIZE  (⌘↵)                   ┃ │                                  │
├──┴──────────────────────────────────────────────────────┴──────────────────────────────────┤
│ ▾ Logs 11 · Updates                                                      ⚲ Local   ⬡  ♥    │
└────────────────────────────────────────────────────────────────────────────────────────────┘
   └ rail      └ SCRIPT → VOICE scroll · ACTION BAR pinned     └ Active voice → library → work
```

**Action bar (pinned, never scrolls away):**
```
├──────────────────────────────────────────────────────────┤
│  Fr French ▾    Steps ───●─── 10    ⚙ Overrides ▸        │   ← generation params live
│ ┃              ▷  SYNTHESIZE   ⌘↵                       ┃ │     WITH the button
└──────────────────────────────────────────────────────────┘
   while generating: ┃ ◐ Synthesizing… 3.2s   ■ Stop ┃  + thin progress under the bar
```

**Identity summary (collapsed by default once set):**
```
 Identity   male · elderly · very low pitch · whisper        ⌄
            └ one quiet line = current voice recipe; click expands the chips.
              Describe-box edits update this line live (the magic moment).
```

**Right rail — Active voice card (new):**
```
┌─ ACTIVE VOICE ────────────────────────┐
│ ◉ Maya                     [designed] │   ← identity always visible: who will
│ male · elderly · very low pitch       │     speak the next Synthesize
│ ▶ ▁▂▅▇▅▂▁  sample · 0:03              │   ← one-click identity check
│ [Edit voice]              [+ New]    │
└───────────────────────────────────────┘
Empty state:  "No voice selected — describe one ←, drop audio, or pick below."
```

---

## 1 — The five structural moves

1. **Pinned action bar.** Language, Steps, Overrides-disclosure and SYNTHESIZE form one bar pinned to the column bottom (`flex` footer; content scrolls above, wizard pattern). They are *generation* parameters — they belong with the button, not strewn mid-column. `⌘↵` synthesizes from anywhere; while generating the bar swaps to progress + Stop.

2. **Two kickers, total.** `SCRIPT` and `VOICE` are the only mono section headers. DEFINE VOICE / DESCRIBE YOUR VOICE / PERSONALITY / PICK A PERSONALITY PRESET all die: the From-audio/By-design toggle sits inline beside the VOICE kicker; the describe box explains itself by placeholder; presets get a 12px-cap label ("Starting points").

3. **One preset system.** The top PROMPT chips (`utils/constants.js PRESETS`) and the personality strip merge into a single horizontally-scrollable "Starting points" row under the describe box — both already set `vdStates`+`instruct`; two widgets for one slot is the confusion. (PRESETS' script-prefill behavior is kept: chips that carry a script also fill SCRIPT when it's empty.)

4. **Insert popover replaces the tag wall.** The 14 `[tag]` chips leave the permanent layout; an `⊕ Insert ▾` affordance at the textarea corner opens a compact popover grid (search-filterable). Tags are an occasional power feature; they were renting the most expensive pixels on the page.

5. **Identity summary line.** The four chip-groups + two selects collapse to one quiet recipe line (`male · elderly · very low pitch`) once any value is non-Auto; click (or describe-box activity) expands. First-run (all Auto) starts expanded. This is the single biggest density win and it makes describe-→-controls feel magical (the line rewrites live).

## 2 — Right rail: identity first

Order: **ACTIVE VOICE card → Saved voices → History.** The card answers "who will speak when I press Synthesize" — currently invisible until output surprises you. Card shows name, method badge, recipe line, a 3s identity sample (`<WaveformPlayer compact>` of the profile's ref/rendered audio), Edit (loads into the form) and + New (clears). Empty card carries verbs, not absence: *"describe one ←, drop audio, or pick below."* Saved voices shrinks to compact rows (name · badge · play); history unchanged (post-#389).

## 3 — Craft rules (the last 2 points live here)

- **8-pt rhythm:** every gap/padding ∈ {4, 8, 12, 16, 24}; section gap 24, intra-group 8. One audit pass, then a lint comment in index.css.
- **Type scale = 3:** kicker 11/mono/caps · body 13 · meta 11. No other sizes in this view.
- **Two accents max per view:** brand pink (actions/active) + per-mode badge color. Everything else neutral chrome.
- **Overflow honesty:** every horizontally-scrollable lane (starting points, tag popover rows) gets edge fade-masks + `‹ ›` nudgers on hover. A clipped chip must never render a cut glyph.
- **A11y gate (measurable):** muted text ≥ 4.5:1 (new `--chrome-fg-muted` value, verified per theme); chip groups are `role="radiogroup"` with roving-tabindex arrow keys; visible `:focus-visible` ring on every interactive; `prefers-reduced-motion` kills shimmer/pulse/marquee; generation status `aria-live="polite"`.
- **Motion:** 120–160ms ease-out only; identity-line expand/collapse animates height; nothing loops forever except the active-generation dot.
- **Micro-delights (pick 3, not 10):** hover-scrub preview on waveforms; `⌘↵` synthesize + `/` focuses describe; starting-point chip hover shows a 1-line "what it sets" hint.

## 4 — Acceptance criteria = the 10/10 bar

| Dimension | Pass when |
|---|---|
| Fold | SYNTHESIZE visible at 1280×720 @100% and at 175% scale, always |
| Hierarchy | ≤2 mono kickers in the column; ≤3 type sizes; no orphan labels |
| Consistency | exactly one preset widget; all spacing on the 8-pt grid |
| Density | define-a-voice (describe → synthesize) ≤ 1 screen, zero scrolling |
| Empty states | every empty panel names the next action and deep-links it |
| Overflow | no cut glyphs at any width 900–2560px; fades on every scroll lane |
| A11y | axe-core clean on the view; full keyboard path describe→synthesize; 4.5:1 on all text |
| State | active voice always visible; generating state reachable by screen reader |

## 5 — Phasing (continuous-to-main)

1. **P1 — Action bar + fold** (pin lang/steps/overrides/CTA; `⌘↵`) — biggest score jump, pure layout
2. **P2 — Label collapse + preset unification + Insert popover** — hierarchy & consistency
3. **P3 — Identity summary line + Active-voice card + empty-state verbs** — density & identity
4. **P4 — Craft pass** (8-pt audit, contrast tokens, radiogroups, focus, reduced-motion, fades, micro-delights ×3)

Each phase ships alone; P1–P3 are frontend-only; P4 touches theme tokens (verify per-theme contrast).
