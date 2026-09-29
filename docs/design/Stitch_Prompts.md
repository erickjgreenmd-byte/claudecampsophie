# Stitch prompts for PencilLift

Paste `Stitch_Brief.md` sections 3–4 into Stitch's project context first (or attach the file), then use
these. Stitch generates one screen per prompt, so work down the list. Keep the **house rules** block at
the top of every prompt — Stitch does not reliably carry constraints between generations.

---

## House rules (prepend to EVERY prompt)

```
House rules, apply to every screen:
Palette: navy #17324D text, teal #008D87 primary actions and large text only, darker teal #00706B for
any teal text under 24px, gold #FFB84D highlights only (never text on white), page background #F7F9FB,
secondary text #4A5E72, error #B3261E, success #1E7A46.
Type: Nunito Sans; sizes 12/14/16/20/24/32; weights 400/600/800.
Spacing 4/8/16/24/32/48. Corner radii 6/12/20/pill. Minimum tap target 44dp.
Accessibility: body text on white at 4.5:1 or better. Never signal status by colour alone — always
pair colour with an icon AND text. Layout must survive 200% OS text scaling without clipping.
No ads, no third-party analytics, no social login buttons, no tracking badges.
Use only these names in mock data: Riley, Sam, Jordan, Avery.
```

---

## 1. Master prompt — the design system

```
[house rules]

Design a component library for PencilLift, a homework-help app used by children aged 5 to 13 and by
their parents. Two registers from one brand: a CHILD space that is warm, calm and low-density, and a
PARENT space that is plain, dense and efficient. Show both.

Produce: buttons (primary, secondary, quiet, destructive, disabled), a large child-sized primary button
at 56dp height, text and number inputs with visible labels and error text, a PIN entry, a select, a
toggle, a segmented control, cards, list rows, a table row for the parent portal, tabs, a bottom tab bar
for the child space, a top app bar, a modal, a bottom sheet, a toast, an inline alert in four kinds
(info, success, warning, error), a progress indicator, a skeleton loader, an empty state, an error state
with a way out, a badge, a status pill, an avatar-free child chip showing a first name and age band, and
a points counter in gold.

For every interactive component show: default, hover, focus-visible with a clearly visible ring, pressed,
disabled, and loading. Show light mode and dark mode.
State the exact hex, size and spacing token used for each element.
```

## 2. Child home — the highest-value screen

```
[house rules]

Design the child home screen of PencilLift for a tablet held in portrait, for a child in the 8-10 age
band. One decision per screen; a child must never wonder what to do next.

The screen must be designed in FOUR states, as four frames:
A. Nothing to do right now — calm, not empty-feeling, with one gentle suggestion.
B. Practice is waiting — one obvious large primary action.
C. Results are ready to look at — one obvious large primary action.
D. This device is not connected yet — shows exactly this sentence: "This device isn't connected yet. Ask
   a grown-up for a connect code." and no other action.

Every frame has a persistent way home and a bottom tab bar: Home, Scan, Practice, Results, Rewards.
No text smaller than 16px. The child's first name may appear; nothing else personal.
Do not show a score, a percentage, a streak, or anything that ranks the child against anyone.
```

## 3. Child scan (camera capture)

```
[house rules]

Design the child scan screen for PencilLift: a child photographs up to 10 pages of finished homework on
a tablet.

Frames:
A. Camera ready, 0 pages taken — show what a good photo looks like as a small inline hint, not a modal.
B. 3 of 10 pages taken — thumbnails, retake and delete per page, a clear "Done" action.
C. Sending — reads "Sending page 2 of 3…" with a visible "Stop sending" button.
D. The child has just tapped Stop — the button must IMMEDIATELY show it was heard ("Stopping…") before
   anything finishes; never leave "Sending…" up while a stop is in flight.
E. Too many pages — explains the 10-page limit in child words and offers to send the first 10.
F. Sending failed — calm, blames nothing, offers "Try again" and a way home.

The camera control is the largest target on screen. 44dp minimum everywhere, 56dp for the shutter.
```

## 4. Child results

