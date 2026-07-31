# Legacy → v2 visual parity audit

**Date:** 2026-07-31 · **Legacy reference:** v244 (`index.html`, theme `studio`)
**v2 reference:** commit `feec22b` on staging

Measurements are taken from the Legacy stylesheet, which is the authoritative
record — it holds decisions that documentation cannot express. No task content
appears in this document.

---

## Root cause of the regression

**The v2 shell was reconstructed from `design-system.md` rather than ported from
the Legacy stylesheet.**

The design system describes *principles* — purple is the accent, the rail is
contextual, motion is restrained. It does not carry the numbers: a 56px gutter,
a 380px rail, a 2200px content ceiling, a 1544px composer. Rebuilding from
principles produced something that satisfies every stated rule and still looks
nothing like the approved product.

One omission explains most of the visible damage.

### The nested grid

```css
/* Legacy */
.app       { grid-template-columns: var(--sidebar-w) 1fr; }        /* 2 columns */
.main-wrap { grid-template-columns: minmax(0,1fr) var(--rail-w);   /* nested */
             gap: 56px;
             padding: 32px 32px 140px 44px;
             max-width: 2200px; margin: 0 auto; }
```

```css
/* v2 as built — wrong */
.shell { grid-template-columns: var(--sidebar-w) minmax(0,1fr) var(--rail-w); }
```

v2 flattened three columns into one grid. Consequences, each matching a symptom
in the rejection:

| Symptom reported | Cause |
|---|---|
| "large dead area in the centre" | no `max-width`, so content stretched to the viewport edge |
| "right rail feels visually detached" | no gutter — Legacy separates them by **56px** |
| "left sidebar feels too narrow" | correct width, but nothing balanced it on the right |
| "buckets compressed vertically" | the grid had no breathing room to distribute |
| "resembles an admin dashboard" | edge-to-edge full-bleed layout is the dashboard look |

---

## Measured differences

### Layout

| Property | Legacy | v2 as built | Verdict |
|---|---|---|---|
| Sidebar width | `232px` | `236px` | ~parity |
| **Rail width** | **`380px`** | `300px` | **wrong** |
| **Content ↔ rail gutter** | **`56px`** | `0` | **wrong** |
| **Content max-width** | **`2200px`** | none | **wrong** |
| **Content padding** | **`32px 32px 140px 44px`** | `22px 34px 140px` | **wrong** |
| Section stack gap | `28px` (`.main-col`) | `20px` | wrong |
| Today route gap | `32px` | n/a | wrong |
| Rail card gap | `14px` | `14px` | parity |
| Rail sticky offset | `top:22px`, `max-height:calc(100vh - 60px)` | full-height column | wrong |

### Buckets and tasks

| Property | Legacy | v2 as built | Verdict |
|---|---|---|---|
| Bucket grid | `repeat(3,minmax(0,1fr))`, gap `20px` | same | parity |
| Bucket card | `radius 16px`, `padding 15px 14px 13px` | `18px` / `16px 14px 14px` | near |
| Bucket header | `11.5px`, `.16em`, 600, `#CEC7E8` | `11px` | near |
| Bucket count | has `1px solid var(--border)` | no border | wrong |
| Empty state | `12px` **italic**, `padding 13px 4px` | 12.5px roman, bold heading | wrong |
| Empty drop zone | `1.5px dashed var(--border)` | none | wrong |
| Row gap in list | `7px` | `8px` | near |
| Task row | `#282431`, `radius 12px`, `padding 11px 14px 11px 16px` | same | **parity** |
| Task title | `13px`, `line-height 1.45` | same | **parity** |
| Priority stripe | `4px`, gradient var | same | parity |
| Urgent | `inset 0 0 0 1.5px #FF646E, 0 0 18px -7px rgba(255,100,110,.55)` | same | parity |
| Breakpoint to 1 column | `1024px` | `1080px` | near |

