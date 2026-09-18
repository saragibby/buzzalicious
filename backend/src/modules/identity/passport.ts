import passport from 'passport';
import { Strategy as GoogleStrategy } from 'passport-google-oauth20';
import { getConfig } from '../../platform/config';
import { getLogger } from '../../platform/logger';
import { AuthError } from '../../platform/errors';
import { findOrCreateGoogleUser, findUserById, isSignInAllowed } from './identity.service';

/**
 * Google OAuth via Passport, wired from validated config.
 *
 * Differences from the prototype, all of them deliberate:
 *  - The callback URL is derived once in `config.ts`, not recomputed per file.
 *  - No `console.log` of profile data or denied email addresses.
 *  - The session holds the user id only; the user is loaded per request.
 */
export function configurePassport(): typeof passport {
  const config = getConfig();
  const logger = getLogger().child({ component: 'auth' });

  passport.use(
    new GoogleStrategy(
      {
        clientID: config.google.clientId,
        clientSecret: config.google.clientSecret,
        callbackURL: config.google.callbackUrl,
      },
      (_accessToken, _refreshToken, profile, done) => {
        void (async () => {
          try {
            const email = profile.emails?.[0]?.value;

            if (!email) {
              // Google can omit email if the scope was not granted. Without it there is
              // no stable identity to link to, so fail rather than create a ghost user.
              done(new AuthError('Google did not return an email address'));
              return;
            }

            if (!isSignInAllowed(email)) {
              logger.warn({ googleId: profile.id }, 'Sign-in denied by allow list');
              done(null, false, { message: 'Access denied.' });
              return;
            }

            const { user } = await findOrCreateGoogleUser({
              googleId: profile.id,
              email,
              name: profile.displayName,
              picture: profile.photos?.[0]?.value,
            });

            done(null, user);
          } catch (error) {
            done(error as Error);
          }
        })();
      },
    ),
  );

  passport.serializeUser((user, done) => {
    done(null, (user as { id: string }).id);
  });

  passport.deserializeUser((id: string, done) => {
    void (async () => {
      try {
        done(null, (await findUserById(id)) ?? false);
      } catch (error) {
        done(error);
      }
    })();
  });

  return passport;
}
