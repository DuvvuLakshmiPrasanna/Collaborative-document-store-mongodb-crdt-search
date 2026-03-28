# Collaborative Document Store with MongoDB, OCC, and Full-Text Search

Production-ready collaborative wiki backend built for high-concurrency editing, schema evolution, search, and analytics.

## Highlights

- Conflict-safe collaborative updates using optimistic concurrency control (OCC)
- Full-text search with relevance scoring and tag-based filtering
- Aggregation analytics for most-edited documents and tag co-occurrence
- Lazy on-read schema migration + background batch migration script
- Dockerized runtime with MongoDB health checks and persistent volume
- Reproducible automated validation:
  - Contract suite (`39/39` passed)
  - Master end-to-end suite (`20/20` passed)

## Tech Stack

- Node.js 20+
- Express.js
- MongoDB 7
- Docker + Docker Compose

## System Architecture

```text
Client / Frontend
      |
      | HTTP (REST)
      v
Express API Service
  - CRUD
  - OCC updates
  - Search
  - Analytics
  - Lazy schema transform
      |
      | MongoDB Driver
      v
MongoDB (documents collection)
  - unique slug index
  - text index on title + content
  - embedded capped revision history

Background Script
  scripts/migrate_author_schema.js
  - scans old schema docs in batches
  - bulkWrite migration
```

## Data Model (`documents`)

```json
{
  "_id": "ObjectId",
  "slug": "unique-url-slug",
  "title": "Document title",
  "content": "Markdown or text",
  "version": 12,
  "tags": ["mongodb", "guide"],
  "metadata": {
    "author": {
      "id": "user-123",
      "name": "Jane Doe",
      "email": "jane@example.com"
    },
    "createdAt": "ISODate",
    "updatedAt": "ISODate",
    "wordCount": 450
  },
  "revision_history": [
    {
      "version": 12,
      "updatedAt": "ISODate",
      "authorId": "user-123",
      "contentDiff": "Edited title and content."
    }
  ]
}
```

## API Endpoints

### Health

- `GET /health`

### Documents

- `POST /api/documents`
- `GET /api/documents/:slug`
- `PUT /api/documents/:slug` (OCC: requires `version`)
- `DELETE /api/documents/:slug`

### Search

- `GET /api/search?q=<term>`
- `GET /api/search?q=<term>&tags=tag1,tag2`

### Analytics

- `GET /api/analytics/most-edited`
- `GET /api/analytics/tag-cooccurrence`

## Core Behavior Guarantees

- OCC update is atomic and conflict-safe
  - success: `200`, increments `version`
  - stale write: `409`, returns latest document
- `revision_history` is capped to last 20 entries
- Search returns `score` (`textScore`) sorted by relevance
- Search with tags requires all tags (`$all`)
- Legacy author schema (`metadata.author: string`) is transformed on read

## Environment Variables

Defined in `.env.example`:

- `PORT`
- `MONGO_URI`
- `DATABASE_NAME`
- `SEED_COUNT`
- `SEED_BATCH_SIZE`
- `MIGRATION_BATCH_SIZE`

## Run with Docker (Recommended)

### 1. Start stack

```bash
docker compose up -d --build
```

### 2. API base URL

```text
http://localhost:3100
```

### 3. Verify health

```bash
curl http://localhost:3100/health
```

### 4. View logs

```bash
docker compose logs -f
```

### 5. Stop stack

```bash
docker compose down
```

## Local Run (Without Docker)

```bash
npm install
npm start
```

Use a running MongoDB instance and set `MONGO_URI` and `DATABASE_NAME`.

## Deploy to Render + MongoDB Atlas (Fastest Path)

This project is ready to deploy as a Docker web service on Render.

### 1. Set up MongoDB Atlas

1. Create a free cluster.
2. Create a database user.
3. In Network Access, allow `0.0.0.0/0` for development/testing.
4. Copy your connection string and replace `<username>`, `<password>`, and `<cluster>`.

Example:

