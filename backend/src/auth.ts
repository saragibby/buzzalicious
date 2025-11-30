import passport from 'passport';
import { Strategy as GoogleStrategy } from 'passport-google-oauth20';
import prisma from './db';

passport.use(
  new GoogleStrategy(
    {
      clientID: process.env.GOOGLE_CLIENT_ID!,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
      callbackURL: process.env.GOOGLE_CALLBACK_URL || '/auth/google/callback',
    },
    async (_accessToken, _refreshToken, profile, done) => {
      try {
        const email = profile.emails?.[0]?.value;
        
        // Whitelist check - add your allowed emails or domains here
        const allowedEmails = process.env.ALLOWED_EMAILS?.split(',').map(e => e.trim()) || [];
        const allowedDomains = process.env.ALLOWED_DOMAINS?.split(',').map(d => d.trim()) || [];
        
        // If whitelist is configured, enforce it
        if (allowedEmails.length > 0 || allowedDomains.length > 0) {
          const isEmailAllowed = email && allowedEmails.includes(email);
          const isDomainAllowed = email && allowedDomains.some(domain => email.endsWith(`@${domain}`));
          
          if (!isEmailAllowed && !isDomainAllowed) {
            console.log(`Access denied for email: ${email}`);
            return done(null, false, { message: 'Access denied. Your email is not whitelisted.' });
          }
        }
        
        // Check if user exists
        let user = await prisma.user.findUnique({
          where: { googleId: profile.id },
        });

        if (!user) {
          // Check if user with this email already exists
          user = await prisma.user.findUnique({
            where: { email: email },
          });

          if (user) {
            // Update existing user with Google ID
            user = await prisma.user.update({
              where: { id: user.id },
              data: {
                googleId: profile.id,
                picture: profile.photos?.[0]?.value,
                name: profile.displayName || user.name,
              },
            });
          } else {
            // Create new user
            user = await prisma.user.create({
              data: {
                googleId: profile.id,
                email: email || '',
                name: profile.displayName,
                picture: profile.photos?.[0]?.value,
              },
            });
          }
        }

        return done(null, user);
      } catch (error) {
        return done(error as Error);
      }
    }
  )
);

passport.serializeUser((user: any, done) => {
  done(null, user.id);
});

passport.deserializeUser(async (id: string, done) => {
  try {
    const user = await prisma.user.findUnique({ where: { id } });
    done(null, user);
  } catch (error) {
    done(error);
  }
});

export default passport;
