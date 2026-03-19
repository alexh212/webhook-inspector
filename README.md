# Webhook Inspector
 
Full-stack developer tool for capturing, inspecting, and replaying webhook requests in real time.
 
## How it works
 
Point any webhook at your generated endpoint. Every incoming request appears in the dashboard instantly via WebSocket — no refresh needed. Inspect the full payload, headers, and metadata, then replay it to any destination or let the retry worker handle failures automatically. Each endpoint gets a signing secret for HMAC-SHA256 verification, matching the pattern used by Stripe and GitHub.
 
## Architecture
 
- **Ingestion** — captures any HTTP method, headers, body, query params, and source IP
- **Real-time broadcasting** — Redis pub/sub pushes each request to WebSocket subscribers instantly
- **Replay engine** — reconstructs and fires stored requests to any destination via httpx
- **Retry worker** — separate background process, Redis sorted set as a time-delayed queue, exponential backoff (5s → 25s → 125s → 625s), max 5 attempts
- **Session isolation** — session ID generated in the browser, scoped at the query layer, no login required
 
## Tech stack
 
FastAPI, Python, PostgreSQL, SQLAlchemy, Alembic, Redis, React, TypeScript, Vite, pytest, GitHub Actions, Render
 
## Live demo
 
https://webhook-inspector-sx1y.onrender.com
 
## Run locally
 
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
npm install && npm run dev
```
 
## Tests
 
```bash
cd backend && pytest tests/ -v
```
 
## Environment variables
 
```
DATABASE_URL=postgresql+asyncpg://localhost/webhookinspector
REDIS_URL=redis://localhost:6379
ALLOWED_ORIGINS=http://localhost:5173,http://localhost:5174
```
