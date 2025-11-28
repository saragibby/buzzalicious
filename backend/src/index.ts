import express, { Application, Request, Response } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import session from 'express-session';
import prisma from './db';
import path from 'path';
import passportConfig from './auth';
import { isAuthenticated } from './middleware/auth';

dotenv.config();

const app: Application = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:3000',
  credentials: true,
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Session configuration
app.use(
  session({
    secret: process.env.SESSION_SECRET || 'your-secret-key',
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: process.env.NODE_ENV === 'production',
      httpOnly: true,
      sameSite: process.env.NODE_ENV === 'production' ? 'lax' : 'lax',
      maxAge: 24 * 60 * 60 * 1000, // 24 hours
    },
  })
);

// Passport initialization
app.use(passportConfig.initialize());
app.use(passportConfig.session());

// Serve static files from frontend build (production only)
if (process.env.NODE_ENV === 'production') {
  const frontendPath = path.join(__dirname, '../../frontend/dist');
  app.use(express.static(frontendPath));
}

// Routes
app.get('/', (_req: Request, res: Response) => {
  if (process.env.NODE_ENV === 'production') {
    res.sendFile(path.join(__dirname, '../../frontend/dist/index.html'));
  } else {
    res.json({ 
      message: 'Welcome to Buzzalicious API',
      endpoints: {
        health: '/api/health',
        users: '/api/users',
        templates: '/api/templates'
      }
    });
  }
});

app.get('/api/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', message: 'Backend is running' });
});

app.get('/api', (_req: Request, res: Response) => {
  res.json({ message: 'Welcome to Buzzalicious API' });
});

// Auth routes
app.get('/auth/google',
  passportConfig.authenticate('google', { scope: ['profile', 'email'] })
);

app.get('/auth/google/callback',
  passportConfig.authenticate('google', { failureRedirect: '/' }),
  (_req: Request, res: Response) => {
    // Successful authentication
    const redirectUrl = process.env.NODE_ENV === 'production' 
      ? '/' 
      : process.env.FRONTEND_URL || 'http://localhost:3000';
    res.redirect(redirectUrl);
  }
);

app.get('/auth/logout', (req: Request, res: Response) => {
  req.logout((err: any) => {
    if (err) {
      return res.status(500).json({ error: 'Logout failed' });
    }
    return res.json({ message: 'Logged out successfully' });
  });
});

app.get('/auth/me', isAuthenticated, (req: Request, res: Response) => {
  res.json(req.user);
});

// Database endpoints (protected)
app.get('/api/users', isAuthenticated, async (_req: Request, res: Response) => {
  try {
    const users = await prisma.user.findMany({
      include: {
        templates: true,
      },
    });
    res.json(users);
  } catch (error) {
    console.error('Error fetching users:', error);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

app.get('/api/templates', isAuthenticated, async (_req: Request, res: Response) => {
  try {
    const templates = await prisma.template.findMany({
      include: {
        user: true,
      },
      orderBy: {
        createdAt: 'desc',
      },
    });
    res.json(templates);
  } catch (error) {
    console.error('Error fetching templates:', error);
    res.status(500).json({ error: 'Failed to fetch templates' });
  }
});

// Catch-all route for SPA (must be after API routes)
if (process.env.NODE_ENV === 'production') {
  app.get('*', (_req: Request, res: Response) => {
    res.sendFile(path.join(__dirname, '../../frontend/dist/index.html'));
  });
}

// Start server
const server = app.listen(PORT, () => {
  console.log(`🚀 Server is running on http://localhost:${PORT}`);
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM signal received: closing HTTP server');
  server.close(async () => {
    await prisma.$disconnect();
    console.log('HTTP server closed');
  });
});

export default app;
