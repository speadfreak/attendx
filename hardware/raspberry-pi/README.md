# AttendX Raspberry Pi agent

The agent advertises through Avahi as `attendx-pi.local`, sends a health heartbeat every 10 seconds, polls only the documented job API, captures three short frames per batch, and sends face descriptors—not images—to `/api/attendance/bulk-match`. Captured JPEGs are temporary files and are deleted immediately. While disconnected, descriptor batches and job results are held in a local SQLite outbox with a 48-hour expiry and a 256-item cap.

## Pair and install

1. Use Raspberry Pi OS 64-bit, set the hostname to `attendx-pi`, enable Avahi/mDNS, and confirm the camera works with `rpicam-still --list-cameras`.
2. Install Node.js 22 LTS, `rpicam-apps`, `avahi-daemon`, and the build libraries required by `canvas` (`libcairo2-dev`, `libpango1.0-dev`, `libjpeg-dev`, `libgif-dev`, and `librsvg2-dev`).
3. From this directory run `sudo ./install.sh`.
4. In AttendX, pair a device from Operations. Copy the one-time token immediately into `/var/lib/attendx/pi-token`, owned by `attendx:attendx` with mode `0600`. Do not put the token in source control or shell history.
5. Create `/etc/attendx/agent.env` with `ATTENDX_API_BASE=https://YOUR-APP-HOST/api`. Optionally set `ATTENDX_ARDUINO_PORT=/dev/ttyACM0` and `ATTENDX_CLASSROOM_ID=1`. Protect the file with `root:root` and mode `0600`.
6. Start with `sudo systemctl start attendx-pi-agent` and inspect `sudo journalctl -u attendx-pi-agent -f`.

The app/API must be reachable from the Pi. The rotating token is stored only in the root-owned device data directory and replaced atomically after each accepted heartbeat. If it expires after an extended outage, pair the device again in AttendX and replace the token file.

## Fixed operations

The Pi worker accepts only `worker-status`, `restart-worker`, `camera-status`, and `recent-logs` for maintenance. It uses fixed argument arrays and never evaluates shell input. Fan jobs use the Arduino serial protocol described in `../arduino/README.md`.

## Manual checks

- `hostname -I` and `avahi-resolve-host-name attendx-pi.local` show the Pi's local address.
- The Operations page changes from offline to connected within 30 seconds and shows uptime, CPU temperature, queue depth, and the last heartbeat.
- Pair again and verify a new heartbeat updates the token file without restarting the agent.
- Disconnect the network briefly, confirm the local outbox grows, then reconnect and confirm it drains.
- Use each fixed maintenance action and verify the job result in the dashboard.
- Point the camera at two enrolled faces in consecutive frames; confirm one attendance commit per student/day and no raw images in server requests or storage.
- In a staging database, lower the confidence threshold only for testing uncertain matches; verify pending reviews, approval/rejection audit entries, and retention cleanup.

No Raspberry Pi or camera was available in the development workspace, so these hardware steps are instructions, not claims of hardware validation.
