# `modules/template/`

**Owner:** W4 · **Status:** scaffold

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
