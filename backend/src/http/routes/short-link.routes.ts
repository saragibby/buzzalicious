import { Router, type Request, type Response } from 'express';
import { shortLinkLimiter } from '../../platform/rate-limit';
import { recordClick } from '../../modules/link/click.service';
import { isValidSlug } from '../../modules/link/slug';
import { assertSafeDestination, resolveSlug } from '../../modules/link/shortlink.service';
import { getLogger } from '../../platform/logger';

/**
 * The public redirector: `GET /s/:slug`.
 *
 * This is the only route in the application with no session, no tenant and no
 * authentication — it is reached by strangers clicking a link in a published post. Every
 * decision below follows from that.
 *
 * ## 302, never 301
 *
 * A 301 is *permanent* and browsers cache it aggressively and durably. After the first
 * click, every subsequent click from that browser would go straight to the destination
 * without ever reaching us, and the click would simply not exist. The failure is silent
 * and invisible at the moment it happens: the user still lands correctly, the numbers
 * merely become quietly wrong, and it would surface months later as traffic that
 * "mysteriously" decayed. `Cache-Control: no-store` says the same thing to anything that
 * ignores the status code.
 *
 * ## Why this is not under /api
 *
 * The URL goes in a caption and is read by humans. `/s/aB3xK9p` is about as short as a
 * first-party link gets, and length is not cosmetic here — on X it consumes caption
 * budget, which is why `shortLinkLength()` is what the caption gate measures.
 */
export function createShortLinkRouter(): Router {
  const router = Router();

  router.get('/:slug', shortLinkLimiter, handleRedirect);

  // A HEAD is almost always a link-preview fetcher. It gets the same redirect — refusing
  // would make previews fail and change how posts look in feeds — but it is recorded as
  // a bot by `classifyClick`, which is exactly the distinction that matters.
  router.head('/:slug', shortLinkLimiter, handleRedirect);

  return router;
}

async function handleRedirect(req: Request, res: Response): Promise<void> {
  const { slug } = req.params;

  // Reject malformed slugs before touching the database. This is a public, unauthenticated
  // endpoint, so it is also the cheapest place to refuse a scan.
  if (!slug || !isValidSlug(slug)) {
    res.status(404).type('text/plain').send('Link not found.');
    return;
  }

  const link = await resolveSlug(slug);

  if (!link) {
    res.status(404).type('text/plain').send('Link not found.');
    return;
  }

  // 410 rather than 404: the distinction is the entire point of having `expiresAt`. It
  // tells a visitor the link was real and is over, rather than implying they mistyped it.
  if (link.expiresAt && link.expiresAt.getTime() <= Date.now()) {
    res.status(410).type('text/plain').send('This link has expired.');
    return;
  }

  // Validated again at read time, not only at write time. A row written before
  // `assertSafeDestination` existed, or by a future code path that forgets to call it,
  // would otherwise turn our own domain into an open redirect. The check is microseconds
  // and the failure it prevents is a security bug, so it is worth repeating.
  try {
    assertSafeDestination(link.destinationUrl);
  } catch {
    getLogger().error(
      { shortLinkId: link.id },
      'Refusing to redirect: stored destination is not a safe http(s) URL.',
    );
    res.status(404).type('text/plain').send('Link not found.');
    return;
  }

  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  res.setHeader('Referrer-Policy', 'no-referrer-when-downgrade');
  res.redirect(302, link.destinationUrl);

  // After the response. The visitor is already on their way; see `click.service.ts` for
  // why this neither blocks nor throws.
  await recordClick(link, {
    method: req.method,
    ip: req.ip,
    headers: req.headers,
  });
}
