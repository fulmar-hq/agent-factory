#!/bin/sh
set -eu
# Intentionally never called by prepare. Coordinator runs this only after review.
if [ "${1:-}" != '--after-review' ]; then
  echo 'Coordinator: review fixtures, policy isolation and qualification first; then use --after-review.' >&2
  exit 1
fi
factory_dir="${FACTORY_PRIVATE_DIR:-$HOME/.alido-private/factory}"
for factory_job in tick board; do
  plutil -lint "$factory_dir/com.agent-factory.$factory_job.plist"
  launchctl bootstrap "gui/$(id -u)" "$factory_dir/com.agent-factory.$factory_job.plist"
done
printf '%s\n' 'Undo: launchctl bootout gui/UID/com.agent-factory.tick; launchctl bootout gui/UID/com.agent-factory.board. Archive files; do not delete state.'
