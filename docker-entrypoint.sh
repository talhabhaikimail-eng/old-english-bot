#!/bin/sh

# Start python bypasser API in the background if it exists
if [ "$MODE" != "discord" ] && [ -f "/app/src/scripts/cf_bypasser.py" ]; then
  echo "🚀 Starting Python Bypasser API on port 8000..."
  python3 /app/src/scripts/cf_bypasser.py > /tmp/bypasser.log 2>&1 &
fi

# Execute the CMD passed to docker (e.g. npm start)
exec "$@"
