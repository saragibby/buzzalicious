# Heroku process types.
#
# web     The API, which also serves the built SPA. One deployable (ADR-0001).
# worker  Background jobs. A separate dyno so scheduling is not duplicated per web
#         dyno — the prototype ran a setInterval scheduler inside the web process,
#         which published the same post once per dyno. pg-boss arrives in W6; until
#         then this process boots, idles and shuts down cleanly.
# release Runs before the new release goes live. Inert until W2 lands 0001_init:
#         prisma/migrations/ is intentionally empty after the teardown, so
#         `migrate deploy` currently has nothing to apply and exits successfully.

web: npm start
worker: npm run start:worker
release: npm run db:deploy
