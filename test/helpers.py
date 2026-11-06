"""Shared test helpers: a quiet local web server for the repo and Chrome launch options."""
import functools, http.server, os, threading
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# Software WebGL so the tests also run on machines without a GPU.
CHROME_ARGS = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist']
CHROME = os.environ.get('CHROME') or None  # optional path to a Chrome binary; default = Playwright's Chromium

class _Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a):
        pass

def serve():
    """Serve the repository root on a free local port; returns the base URL."""
    srv = http.server.ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(_Quiet, directory=ROOT))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return f'http://127.0.0.1:{srv.server_port}'
