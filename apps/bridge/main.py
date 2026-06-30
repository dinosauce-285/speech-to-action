"""Robot Bridge · MQTT → ESP32.

A standalone service, fully decoupled from the backend. The web client (not the
backend) forwards the JSON it received from the API to `POST /execute` here, and
this bridge republishes it onto an MQTT topic that an ESP32 robot subscribes to.

Fire-and-forget: /execute validates, publishes, and returns 202. /stop publishes
an independent E-STOP. The ESP32 owns the actual motor timing/sequencing.
"""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from typing import Optional

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from publisher import CommandPublisher

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")

publisher = CommandPublisher()


@asynccontextmanager
async def lifespan(app: FastAPI):
    publisher.connect()
    try:
        yield
    finally:
        publisher.close()


app = FastAPI(title="Robot Bridge · MQTT → ESP32", lifespan=lifespan)

# The web client calls this bridge directly from the browser → allow CORS (dev).
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


class Command(BaseModel):
    # `action` is a free string on purpose: the vocabulary is shared across
    # platforms; the ESP32 decides what it supports.
    action: str
    speed: Optional[float] = None                          # 0–100 (%)
    seconds: Optional[float] = Field(default=None, gt=0)   # one "how much" measure…
    degrees: Optional[float] = Field(default=None, gt=0)   # …wheel travel (approximated)
    rotations: Optional[float] = Field(default=None, gt=0)
    duration: Optional[float] = Field(default=None, gt=0)  # legacy/back-compat


class ExecuteRequest(BaseModel):
    commands: list[Command]


@app.post("/execute", status_code=202)
def execute(req: ExecuteRequest):
    """Accept a command sequence and publish it to MQTT (fire-and-forget)."""
    commands = [c.model_dump() for c in req.commands]
    publisher.run(commands)
    return {"status": "accepted", "steps": len(commands)}


@app.post("/stop")
def stop():
    """Independent E-STOP: publish a stop message for the robot to halt."""
    publisher.estop()
    return {"status": "stopped"}


@app.get("/health")
def health():
    return {"status": "ok", "connected": publisher.connected, "busy": publisher.busy}
