# PencilLift — design brief for Stitch (stitch.withgoogle.com)

What to paste or upload into Stitch, and the rules a redesign has to keep. Written 2026-09-29 against
code `0d8fdf4`. Token values here are the real ones from `packages/ui-tokens/src/index.ts`; the screen
list is the real one from `apps/web/src/routes.tsx` and `apps/mobile/app/`.

**The single most important line in this document:** the words on these screens are load-bearing. Seven
adversarial hardening rounds have gone into making them true — what a surface offers matches what the
server accepts, an archived or deletion-pending child is described accurately, and a failure says why in
terms a parent can act on. **Redesign the visuals; keep the strings.** Where a string must change,
change it in `packages/contracts/src/*.ts` (the shared copy constants) so the portal and the app say the
same thing, and expect the copy tests to tell you if you broke a promise.

## 1. What the product is

PencilLift turns a photo of a child's finished homework into checked work plus practice. A parent
photographs or the child scans a worksheet; the app extracts the questions, grades them, and gives the
child feedback that never contains the answer. Parents plan practice; children do it.

- **Price**: $39.99/month for the first child, $9.99 for each additional, 1–4 paid children.
- **Subjects** (exactly six, none may be dropped or merged): math, reading, spelling & vocabulary,
  grammar & writing, science, social studies.
- **Age bands** (exactly three, they drive reading level and layout): `5-7`, `8-10`, `11-13`.

## 2. TWO briefs, not one

This is the main thing to get right. The two surfaces have opposite goals and must not converge.

| | **Child space** (tablet/phone, `apps/mobile/app/(child)/`) | **Parent portal** (web + the parent side of the app) |
|---|---|---|
| Who | A 5–13 year old, often tired, doing homework | A parent at 9pm with four minutes |
| Goal | Never be confused, never be stuck, never be blamed | See what happened and act, fast |
| Density | Low. One decision per screen | High. Tables, filters, batch actions |
| Words | Short, concrete, second person, no jargon | Precise, including the uncomfortable parts |
| Tone | Warm, calm, encouraging — never babyish to an 11–13 year old | Plain and professional. Not playful |
| Motion | Gentle, skippable, never blocking | Minimal |
| Failure | "Let's get a clearer picture" + a way forward | The actual reason and the actual next step |

**Do not make the parent portal playful to match the child space.** A parent reading a safety notice or a
refund does not want rounded bounce. Shared brand, different register.

## 3. Non-negotiables a redesign must keep

These are product and legal constraints, not preferences. A design that breaks one cannot ship.

1. **No dead ends in the child space.** Every child screen has a way home, including its error state.
   A render error shows calm words and a route out, never a closed app.
2. **Answers are never shown to the child.** Feedback is method hints, encouragement and rubric labels.
   The parent-only solution stays parent-only, on every surface.
3. **The parent area is behind a gate.** Password plus a server-verified PIN. Entering parent mode needs
   fresh proof; the parent area closes when the app is backgrounded. Children type no personal
   information anywhere.
4. **Outbound links behind a parental gate** wherever they sit before the PIN (sign-in links, "Open
   Settings", the PIN-reset link): a random multiplication challenge with a 3-miss lockout.
5. **Accessibility is a floor, not a goal.** Minimum touch target **44dp**. Body text on white must reach
   WCAG AA 4.5:1 — that is why there are two teals (see tokens). Status is never colour alone: pair it
   with an icon and text. Support OS text scaling without clipping.
6. **Honest states.** Draft, active, archived, deletion-pending, plan-lapsed and closed are different
   states with different copy, and a screen must not offer an action the server will refuse.
7. **No third-party analytics, ads or tracking SDKs** (Apple Kids Category). No social login.
8. **Synthetic names only** in any mock data you produce: Riley, Sam, Jordan, Avery.

## 4. Design tokens (use these exact values)

```
navy      #17324D   body text, headings
teal      #008D87   primary actions, large text and UI only (3:1 on white)
tealText  #00706B   small teal text (4.5:1 on white) — use this for any text under 24px
gold      #FFB84D   rewards, highlights, never for text on white
white     #FFFFFF
offWhite  #F7F9FB   page background
muted     #4A5E72   secondary text
danger    #B3261E   errors
success   #1E7A46   success
```

- **Type**: Nunito Sans (SIL OFL 1.1), falling back to `ui-rounded, system-ui`.
  Scale 12 / 14 / 16 / 20 / 24 / 32. Weights 400 / 600 / 800.
- **Spacing**: 4 / 8 / 16 / 24 / 32 / 48.
- **Radii**: 6 / 12 / 20 / 999 (pill).
- **Min touch target**: 44dp.
- **Name**: PencilLift ("Pencil Lift" spoken). Tagline: *Turn homework into progress.*

## 5. Screens to redesign, in priority order

Prioritised by how often a real family meets them and how much confusion currently costs.

### Child space (highest value — this is where "kid friendly" means something)
1. **`(child)/home`** — the child's landing. Today it must handle: device not yet connected, nothing to
   do, practice waiting, results ready. Four states, one screen.
2. **`(child)/scan`** — camera capture of up to 10 pages. Needs: page count, retake, a calm
   "Sending page N of M", and an immediate acknowledgement when the child taps Stop.
3. **`(child)/results`** — what was right, what to try again. Never the answer. Unresolved work says
   "Let's get a clearer picture" or asks for a grown-up.
4. **`(child)/practice`** — one question at a time.
5. **`(child)/rewards`** — points and what they unlock. Gold lives here.
6. **`(child)/review`**, **`(child)/help`**.

### Parent, in the app
7. **`(parent)/home`**, **`children`**, **`planner`**, **`plan`** (purchase), **`pair-device`**,
   **`unlock`** (PIN), **`privacy`**, **`rewards`**, **`support`**, **`devices`**, **`school`**.

### Parent portal (web)
8. **`/app`** (family dashboard), **`/app/homework`**, **`/app/learning`** (planner: subjects, schedule,
   study material, practice sets, test dates), **`/app/children`**, **`/app/privacy`**,
   **`/app/subscription`**, **`/app/support`**, **`/app/rewards`**, **`/app/security`**,
   **`/app/guardians`**, **`/app/devices`**, **`/app/school`**.
9. **Public**: `/`, `/how-it-works`, `/pricing`, `/support`, `/privacy`, `/terms`, `/account-deletion`,
   `/contact`, `/sign-in`, `/sign-up`.
10. **Admin** (owner only, lowest priority, keep it dense and dull): `/admin` and its pages.

## 6. Age-band adaptation

One design, three readings. Do not build three apps.

| | `5-7` | `8-10` | `11-13` |
|---|---|---|---|
| Body text | 20px min | 16–18px | 16px |
| Words per screen | Very few; icon + 3–6 words | Short sentences | Normal sentences |
| Reading level | Pre/early reader — lean on icons and colour+shape | Grade 2–4 | Grade 5–7 |
| Tone | Playful is fine | Friendly | **Not childish** — respect matters most here |

The `11-13` band is where a too-cute design does real damage: a 12-year-old who feels patronised stops
using it.

## 7. What NOT to change

- The six subjects, the three age bands, the prices, the 1–4 paid children.
- Any string that states what the product will or will not do. If a redesign needs different wording,
  say so explicitly in your output so it can be changed in the shared copy constants and re-tested.
- The gate structure: password → PIN → parent area; parental gate before outbound links.
- Anything that would require a tracking or analytics SDK.
