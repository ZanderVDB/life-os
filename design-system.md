# Life OS — Design System

**Version 2.0 · Established 2026-07-30 · The single source of truth.**

> Read this file first, every session, before touching any UI.
> Update it whenever a design decision is made.
> **If code conflicts with this file, this file wins.** Old decisions are not
> preserved just because they exist — every choice must earn its place here.

**The project documents:**
| File | Role |
|---|---|
| `design-system.md` | **This file.** The constitution — every permanent decision. |
| `docs/build-progress.md` | Chronological record of completed steps; where we are now. |
| `docs/design-ideas.md` | Roadmap capture. Future ideas — **never built automatically.** |

**Audit of the existing system** (2026-07-31, read before redesigning a screen):
`docs/current-system-audit.md` · `docs/data-model-map.md` ·
`docs/page-capability-map.md` · `docs/integration-map.md` ·
`docs/technical-debt.md` · `docs/redesign-dependency-map.md`

---

## 1. Philosophy

Life OS is **an operating system for your life**, not a productivity app. It
should feel handcrafted, premium, calm, focused, and intentional. Every pixel
is considered.

**References:** Apple · Linear · Notion · Raycast · Arc.
**Never:** flashy · gaming · cyberpunk · neon · "futuristic."

**The One Rule** — every screen answers a single question:
> *"What is the most important thing this person should focus on right now?"*

Anything that doesn't help answer it becomes **visually quieter**.

**Priorities, in order:** hierarchy > decoration · whitespace > borders ·
elevation & contrast > outlines · **one hero per screen**.

---

## 2. Colour

Dark theme only. **Purple is the brand and the only accent. No rainbow.**

### Canvas & surfaces
| Role | Value |
|---|---|
| App canvas | `linear-gradient(180deg, #1A1624 0%, #141220 52%, #111018 100%)` |
| Sidebar | `#17151F` |
| Right rail | `#1D1A28` |
| Surface 1 — card | `#211E2C` |
| Surface 2 — raised | `#2A2536` |
| Surface 3 — hover | `#322C40` |
| Hairline (use rarely) | `#332E43` |

### Text
| Role | Value |
|---|---|
| Primary | `#F4F2FA` |
| Secondary | `#B5ABC9` |
| Muted / placeholder | `#766D8B` |
| Section label | `#CEC7E8` |

### Accent — purple (the one accent)
Purple represents **interaction, focus, progress, selection, and primary
actions**. Nothing else is an accent.
| Role | Value |
|---|---|
| Accent | `#8A5DFF` |
| Brand / primary gradient | `#7C4DFF → #C28DFF` |
| Name gradient (animated) | `#C89BFF → #8A5DFF` |
| Selection / focus glow | `rgba(124,77,255,.22)` |

### Status — meaning only (never decoration)
Two status colours, each with exactly one job. Always pair with an
icon/label/shape — **never colour alone**. **Neutral greys** carry inactive,
secondary, and disabled states.
| Role | Value | Used for |
|---|---|---|
| Success | `#00D9A3` | success / completed states ONLY |
| Danger | `#FF646E` | destructive actions, errors, urgent warnings ONLY |

**Brand colours** (e.g. Google `#4285F4`) appear **only inside official logos or
integration marks**, where they aid recognition — never as a UI accent or
surface. The Google Calendar banner surface stays neutral; the Google glyph
inside it may carry brand blue.

**Eliminated as accents:** cyan, amber, gold, decorative blue. If information
needs differentiating, reach for **typography, spacing, icons, shape, or
hierarchy before colour.**

---

## 3. Typography

- **UI font:** Inter, everywhere (system fallback stack). Geist is a possible
  future swap for the UI font — not now.
- **Wordmark:** "Life OS" set in **Playfair Display** (refined serif) — the
  **only** serif anywhere in the app. The lotus mark + wordmark are a single
  **logo lockup**, always together. No other heading or element uses serif.
- **Greeting is the hero** (see §Hero): 34–40px / 800, tight leading, the
  user's name in the animated purple **name gradient**. (Set in Inter, not the
  serif — the serif is reserved for the wordmark lockup.)