**The task row itself was already at parity.** The reported "task text is
undersized" is a consequence of the container: rows correctly sized at 13px look
small inside a column stretched across a 2560px screen. Fixing the grid fixes
the perception without touching the type.

### Navigation

| Property | Legacy | v2 as built | Verdict |
|---|---|---|---|
| Indicator height | **fixed `44px`** | item height (`42px`) | wrong |
| Indicator gradient | `#7C4DFF → #9A67FF` | `#7C4DFF → #C28DFF` | wrong (that is the *button* gradient) |
| Indicator shadow | `0 6px 18px -6px rgba(124,77,255,.5)` | `-7px` spread, `.6` | near |
| Indicator radius | `10px` | `11px` | near |
| Transition | `transform 200ms cubic-bezier(.2,.7,.2,1)` | same | parity |
| Item gap | `5px` | `3px` | wrong |
| Icon box | `22px`, svg `20px` | `20px` | near |
| Idle colour | `#9189A7` | same | parity |
| Active | white + weight 600, no background | same | parity |
| Logo row | `padding 4px 10px 22px`, gap `10px` | `2px 10px 22px`, gap 11px | near |
| Wordmark | Playfair 500, `20px` | `21px` | near |
| Settings position | in `.s-nav-foot`, **outside** the indicator track, active `rgba(124,77,255,.18)` | inside the main list | wrong |

### Composer

| Property | Legacy | v2 as built | Verdict |
|---|---|---|---|
| Position | `fixed; left:232px; right:0` | `left:sidebar; right:rail` | wrong |
| **Max width** | **`1544px`, centred** | `780px` | **wrong** |
| Padding | `12px 28px env(safe-area-inset-bottom,14px)` | `16px 34px 22px` | wrong |
| Backdrop | `linear-gradient(to top, var(--bg) 72%, transparent)` | 3-stop to `#111018` | near |
| Inner background | `#17161F` + `blur(10px)` | `--surface-2`, no blur | wrong |
| Inner border | `1px solid #353046`, purple on focus | none | wrong |
| Inner padding | `8px 8px 8px 12px` | `12px 15px` | wrong |
| Shadow | `--shadow-lift` | `--e2` | near |
| Opacity | full | `.62` | wrong — reads as broken, not pending |

### Page header

| Property | Legacy | v2 as built | Verdict |
|---|---|---|---|
| Structure | `flex`, `align-items:baseline`, gap `14px`, actions `margin-left:auto` | stacked block | wrong |
| Title | Inter 800, `34px`, `-1px`, `#F6F3FF` | `32px`, `-.9px` | near |
| Subtitle | `13px`, `--muted` | `14px`, `--text-2` | near |

### Palette

Legacy `[data-theme="studio"]` and v2 agree on every value checked: canvas
gradient, `--surface #211E2C`, `--surface-2 #2A2536`, `--border #332E43`,
`--text #F4F2FA`, `--text-2 #B5ABC9`, `--muted #766D8B`, `--accent #8A5DFF`,
shadows, and the brand gradient. **The palette was never the problem.**

v2 omitted `--border` as a usable token, which is why bucket counts and empty
drop zones lost their outlines.

---

## Not ported, with reasons

| Legacy element | Decision |
|---|---|
| Week summary strip (`.week-sum`, `.day-card`) | Depends on Calendar. Deferred with its system. |
| `.tip-card` (AI plan-of-day) | Depends on AI. Deferred. |
| Habit rail cards | Depends on Habits. Deferred. |
| Theme switcher (`apricot` light theme) | v2 is dark-only by decision. Retired, not deferred. |
| Profile switcher | Retired by the one-workspace decision. |

---

## Conclusion

The palette, the task row, the motion tokens and the bucket grid were already
faithful. **The regression is almost entirely layout geometry** — one missing
nested grid, one missing gutter, one missing max-width — plus a composer that
was made small and translucent enough to read as broken.

Correcting the geometry is not a redesign. It is restoring numbers that already
existed in the approved product.
