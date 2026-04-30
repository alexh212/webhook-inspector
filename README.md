# Relay
 
Full-stack developer tool for capturing, inspecting, and replaying webhook requests in real time.
 
## Architecture

Relay captures incoming webhook requests and stores their method, headers, body, and metadata in PostgreSQL.
The API publishes each capture to Redis so connected WebSocket clients receive events in real time without polling.
Saved requests can be replayed to external destinations, and failed or 5xx deliveries are queued in Redis for retry with exponential backoff.
A separate worker process drains that retry queue and records every delivery attempt for later inspection.
Session IDs scope endpoint and request access at the query layer, so each browser session only sees its own data.
See `backend/ARCHITECTURE.md` for the backend flow diagram.
 
## Tech stack
 
FastAPI, Python, PostgreSQL, SQLAlchemy, Alembic, Redis, React, TypeScript, Vite, pytest, GitHub Actions, Render
 
## Live demo
 
https://webhook-inspector-sx1y.onrender.com
 
## Run locally
 
```bash
git clone https://github.com/alexh212/webhook-inspector
cd webhookinspector
 
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
# backend (.env)
DATABASE_URL=postgresql+asyncpg://localhost/webhookinspector
REDIS_URL=redis://localhost:6379
ALLOWED_ORIGINS=http://localhost:5173,http://localhost:5174
DEBUG=false                          # optional, enables SQLAlchemy query logging

# frontend (.env)
VITE_API_URL=http://localhost:8000   # optional, defaults to localhost:8000
```
