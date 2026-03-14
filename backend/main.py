from fastapi import FastAPI
app = FastAPI(title="WebhookInspector")

@app.get("/health")
async def health():
    return {"status": "ok"}
