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

## Getting Started

### Prerequisites
- Node.js >= 18.0.0
- npm >= 9.0.0
- PostgreSQL 14+ (installed and running)

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

3. Set up PostgreSQL database:
```bash
# Create a PostgreSQL database named 'buzzalicious'
# Using psql:
psql -U postgres
CREATE DATABASE buzzalicious;
\q

# Or using createdb:
createdb buzzalicious
```

4. Set up environment variables:
```bash
# Backend
cp backend/.env.example backend/.env

# Edit backend/.env and update DATABASE_URL with your PostgreSQL credentials:
# DATABASE_URL="postgresql://username:password@localhost:5432/buzzalicious?schema=public"

# Frontend
cp frontend/.env.example frontend/.env
```

5. Run database migrations:
```bash
cd backend
npm run prisma:migrate
# Follow the prompts to name your migration (e.g., "init")
```

6. (Optional) Seed the database with sample data:
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

### Backend (http://localhost:3001)
- `GET /api` - Welcome message
- `GET /api/health` - Health check
- `GET /api/users` - Get all users with their posts
- `GET /api/posts` - Get all published posts

### Frontend (http://localhost:3000)
- Frontend automatically proxies `/api` requests to the backend

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