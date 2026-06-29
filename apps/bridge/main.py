"""Robot Bridge · DJI RoboMaster S1.

A standalone service, fully decoupled from the backend. The web client (not the
backend) forwards the JSON it received from the API to `POST /execute` here.

Fire-and-forget: /execute validates, returns 202 immediately, and runs the
sequence in a background task. Use /stop for an independent E-STOP.
"""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from typing import Optional

from fastapi import BackgroundTasks, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from executor import RobotExecutor

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")

executor = RobotExecutor()


@asynccontextmanager
async def lifespan(app: FastAPI):
    executor.connect()
    try:
        yield
    finally:
        executor.close()


app = FastAPI(title="Robot Bridge · DJI RoboMaster S1", lifespan=lifespan)

# The web client calls this bridge directly from the browser → allow CORS (dev).
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


class Command(BaseModel):
    # `action` is a free string on purpose: vocabulary is shared across platforms,
    # and the executor skips actions this bridge doesn't support (logs, no error).
    action: str
    duration: Optional[float] = Field(default=None, gt=0)  # seconds; omitted for "stop"


class ExecuteRequest(BaseModel):
    commands: list[Command]


@app.post("/execute", status_code=202)
def execute(req: ExecuteRequest, background: BackgroundTasks):
    """Accept a command sequence and run it in the background (fire-and-forget)."""
    if executor.busy:
        raise HTTPException(status_code=409, detail="Robot is busy executing a sequence")
    commands = [c.model_dump() for c in req.commands]
    background.add_task(executor.run, commands)
    return {"status": "accepted", "steps": len(commands)}


@app.post("/stop")
def stop():
    """Independent E-STOP: abort the running sequence and halt the wheels."""
    executor.estop()
    return {"status": "stopped"}


@app.get("/health")
def health():
    return {"status": "ok", "connected": executor.connected, "busy": executor.busy}