```
[house rules]

Design the child results screen for PencilLift, age band 8-10: what the child got right and what to try
again, for one worksheet of 8 questions.

Absolute rule: the correct ANSWER is never shown. Feedback is a method hint, an encouragement, or a
rubric label like "Uses complete sentences".

Show per question: the question, what the child wrote, and one of four outcomes — right, try again,
"Let's get a clearer picture" (the photo could not be read), or "Ask a grown-up" (needs a person). Each
outcome needs an icon AND words, not just colour.

Frames: all right; a mix; one unreadable; a written-work question showing rubric labels instead of
right/wrong.
End the screen with something forward-looking that is not a score and not a comparison.
```

## 5. Parent portal — family dashboard (web, dense)

```
[house rules]

Design the parent family dashboard for the PencilLift web portal, 1280px wide. This is the opposite of
the child space: plain, dense, fast to scan. No playful illustration, no bounce.

Contents: up to 4 children as rows with name, age band, status, and what needs attention; a "recent
homework" list with date, subject, and outcome; the practice plan for this week; and a clear entry to
Children, Homework, Learning plan, Privacy, Rewards, Subscription, Support.

Design these states as separate frames:
A. A healthy family, 2 active children.
B. A child in "draft" (created, no paid slot) — the row must say what is needed, and the action must be
   the real one, not a generic "upgrade".
C. A child "archived — history only" — read-only, and it must NOT offer writes.
D. A child whose data deletion is under way — says "Data deletion under way" and offers nothing that
   would be refused.
E. The plan has lapsed — states what still works and what does not.
Include a sign-out control in the top bar.
```

## 6. Parent — PIN unlock and the parental gate

```
[house rules]

Design two related screens for PencilLift on a phone.

A. PARENT UNLOCK: a 4-6 digit PIN entry a parent uses to enter the parent area. Needs: large keypad with
   44dp+ keys, masked entry with a visible digit count, "Forgot PIN?", and a rate-limit state that says
   how long to wait. Never hint at the PIN's value. Include an error state for a wrong PIN.
B. PARENTAL GATE: shown before any outbound link a child could reach. A simple multiplication question
   ("What is 7 × 8?"), a number entry, and after 3 wrong attempts a lockout state that says so plainly.
   It must read as a check, not as a game a child should try to win.
```

## 7. Child practice

```
[house rules]

Design the child practice screen for PencilLift: one question at a time, age band 5-7 and again for
11-13, as two frames, so the age adaptation is visible.

5-7: minimum 20px body text, 3-6 words per instruction, heavy icon use, one very large answer control.
11-13: normal sentences, 16px, and a tone that does NOT read as childish — this band abandons an app
that patronises them.

Both: progress through the set without a countdown timer, a way to skip that does not feel like failure,
a hint that gives method and never the answer, and a persistent way home.
```

## 8. Public marketing home (web)

```
[house rules]

Design the PencilLift public home page, 1280px wide, for a parent who has never heard of it.

Above the fold: the name, the tagline "Turn homework into progress.", one sentence on what it does
(photograph finished homework, get it checked, get practice), and a single primary action.
Then: how it works in three steps; the six subjects (math, reading, spelling & vocabulary, grammar &
writing, science, social studies) as equals; what parents control (privacy, PIN, what the child sees);
pricing stated plainly as $39.99/month for the first child and $9.99 for each additional, up to four;
and footer links to Privacy, Terms, Support, Contact, Account deletion.

Say nothing about test scores, grades improving, or outcomes we cannot evidence. No testimonials, no
logos, no countdown offers.
```

---

## After Stitch: how to bring it back

1. Export to Figma or code and put it in a branch — do not paste generated code over the app.
2. Map every colour, size and radius back to `@pencillift/ui-tokens`. A hex literal in a component is a
   regression; `packages/ui-tokens/src/index.test.ts` pins the contrast ratios.
3. **Keep the strings.** Implement new visuals against the existing copy, then run
   `pnpm --filter @pencillift/web run test` and `pnpm --filter @pencillift/mobile run test`. The copy and
   state tests are the ones that will object, and they are usually right: they encode which states exist
   and what each is allowed to promise.
4. Where a redesign genuinely needs different words, change the shared constants in
   `packages/contracts/src/` so the portal and the app stay identical, and update the test that names the
   old string. Never change one surface only — that divergence was 7 of round 7's 60 findings.
5. Re-run `node scripts/brand/export-assets.mjs --check` if any brand asset changes.
