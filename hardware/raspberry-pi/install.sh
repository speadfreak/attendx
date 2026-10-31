#!/usr/bin/env bash
set -euo pipefail

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run this installer with sudo." >&2
  exit 1
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
id attendx >/dev/null 2>&1 || useradd --system --create-home --home-dir /var/lib/attendx --shell /usr/sbin/nologin attendx
usermod -aG video,render,dialout attendx
install -d -o attendx -g attendx -m 0750 /opt/attendx/pi-agent
install -d -o attendx -g attendx -m 0700 /var/lib/attendx
install -d -o root -g root -m 0750 /etc/attendx
cp "$ROOT_DIR/agent.mjs" "$ROOT_DIR/package.json" /opt/attendx/pi-agent/
chown -R attendx:attendx /opt/attendx/pi-agent

if ! command -v node >/dev/null 2>&1; then
  echo "Install Node.js 22 LTS before continuing." >&2
  exit 1
fi
node -e 'if (Number(process.versions.node.split(".")[0]) < 22) process.exit(1)' || {
  echo "Node.js 22 or newer is required." >&2
  exit 1
}

if ! command -v rpicam-still >/dev/null 2>&1 && ! command -v libcamera-still >/dev/null 2>&1; then
  echo "Install rpicam-apps or libcamera-apps before starting the camera worker." >&2
  exit 1
fi
if ! command -v avahi-daemon >/dev/null 2>&1; then
  echo "Install avahi-daemon before starting the mDNS device discovery service." >&2
  exit 1
fi

hostnamectl set-hostname attendx-pi
systemctl enable --now avahi-daemon

runuser -u attendx -- npm --prefix /opt/attendx/pi-agent install --omit=dev
cp "$ROOT_DIR/attendx-pi-agent.service" /etc/systemd/system/attendx-pi-agent.service

systemctl daemon-reload
systemctl enable attendx-pi-agent
echo "Installed. Add /etc/attendx/agent.env and the paired token before starting the service."
