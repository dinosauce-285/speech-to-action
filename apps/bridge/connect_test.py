"""Milestone E1 — minimal connection test for the DJI RoboMaster S1.

Run this BEFORE the FastAPI bridge to confirm the laptop can reach the robot and
move it. It does NOT use the API/LLM — it just connects, nudges forward ~0.5s,
then stops. If this works, the bridge will work.

    BRIDGE_CONN_TYPE=ap python connect_test.py     # direct mode (robot's own Wi-Fi)
    BRIDGE_CONN_TYPE=sta python connect_test.py    # router mode (same Wi-Fi)
"""

import os
import time

from robomaster import robot

CONN_TYPE = os.getenv("BRIDGE_CONN_TYPE", "ap")  # "ap" (direct) is the easiest first try


def main() -> None:
    ep = robot.Robot()
    print(f"Connecting (conn_type={CONN_TYPE}) …")
    ep.initialize(conn_type=CONN_TYPE)

    try:
        version = ep.get_version()
        print(f"✓ Connected. Firmware/SDK version: {version}")

        print("Nudging forward 0.5s …")
        ep.chassis.drive_speed(x=0.3, y=0, z=0)  # 0.3 m/s forward
        time.sleep(0.5)
        ep.chassis.drive_speed(x=0, y=0, z=0)    # stop
        print("✓ Movement command sent. Did the robot move?")
    finally:
        ep.chassis.drive_speed(x=0, y=0, z=0)
        ep.close()
        print("Closed connection.")


if __name__ == "__main__":
    main()
