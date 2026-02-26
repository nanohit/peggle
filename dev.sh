#!/bin/bash
# RealPeggle dev server - serves the project locally
set -e
cd "$(dirname "$0")"

PORT=8080
URL="http://localhost:$PORT"

echo "RealPeggle Dev Server"
echo "Serving at $URL"
echo "Press Ctrl+C to stop"
echo ""

# Open browser after a short delay
(sleep 0.8 && open "$URL") &

python3 -m http.server $PORT
