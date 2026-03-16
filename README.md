# Webhook Inspector

Real-time webhook inspection, replay, and delivery monitoring.

## What it does

Point any webhook at your endpoint. Every request is captured instantly and appears in the dashboard via WebSocket — no refresh needed. Click any request to inspect the full payload, headers, and metadata. Replay it to your server, edit the body first, or let the retry worker handle failures automatically.

## Architecture

- **Ingestion** — accepts any HTTP method, captures headers, body, query params, and source IP
- **Real-time broadcasting** — Redis pub/sub publishes each captured request to WebSocket subscribers instantly
- **Replay engine** — reconstructs and fires stored requests to any destination via httpx
- **Retry worker** — separate background process, Redis sorted set as a time-delayed queue, exponential backoff (5s → 25s → 125s → 625s), max 5 attempts
- **Session isolation** — session ID generated in the browser, stored in localStorage, sent as a header on every request — no login required, data is fully scoped per user

## Tech Stack

- FastAPI, Python, async/await
- PostgreSQL + SQLAlchemy + Alembic
- Redis (pub/sub for real-time, sorted sets for retry queue)
- React, TypeScript, Vite
- Deployed on Render

## Live Demo

https://webhook-inspector-sx1y.onrender.com

## Running Locally

```bash
git clone https://github.com/alexh212/webhook-inspector
cd webhook-inspector

# Backend
cd backend
python -m venv venv && source venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
alembic upgrade head
uvicorn main:app --reload

# Worker (separate terminal)
python -m worker

# Frontend (separate terminal)
cd ../frontend
npm install
npm run dev
```

## Environment Variables

```
DATABASE_URL=postgresql+asyncpg://localhost/webhookinspector
REDIS_URL=redis://localhost:6379
ALLOWED_ORIGINS=http://localhost:5173,http://localhost:5174
```

## API

```
POST   /api/endpoints                    Create a new endpoint
GET    /api/endpoints                    List your endpoints
ANY    /hooks/{id}                       Capture a webhook (public, no auth)
GET    /api/endpoints/{id}/requests      List captured requests
GET    /api/requests/{id}                Get full request detail
POST   /api/requests/{id}/replay         Replay a request
GET    /api/requests/{id}/attempts       List delivery attempts
DELETE /api/endpoints/{id}               Delete an endpoint
DELETE /api/requests/{id}                Delete a request
```
