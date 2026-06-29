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
SPEED = float(os.getenv("BRIDGE_SPEED", "0.5"))           # m/s, forward/backward
TURN = float(os.getenv("BRIDGE_TURN", "45"))              # deg/s, left/right
MAX_DURATION = float(os.getenv("BRIDGE_MAX_DURATION", "10"))  # safety cap per step (s)
CONN_TYPE = os.getenv("BRIDGE_CONN_TYPE", "sta")          # "sta" (router) | "ap" (direct)
DRY_RUN = os.getenv("BRIDGE_DRY_RUN", "0") == "1"         # run without hardware/SDK

# action -> (x, y, z) for chassis.drive_speed. "stop" is handled separately.
VECTORS = {
    "forward": (SPEED, 0.0, 0.0),
    "backward": (-SPEED, 0.0, 0.0),
    "left": (0.0, 0.0, -TURN),   # NOTE: sign of z (turn direction) is firmware-
    "right": (0.0, 0.0, TURN),   #       dependent — verify on real hardware.
}


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
                    vec = VECTORS.get(action)
                    if vec is None:
                        log.warning("Skipping unsupported action: %r", action)
                        continue
                    duration = min(float(c.get("duration") or 0.0), MAX_DURATION)
                    self._drive(*vec)
                    # Interruptible sleep so E-STOP cuts in within ms, not after the step.
                    self._stop.wait(timeout=duration)
                    self._drive(0.0, 0.0, 0.0)  # stop between steps for safety
            finally:
                self._drive(0.0, 0.0, 0.0)      # always end stopped
