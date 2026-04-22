#!/bin/bash
# RealPeggle dev server - serves the project locally
# Proxies /api/* requests to the production Vercel deployment (shared Redis backend)
set -e
cd "$(dirname "$0")"

PORT=8080
URL="http://localhost:$PORT"
REMOTE_API="https://al3a.vercel.app"
LAN_IP=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || echo "")

# Auto-kill stale process on PORT (likely a previous dev.sh run)
EXISTING_PID=$(lsof -ti:$PORT 2>/dev/null || true)
if [ -n "$EXISTING_PID" ]; then
  echo "Port $PORT in use by PID(s) $(echo "$EXISTING_PID" | tr '\n' ' ') — killing stale process"
  kill $EXISTING_PID 2>/dev/null || true
  sleep 0.3
fi

echo "RealPeggle Dev Server"
echo "  Local:    $URL"
if [ -n "$LAN_IP" ]; then
  echo "  Network:  http://$LAN_IP:$PORT  (phone — needs macOS firewall to allow python3)"
fi
echo "  API proxy → $REMOTE_API/api/*"
echo "  Press Ctrl+C to stop"
echo ""

# Initial build — synchronous, blocking. Guarantees dist/ exists before serving.
rm -rf dist
echo -n "Building player bundle..."
if ! npx esbuild js/player-bootstrap.js --bundle --format=esm --splitting --outdir=dist 1>/dev/null; then
  echo " FAILED"
  exit 1
fi
echo " ready"

# Watch mode in background for incremental rebuilds.
# --watch=forever: keep watching even when stdin is closed (we run in background → stdin closed)
npx esbuild js/player-bootstrap.js --bundle --format=esm --splitting --outdir=dist --watch=forever 1>/dev/null 2>&1 &
ESBUILD_PID=$!
# EXIT trap fires for clean exit, signals, AND set -e failures — covers all cases
cleanup() {
  if [ -n "$ESBUILD_PID" ]; then
    kill "$ESBUILD_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT
echo ""

# Open Firefox in a new private window after a short delay.
# Calling the app binary is more reliable than `open -a ... --args` when
# Firefox is already running, because macOS can drop launch args for live apps.
open_dev_browser() {
  local firefox_bin=""
  for candidate in \
    "/Applications/Firefox.app/Contents/MacOS/firefox" \
    "$HOME/Applications/Firefox.app/Contents/MacOS/firefox"
  do
    if [ -x "$candidate" ]; then
      firefox_bin="$candidate"
      break
    fi
  done

  if [ -n "$firefox_bin" ]; then
    "$firefox_bin" -private-window "$URL" >/dev/null 2>&1 &
    return
  fi

  if open -Ra "Firefox" 2>/dev/null; then
    open -a "Firefox" --args -private-window "$URL" >/dev/null 2>&1 && return
    open -a "Firefox" "$URL" >/dev/null 2>&1 && return
  fi

  open "$URL"
}

(sleep 0.4 && open_dev_browser) &

# Custom handler: serve editor.html for /, proxy /api/* to Vercel
python3 -c "
import http.server, urllib.request, os, ssl

REMOTE = '$REMOTE_API'

# Allow HTTPS connections (for proxying to Vercel)
ssl_ctx = ssl.create_default_context()

class Handler(http.server.SimpleHTTPRequestHandler):
    # Skip reverse DNS — can hang for seconds on macOS with mDNS
    def address_string(self):
        return self.client_address[0]

    # Disable caching entirely in dev — prevents stale bundle/module loads
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        super().end_headers()

    def do_GET(self):
        if self.path.startswith('/api/'):
            return self._proxy('GET')
        if self.path == '/' or self.path == '/index.html':
            self.path = '/editor.html'
        super().do_GET()

    def do_POST(self):
        if self.path.startswith('/api/'):
            return self._proxy('POST')
        self.send_error(405)

    def do_DELETE(self):
        if self.path.startswith('/api/'):
            return self._proxy('DELETE')
        self.send_error(405)

    def _proxy(self, method):
        url = REMOTE + self.path
        body = None
        headers = {}

        # Forward relevant headers
        for key in ('content-type', 'authorization'):
            val = self.headers.get(key)
            if val:
                headers[key] = val

        if method in ('POST', 'PUT', 'PATCH'):
            length = int(self.headers.get('content-length', 0))
            body = self.rfile.read(length) if length > 0 else None

        try:
            req = urllib.request.Request(url, data=body, headers=headers, method=method)
            with urllib.request.urlopen(req, context=ssl_ctx, timeout=15) as resp:
                resp_body = resp.read()
                self.send_response(resp.status)
                for key, val in resp.getheaders():
                    if key.lower() in ('content-type', 'cache-control'):
                        self.send_header(key, val)
                self.send_header('Access-Control-Allow-Origin', '*')
                self.end_headers()
                self.wfile.write(resp_body)
        except urllib.error.HTTPError as e:
            resp_body = e.read()
            self.send_response(e.code)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(resp_body)
        except Exception as e:
            self.send_response(502)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(b'{\"error\": \"proxy failed\"}')

    def log_message(self, format, *args):
        # Color API proxy requests differently
        msg = format % args
        if '/api/' in msg:
            print(f'  \033[36m{msg}\033[0m')
        else:
            print(f'  {msg}')

http.server.ThreadingHTTPServer(('', $PORT), Handler).serve_forever()
"
