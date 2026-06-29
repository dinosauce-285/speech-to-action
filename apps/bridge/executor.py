"""Maps abstract JSON commands to DJI RoboMaster S1 chassis movement.

The bridge is intentionally decoupled from the backend: it only knows the
*abstract* command vocabulary (action + duration). Actions it does not support
are skipped + logged, never fatal — so the same JSON can target any platform.

Commands are time-based (`duration` seconds), so we use `chassis.drive_speed()`
(continuous) + an interruptible wait + stop, NOT `chassis.move()` (which needs
precise distance/angle and an encoder).
"""

from __future__ import annotations

import logging
import os
import threading

log = logging.getLogger("bridge.executor")

# --- Tunables (override via env) -------------------------------------------
SPEED = float(os.getenv("BRIDGE_SPEED", "0.5"))           # m/s at 100% speed (fwd/back)
TURN = float(os.getenv("BRIDGE_TURN", "90"))              # deg/s at 100% speed (left/right)
MAX_DURATION = float(os.getenv("BRIDGE_MAX_DURATION", "10"))  # safety cap per step (s)
DEFAULT_SPEED_PCT = float(os.getenv("BRIDGE_DEFAULT_SPEED_PCT", "60"))  # when speed omitted
# Wheel rotations/sec at full speed — used to APPROXIMATE degrees/rotations as
# time, since this bridge is time-based (drive_speed), not encoder-based.
ROT_PER_SEC = float(os.getenv("BRIDGE_ROT_PER_SEC", "1.0"))
CONN_TYPE = os.getenv("BRIDGE_CONN_TYPE", "sta")          # "sta" (router) | "ap" (direct)
DRY_RUN = os.getenv("BRIDGE_DRY_RUN", "0") == "1"         # run without hardware/SDK

# action -> unit (x, y, z) direction; magnitude (SPEED/TURN × speed%) applied later.
# "stop" is handled separately.
UNIT = {
    "forward": (1.0, 0.0, 0.0),
    "backward": (-1.0, 0.0, 0.0),
    "left": (0.0, 0.0, -1.0),    # NOTE: sign of z (turn direction) is firmware-
    "right": (0.0, 0.0, 1.0),    #       dependent — verify on real hardware.
}


def _speed_factor(c: dict) -> float:
    """`speed` 0–100 (%) → 0..1; default when the command omits it."""
    pct = c.get("speed")
    pct = DEFAULT_SPEED_PCT if pct is None else float(pct)
    return max(0.0, min(100.0, pct)) / 100.0


def _seconds(c: dict) -> float:
    """How long to run this step. Mirrors the API contract:
    seconds | degrees | rotations are mutually exclusive; default 1s.
    degrees/rotations are wheel travel → approximated to time (ROT_PER_SEC)
    because this bridge has no encoder."""
    if c.get("seconds") is not None:
        return float(c["seconds"])
    if c.get("duration") is not None:  # legacy/back-compat
        return float(c["duration"])
    rotations = None
    if c.get("rotations") is not None:
        rotations = float(c["rotations"])
    elif c.get("degrees") is not None:
        rotations = float(c["degrees"]) / 360.0
    if rotations is not None and ROT_PER_SEC > 0:
        return rotations / ROT_PER_SEC
    return 1.0  # API default when no measure is given


class RobotExecutor:
    """Owns the single robot connection and serializes command sequences."""

    def __init__(self) -> None:
        self._robot = None
        self._chassis = None
        self._lock = threading.Lock()     # serialize sequences; one robot, one mover
        self._stop = threading.Event()    # set by estop() to abort mid-sequence
        self.connected = False

    @property
    def busy(self) -> bool:
        return self._lock.locked()

    def connect(self) -> None:
        if DRY_RUN:
            log.warning("DRY-RUN: no SDK connection — commands will only be logged")
            self.connected = True
            return
        # Imported lazily so the app can boot in DRY-RUN without the SDK installed.
        from robomaster import robot

        self._robot = robot.Robot()
        self._robot.initialize(conn_type=CONN_TYPE)
        self._chassis = self._robot.chassis
        self.connected = True
        log.info("Connected to RoboMaster S1 (conn_type=%s)", CONN_TYPE)

    def close(self) -> None:
        self._drive(0.0, 0.0, 0.0)
        if self._robot is not None:
            self._robot.close()
        self.connected = False

    def estop(self) -> None:
        """Abort any running sequence and halt the wheels immediately."""
        self._stop.set()
        self._drive(0.0, 0.0, 0.0)
        log.warning("E-STOP triggered")

    def _drive(self, x: float, y: float, z: float) -> None:
        log.info("drive_speed x=%.2f y=%.2f z=%.2f", x, y, z)
        if not DRY_RUN and self._chassis is not None:
            self._chassis.drive_speed(x=x, y=y, z=z)

    def run(self, commands: list[dict]) -> None:
        """Execute a sequence. Serialized: callers should reject if `busy`."""
        with self._lock:
            self._stop.clear()
            try:
                for c in commands:
                    if self._stop.is_set():
                        log.warning("Sequence aborted by E-STOP")
                        break
                    action = c.get("action")
                    if action == "stop":
                        self._drive(0.0, 0.0, 0.0)
                        continue
                    unit = UNIT.get(action)
                    if unit is None:
                        log.warning("Skipping unsupported action: %r", action)
                        continue
                    factor = _speed_factor(c)
                    ux, uy, uz = unit
                    self._drive(ux * SPEED * factor, uy * SPEED * factor, uz * TURN * factor)
                    duration = min(_seconds(c), MAX_DURATION)
                    # Interruptible sleep so E-STOP cuts in within ms, not after the step.
                    self._stop.wait(timeout=duration)
                    self._drive(0.0, 0.0, 0.0)  # stop between steps for safety
            finally:
                self._drive(0.0, 0.0, 0.0)      # always end stopped