**Scale — no tiny text.**
| Token | Size / weight | Notes |
|---|---|---|
| Display (greeting) | 34–40 / 800 | hero only |
| Page title | 26–30 / 700 | one per screen |
| Section label | 12 / 600 | UPPERCASE, `.16em` tracking, `#CEC7E8` |
| Body | 14 / 450 | default |
| Body-strong | 14 / 600 | |
| Small | 12 / 500 | **floor for readable text** |
| Micro | 11 / 600 | all-caps + tracking ONLY |

**Never below 11px.** 11px is reserved for tracked all-caps labels.

---

## 4. Radius

| Element | Radius |
|---|---|
| Major cards / workspaces | 16px |
| Inner cards / rows | 12px |
| Buttons / pills | 10px |
| Chips / badges | 8px |
| Rings / avatars | 999px |

---

## 5. Shadows / Elevation

Soft, never harsh. Depth replaces borders.
| Token | Value | Use |
|---|---|---|
| `e1` subtle | `0 2px 8px rgba(0,0,0,.14)` | rows, chips |
| `e2` card | `0 8px 24px rgba(0,0,0,.22)` | cards, workspaces |
| `e3` lifted | `0 14px 34px rgba(0,0,0,.32)` | dialogs, hover-lift |
| `glow` | `0 6px 18px rgba(124,77,255,.22)` | **primary CTA only** |

---

## 6. Spacing

**4px base grid:** 4 · 8 · 12 · 16 · 20 · 24 · 32 · 40 · 48.
| Context | Value |
|---|---|
| Major section gap | 32 |
| Card padding | 16–18 |
| List row gap | 8–10 |
| Task-bucket column gap | 20 |

Generous whitespace is the default. **When unsure, add space.**

---

## 7. Animation

**Nothing appears or disappears instantly. Motion communicates state — it is
never decorative.** Subtle, fast, smooth, natural, with weight.

### Tokens (implemented — use these, never hand-roll a curve)

| Duration | Value | Use |
|---|---|---|
| `--d-instant` | 90ms | colour-only swaps, press |
| `--d-fast` | 140ms | hover, focus |
| `--d-base` | 200ms | selection, tabs, toggles |
| `--d-slow` | 260ms | page transitions, dialogs |
| `--d-slower` | 320ms | side panels, drawers |

| Easing | Value | Use |
|---|---|---|
| `--e-out` | `cubic-bezier(.2,.7,.2,1)` | **default** — enter / settle |
| `--e-in` | `cubic-bezier(.4,0,.9,.4)` | exit / dismiss |
| `--e-inout` | `cubic-bezier(.4,0,.2,1)` | moving between two states |
| `--e-linear` | `linear` | progress + spinners only |

**Primitives:** `--m-lift: -2px` · `--m-press: .97` · `--m-rise: 8px` ·
`--m-slide: 12px`.
**Composites:** `--t-hover` · `--t-press` · `--t-focus` · `--t-select` ·
`--t-move` · `--t-fade`.
**Utilities:** `.m-enter` `.m-fade` `.m-scale` `.m-stagger` (set `--i` per child)
`.m-spin` `.m-skeleton` `.m-loading` `.m-progress-fill` `.m-error-nudge`.

> **NO OVERSHOOT.** Every curve decelerates into place. Any `cubic-bezier`
> with a control point > 1 is banned — it reads as playful/bouncy.

**Coverage** — hover · press · focus · selection · page transitions · dialogs ·
dropdowns · context menus · tooltips · cards · buttons · inputs · tabs ·
drag & drop · toasts · side panels · loading · skeletons · progress · success ·
error.

| Interaction | Motion |
|---|---|
| Nav select | slide + fade + soft settle |
| Page switch | crossfade + slight slide (shell stays put) |
| Card enter | fade + rise 6px, **staggered ~30ms** |
| Hover | lift `-2px` |
| Button press | scale `.97` |
| Sidebar / panel | glide |
| Dialog | scale `.96 → 1` + fade |
| Drag & drop | fluid, follows cursor; others reflow smoothly |

**Always honour `prefers-reduced-motion`** (fall back to fades / none).

---

## 8. Interaction principles

