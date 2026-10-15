"""Serve repository documentation only, on loopback. No writes or account access."""
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path

DOCS = Path(__file__).resolve().parent.parent / 'docs'

class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(DOCS), **kwargs)

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        super().end_headers()

if __name__ == '__main__':
    print('Roadmap: http://127.0.0.1:47834/roadmap/', flush=True)
    ThreadingHTTPServer(('127.0.0.1', 47834), Handler).serve_forever()
