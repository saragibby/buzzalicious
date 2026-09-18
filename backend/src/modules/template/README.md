# `modules/template/`

**Owner:** W4 · **Status:** implemented

## Responsibility

Post templates: the layout, the slots a user fills, and the rules for which slots are
required. A template plus brand styling plus slot values is what `modules/render/` turns
into an image.

## Boundaries

- Templates describe *structure*. Colour and typeface come from the brand at render time,
  so one template works for every brand rather than being duplicated per client.
- No rendering here. This module produces a validated description; `modules/render/`
  executes it.
- Slot validation belongs here and must run before a render is queued. Failing at render
  time means failing inside a job, where the user is not watching.

## What is here

- `template.schemas.ts` — the Zod contract for `layout` and `slotSchema` (authored by W2).
- `relevance.ts` — industry-relevance ranking.

## Ranking

`rankTemplates` scores a template against the brand's leaf category **and its ancestors**,
discounting each level of remove by a constant factor, so a template tagged directly for
`coffee-shop` outranks one inherited from `food-and-drink`. A template tagged at several
levels keeps its **best** match rather than the sum — summing would reward broad tagging
over accurate tagging. Category archetype priors add a smaller bonus on top.

`matchedCategoryId` and `inherited` exist so the UI can explain a ranking ("popular in
your industry") rather than presenting an unexplained order. A template scored only by an
archetype prior is **not** marked inherited: there is no category to point at, and the
label would be a guess.

No category yet is not an error — it returns every matching template in a stable order,
which is the correct answer for a workspace that has not told us what it does.

## Not every template supports every ratio

`supportedRatios` is load-bearing and is filtered on by the ranking query. Three seeded
templates cannot fit their own `maxLength` at 16:9 and declare portrait and story only;
see [docs/05](../../../../docs/05-template-engine.md#not-every-template-supports-every-ratio).