- **Optimistic first.** Local state updates instantly. Saving is invisible and
  happens in the background. The UI **never rubber-bands, reverts, or jumps**
  because of a save, and editing is **never blocked** by saving.

### Autosave architecture (implemented — do not regress)

Local memory is the **source of truth** the moment the user acts. The network
reconciles behind them.

1. **Echo suppression.** Firestore echoes our own writes back through
   `onSnapshot` — once locally (`hasPendingWrites: true`) and again on server
   ack. Because `updatedAt` is a `serverTimestamp()` sentinel it resolves
   twice, so **every save used to fire two snapshots, each overwriting state
   and forcing a full re-render.** That was the rubber-banding. We now drop the
   local echo outright, and fingerprint state before/after to skip the
   server echo. **A save now causes zero re-renders.**
2. **Never re-render under an active interaction.** If the user is typing or
   dragging (`_isUserBusy()`), a genuine remote change is *deferred* and
   applied on `focusout`/`dragend` — never mid-keystroke.
3. **Coalescing write loop.** Rapid edits set a dirty flag; a single loop
   drains it with the *latest* payload. 50 keystrokes = 1 write.
4. **Failure never reverts.** Writes retry with exponential backoff (max 6,
   capped 30s) and resume on `online`. Local edits are always kept.
5. **Silent on success.** The save indicator only appears when writes are
   genuinely failing ("Reconnecting…" / "Offline — changes kept on this
   device"). The user should never feel a save happen.
6. **Never write before initial sync** — an empty local state must not
   overwrite real cloud data.
- **One hero per screen.** Everything else is quieter.
- **Immediate, physical feedback** on every action.
- **Progressive disclosure** over dense screens.

---

## 9. Accessibility

- Text contrast ≥ WCAG AA. Body ≥ 14; nothing below 11px.
- **Keyboard focus is always visible** — a custom ring
  (`2px rgba(138,93,255,.7)`, 2px offset). *Never remove focus outright*
  (corrects the earlier `outline:none` on nav).
- Hit targets ≥ 40px.
- `prefers-reduced-motion` respected everywhere.
- Never convey state by colour alone — pair with icon/label/shape.

---

## 10. Component library (canonical)

- **Buttons** — Primary (brand gradient + `glow`), Secondary (`Surface 2`, no
  border), Ghost (transparent), Danger (red text/tint). Press `scale(.97)`,
  hover lift.
- **Cards** — Surface (static) · Raised (`e2`) · Interactive (hover lift → `e3`).
- **Inputs** — surface bg, no border by default, purple focus ring, roomy padding.
- **Section header** — tracked uppercase label + optional right-aligned action.
- **Nav item** — transparent → hover `Surface` → selected purple-gradient pill
  (animated). Icon + label.
- **Habit ring** — circular progress; fills toward next streak milestone.
- **Task card** — neutral surface, semantic priority stripe, drag affordance.
- **Dialog** — centred, `e3`, scale+fade, dimmed scrim.
- **Save indicator** — silent by default; only surfaces on error.
- **Empty state** — icon + one line + one action. Never a bare "nothing here."

---

## 11. Navigation philosophy

- **Left sidebar** = primary navigation. Icon + label; selected = animated
  purple pill. Persistent.
- **Right rail** = contextual, eventually *intelligent* widgets (Needs
  Attention · Next Events · Daily Habits).
- **AI command bar** = the universal capture/action command centre.
- **Transitions are continuous** — the shell (sidebar + rail) is persistent;
  only the main column crossfades between pages. No hard cuts.

**Step 2 — locked nav behaviour:**
- **Sliding indicator:** a *single* shared purple element physically glides
  between items (translateY only — GPU). Never disappears/reappears; snaps on
  first reveal, glides thereafter. Selected item's label gains **weight**, not
  loud brightness. No pop, no bounce.
- **One icon system:** hover → brighten + 1px nudge; selected → inherits the
  indicator; disabled → opacity only.
- **Timings:** hover 140ms · active/glide 200ms · page 260ms · all ease-out.
- **Width is a token** (`--sidebar-w`, `--rail-w`) → Expanded / Compact /
  Icon-only / Drawer modes plug in later without touching the grid.
- **Search = command-palette entry point** (grows into search + AI + quick
  actions + navigation + commands), never a dead search field.
- **Logo intro:** on first load the lockup plays ONE intro (lotus settles →
  wordmark eases in) then rests calm. Never loops.
- **Mobile:** the sidebar is architected to become a slide-out drawer; no
  desktop-only assumptions.

---

## 12. We intentionally avoid

- Extra / rainbow colours; colour used decoratively.
- Borders as the primary separator (use space / shadow / contrast).
- Tiny text (< 11px); low-contrast text.
- Harsh, hard-edged shadows.
- Instant appear / disappear; janky or decorative animation.
- Multiple competing focal points on one screen.
- Gamer / glow / cyberpunk / neon; skeuomorphic gimmicks that fight calm.
- Gradients on everything — gradient is **reserved** for: brand mark, primary
  CTA, greeting name, and the single hero moment of a screen.
- Save-related rubber-banding or edit-blocking.

---

## 13. Resolved decisions

- **2026-07-30 — Colour:** one accent system. **Purple** = interaction, focus,
  progress, selection, primary actions. **Green** = success/completed only.
  **Red** = destructive/error/urgent only. **Greys** = inactive/secondary/
  disabled. Brand colours only inside logos/integration marks. Cyan, amber,
  gold, decorative blue **eliminated** as accents. Differentiate by type/space/
  icon/shape/hierarchy before colour. (§2)
- **2026-07-30 — Wordmark:** "Life OS" in **Playfair Display**, the *only*
  serif in the app; lotus + wordmark = one logo lockup; **Inter** everywhere
  else (Geist a possible future UI-font swap). (§3)
- **2026-07-30 — Library (step 10):** a **premium digital library**, not a
  realistic bookshelf. Physicality via depth/shadow/motion only — **no**
  skeuomorphic textures or page-curls. Books sit on elegant shelves, ease
  forward on hover, and open by the **cover expanding into the workspace** with
  contents fading in; page navigation is **fast horizontal slides / subtle
  crossfades**. Goal: "handling a beautiful notebook," not simulating paper.

---

## 14. Rebuild order (do not skip ahead; finish each before the next)

1. **Global Design System** ← *this file*
2. Navigation & Sidebar
3. Design Tokens & Animations
4. Today Dashboard
5. Task Detail View
6. Calendar
7. Projects (full redesign)
8. Project Detail Workspace
9. Gantt View
10. Library (Diary + Notebook merge)
11. Brain
12. AI Command Centre
13. Right Sidebar Widgets
14. Settings
15. Mobile Experience
16. Performance Optimisation
17. Final Polish

---

## Changelog
- **2026-07-30 — v2.0** established (design reset). Palette, type scale, radius,
  shadow, spacing, animation, a11y, components codified from the graphite
  direction.
- **2026-07-30 — v2.0.1** §13 decisions locked: one-accent colour system
  (purple + green + red only), Playfair wordmark as the sole serif, restrained
  premium Library. **Step 1 (Global Design System) complete.**
- **2026-07-30 — Step 2 (Navigation & Sidebar) built** (v238, pending review):
  shared sliding active indicator (translateY, macOS-style); one nav
  interaction system (hover brighten + 1px glyph nudge, selected gains weight,
  no pop/bounce); quieter label weight; continuous route crossfade (260ms);
  `--sidebar-w`/`--rail-w` layout tokens; command-palette-ready search; a
  one-time logo intro that replaces the looping shimmer; full keyboard nav
  (↑/↓/Home/End), a restored visible focus ring, Escape closes drawers, ARIA
  labels + `aria-current`, reduced-motion honoured, GPU-only transforms.
- **2026-07-30 — Step 3 (Design Tokens & Motion System) complete** (v239):
  full motion-token system (§7) covering all 21 interaction categories; **every
  overshoot easing removed app-wide** (verified 0 remaining); press `.93→.97`,
  hover lift `-2px`. **Autosave rearchitected** (§8) — Firestore write-echo
  suppression + state fingerprinting means a save now triggers **zero
  re-renders**, remote changes defer while typing/dragging, writes coalesce and
  retry with backoff, failures never revert, indicator silent on success.
  Added `build-progress.md` + `design-ideas.md`. No pages redesigned.
