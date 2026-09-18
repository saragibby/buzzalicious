# W5 — Composer UI

**Depends on:** W3, W4 · **Blocks:** nothing (M3 exit)

**Read first:** [05 — Template engine](../05-template-engine.md), [00 — Vision](../00-product-vision.md)

## Goal

The complete core loop with **no platform API involved**: signup → brand kit → pick
template → fill slots → preview all four platforms → download.

This is what ships to Rise & Shore and TaxDedux for dogfooding while Meta review is pending.

## Scope

### App shell
React Router layout, auth guard, brand switcher, primary navigation:
Create · Calendar · Trends · Insights · Brand settings.

Resolve the design system question ([Q7](../09-open-questions.md)) before building
screens. Recommendation: Tailwind + shadcn/ui.

### Template gallery
- Ranked by category relevance from W4.
- Filter by archetype, kind, and platform.
- Preview rendered with **the user's actual brand kit**, not generic placeholders — this
  is the "not generic templates" promise made visible.
- Leaves room for W8 to add recommendation badges and explanations.

### Composer
- Slot-filling form generated from `slotSchema`: text with live character counts against
  `maxLength`, image slots with upload/pick-from-library and `aspectHint` guidance.
- **Live preview, debounced**, switchable between the four platform ratios.
- AI caption generation from the brand voice guide + slot `aiHint`s, always editable.
- Per-platform caption overrides, with limits driven by `PlatformSpec`.
- A `{{link}}` marker users can place in copy — W7 replaces it at publish time.

### Export
Download a bundle: per-platform renditions plus caption text, ready to paste.

### Empty and error states
Meaningful empty states (no brand kit yet, no templates match). Loud, actionable errors on
render failure — never a silently clipped image.

## Acceptance criteria

- [ ] Full flow works end to end for a new user without touching any platform API
- [ ] Preview updates within ~150ms of typing (debounced)
- [ ] Gallery ordering visibly differs between brands in different categories
- [ ] Character counts match the real per-platform limits
- [ ] Export produces all four renditions plus captions
- [ ] Responsive down to tablet width

## Notes

**This milestone is the product's first real proof.** Time-to-first-post is a success
metric — count the clicks from login to export and cut anything unnecessary.

"Joy is a feature" is an anchoring principle. Put some personality here.
