"""Static dev server for the zip map with caching disabled, so edits show up on a plain reload.

Run:  uv run python build/serve.py          (serves the module folder on http://127.0.0.1:8766/web/)
"""
import sys
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8766


class Handler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt, *args):
        if "404" in fmt % args or " 500 " in fmt % args:
            super().log_message(fmt, *args)


if __name__ == "__main__":
    print(f"serving {ROOT} on http://127.0.0.1:{PORT}/web/")
    ThreadingHTTPServer(("127.0.0.1", PORT), partial(Handler, directory=str(ROOT))).serve_forever()
