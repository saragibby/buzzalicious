# Buzzalicious 🐝

Full-stack TypeScript application with React frontend and Express backend.

## Project Structure

```
buzzalicious/
├── frontend/          # React + TypeScript + Vite
├── backend/           # Node.js + Express + TypeScript
├── package.json       # Root package (workspace manager)
└── README.md
```

## Tech Stack

### Frontend
- **React 18** - UI library
- **TypeScript** - Type safety
- **Vite** - Build tool and dev server
- **ESLint** - Code linting

### Backend
- **Node.js** - Runtime
- **Express** - Web framework
- **TypeScript** - Type safety
- **Nodemon** - Auto-restart during development
- **Prisma** - Database ORM
- **PostgreSQL** - Database
- **OpenAI SDK** - AI text and image generation
- **Google Gemini** - AI text generation

## Getting Started

### Prerequisites
- Node.js >= 18.0.0
- npm >= 9.0.0
- PostgreSQL 14+ (installed and running)
- Google Cloud Console account (for OAuth)

### Installation

1. Clone the repository:
```bash
git clone <repository-url>
cd buzzalicious
```

2. Install dependencies for all workspaces:
```bash
npm install
```

3. **Set up Google OAuth:**
   - Go to [Google Cloud Console](https://console.cloud.google.com/)
   - Create a new project or select existing one
   - Enable Google+ API
   - Go to "Credentials" → "Create Credentials" → "OAuth 2.0 Client ID"
   - Application type: Web application
   - Authorized redirect URIs:
     - `http://localhost:3001/auth/google/callback` (development)
     - `https://your-app.herokuapp.com/auth/google/callback` (production)
   - Save the Client ID and Client Secret

4. Set up PostgreSQL database:
```bash
# Create a PostgreSQL database named 'buzzalicious'
# Using psql:
psql -U postgres
CREATE DATABASE buzzalicious;
\q

# Or using createdb:
createdb buzzalicious
```

5. Set up environment variables:
```bash
# Backend
cp backend/.env.example backend/.env

# Edit backend/.env and update with your values:
# - DATABASE_URL with your PostgreSQL credentials
# - GOOGLE_CLIENT_ID from Google Cloud Console
# - GOOGLE_CLIENT_SECRET from Google Cloud Console
# - SESSION_SECRET (generate a random string)

# Frontend
cp frontend/.env.example frontend/.env
```

6. Run database migrations:
```bash
cd backend
npm run prisma:migrate
# Follow the prompts to name your migration (e.g., "init")
```

7. (Optional) Seed the database with sample data:
```bash
npm run db:seed
```

### Development

Run both frontend and backend concurrently:
```bash
npm run dev
```

Or run them separately:
```bash
# Backend only (runs on http://localhost:3001)
npm run dev:backend

# Frontend only (runs on http://localhost:3000)
npm run dev:frontend
```

### Building for Production

Build both projects:
```bash
npm run build
```

Or build separately:
```bash
npm run build:backend
npm run build:frontend
```

### Running in Production

After building:
```bash
# Start backend
cd backend
npm start

# Serve frontend (use a static file server)
cd frontend
npx serve -s dist
```

## API Endpoints

### Authentication
- `GET /auth/google` - Initiate Google OAuth login
- `GET /auth/google/callback` - Google OAuth callback
- `GET /auth/logout` - Logout current user
- `GET /auth/me` - Get current user info (protected)

### Backend API (http://localhost:3001)
- `GET /api` - Welcome message
- `GET /api/health` - Health check
- `GET /api/users` - Get all users with their templates (protected)
- `GET /api/templates` - Get all published templates (protected)

### Frontend (http://localhost:3000)
- Frontend automatically proxies `/api` and `/auth` requests to the backend

## Authentication Flow

1. User clicks "Sign in with Google" button
2. Redirected to Google for authentication
3. After successful authentication, redirected back to app
4. User session is created and stored
5. Protected routes now accessible

## Deployment to Heroku

### Initial Setup
```bash
# Create Heroku app
heroku create your-app-name

# Add PostgreSQL
heroku addons:create heroku-postgresql:essential-0

# Set environment variables
heroku config:set NODE_ENV=production
heroku config:set SESSION_SECRET=your-random-secret
heroku config:set GOOGLE_CLIENT_ID=your-google-client-id
heroku config:set GOOGLE_CLIENT_SECRET=your-google-client-secret
heroku config:set GOOGLE_CALLBACK_URL=https://your-app.herokuapp.com/auth/google/callback
```

### Deploy
```bash
git push heroku main

# Run migrations
heroku run npm run prisma:migrate --workspace=backend
```

### Update Google OAuth
Add Heroku callback URL to Google Cloud Console:
- `https://your-app.herokuapp.com/auth/google/callback`

## Database Management

### Prisma Commands (run from `/backend` directory)

**Create a new migration after schema changes:**
```bash
npm run prisma:migrate
# This creates a new migration file and applies it to the database
```

**Generate Prisma Client (after schema changes):**
```bash
npm run prisma:generate
```

**Open Prisma Studio (database GUI):**
```bash
npm run prisma:studio
# Opens at http://localhost:5555
```

**Push schema changes without creating migration (dev only):**
```bash
npm run db:push
```

**Seed the database:**
```bash
npm run db:seed
```

### Making Schema Changes

1. Edit `backend/prisma/schema.prisma`
2. Run migration: `npm run prisma:migrate`
3. Name your migration (e.g., "add_user_profile")
4. The migration is applied and Prisma Client is regenerated

**Example - Adding a new field:**
```prisma
model User {
  id        String   @id @default(uuid())
  email     String   @unique
  name      String?
  bio       String?  // New field
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
}
```

Then run: `npm run prisma:migrate`

## Development Workflow

1. The frontend development server runs on port 3000
2. The backend API server runs on port 3001
3. Vite's proxy configuration forwards `/api/*` requests from frontend to backend
4. Both servers support hot-reloading during development

## Project Features

- ✅ Monorepo structure with npm workspaces
- ✅ Full TypeScript support (frontend & backend)
- ✅ Hot module reloading
- ✅ ESLint configuration
- ✅ Type checking scripts
- ✅ Production build setup
- ✅ CORS enabled for cross-origin requests
- ✅ Environment variable support