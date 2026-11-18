#!/bin/zsh
# Installs (or reinstalls) the two launchd jobs: daily run 07:30 local, heartbeat 11:00 local.
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
mkdir -p ~/Library/LaunchAgents
for f in com.coldemailkit.account-manager.daily com.coldemailkit.account-manager.heartbeat; do
  cp "$DIR/launchd/$f.plist" ~/Library/LaunchAgents/
  launchctl bootout "gui/$(id -u)/$f" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/$f.plist
  echo "installed $f"
done
launchctl list | grep com.coldemailkit || true
echo "Mac must be awake at 07:30 (System Settings → Energy, or 'sudo pmset repeat wakeorpoweron MTWRFSU 07:25:00')."
