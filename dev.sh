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

# Custom handler: serve editor.html when / is requested (no index.html on disk)
python3 -c "
import http.server, os

class Handler(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
        if self.path == '/' or self.path == '/index.html':
            self.path = '/editor.html'
        super().do_GET()

http.server.HTTPServer(('', $PORT), Handler).serve_forever()
"