```bash
mongodb+srv://username:password@cluster.mongodb.net/
```

### 2. Push repository to GitHub

```bash
git add .
git commit -m "deploy: render + atlas ready"
git push origin main
```

### 3. Deploy on Render

Option A (UI):

1. Render -> New -> Web Service
2. Connect this GitHub repository
3. Use:

- Environment: `Docker`
- Branch: `main`
- Root Directory: leave empty

4. Add environment variables:

```env
MONGO_URI=mongodb+srv://username:password@cluster.mongodb.net/
DATABASE_NAME=documesh
PORT=3000
SEED_COUNT=10000
SEED_BATCH_SIZE=1000
MIGRATION_BATCH_SIZE=1000
```

Option B (Blueprint):

Use `render.yaml` in this repository and set the secret `MONGO_URI` when prompted.

### 4. Verify deployment

Open:

```bash
https://<your-service>.onrender.com/health
```

Expected response:

```json
{ "ok": true }
```

## Seeding Strategy

On startup, the API:

1. Creates indexes (unique slug + text index)
2. Seeds documents only when collection is empty
3. Uses `data/wikipedia_stub.xml` as lightweight source input
4. Intentionally seeds old author schema on a subset for migration testing

## Migration Script

Run background author schema migration:

```bash
node scripts/migrate_author_schema.js
```

What it does:

- Finds docs with `metadata.author` as string
- Migrates in batches (default 1000)
- Uses `bulkWrite` for performance and reduced DB overhead

## Validation and Testing

### Contract Suite

```bash
npm run validate:contracts
```

### Master End-to-End Suite

```bash
npm run test:master
```

Both suites can be pointed to custom environments:

```bash
API_BASE_URL=http://localhost:3100 MONGO_URI=mongodb://localhost:27017 DATABASE_NAME=collab_docs npm run validate:contracts
API_BASE_URL=http://localhost:3100 MONGO_URI=mongodb://localhost:27017 DATABASE_NAME=collab_docs npm run test:master
```

## CI Pipeline

GitHub Actions workflow is included at `.github/workflows/ci.yml`.

CI steps:

1. Install dependencies
2. Build and run Docker stack
3. Wait for health endpoint
4. Run contract validator
5. Run master end-to-end suite

## Repository Structure

```text
.
|- src/
|  |- config.js
|  |- db.js
|  |- seed.js
|  |- server.js
|  |- utils.js
|- scripts/
|  |- migrate_author_schema.js
|  |- validate_contracts.js
|  |- master_test_suite.js
|- data/
|  |- wikipedia_stub.xml
|- .github/workflows/ci.yml
|- docker-compose.yml
|- Dockerfile
|- .env.example
|- README.md
```

## Git and GitHub Workflow (Recommended)

Initialize and connect to remote:

```bash
git init
git branch -M main
git remote add origin https://github.com/DuvvuLakshmiPrasanna/Collaborative-document-store-mongodb-crdt-search.git
```

Commit in meaningful slices:

```bash
git add .gitignore package.json scripts/master_test_suite.js
git commit -m "test: add reusable master end-to-end validation suite"

git add .github/workflows/ci.yml
git commit -m "ci: add dockerized validation workflow for contracts and e2e suite"

git add README.md docker-compose.yml src/server.js
git commit -m "docs: upgrade README and finalize production runtime defaults"
```

Push to GitHub:

```bash
git push -u origin main
```

## Submission Checklist

- `docker-compose.yml` present in repo root
- `Dockerfile` present in repo root
- `.env.example` present and complete
- `scripts/migrate_author_schema.js` present
- API up and healthy on `http://localhost:3100/health`
- Seeded documents count >= 1000
- OCC, search, analytics, migration behavior verified
- Contract tests passing
- Master suite passing

## Interview-Ready One-Liner

"Built a Dockerized collaborative document backend on MongoDB with optimistic concurrency control, full-text search, aggregation analytics, schema evolution strategy, and reproducible automated validation."
