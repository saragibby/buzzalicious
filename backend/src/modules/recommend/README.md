# `modules/recommend/`

**Owner:** W8 · **Status:** in progress

## Responsibility

Turning trends and insights into concrete suggestions: what to post, about what, and
when. The product's actual differentiator.

## Boundaries

- Reads from `modules/trend/` and `modules/insight/` through their public interfaces.
  It does not query their tables directly.
- A recommendation must carry its reasoning. "Post about X on Thursday" with no stated
  basis is unverifiable by the user and unfalsifiable by us.
- AI is used through `modules/ai/` with a named purpose, for explanation and phrasing.
  The ranking itself should be explicable without a model in the loop.
- Recommendations are proposals. Nothing here publishes anything.
