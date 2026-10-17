"""Serve repository documentation only, on loopback. No writes or account access."""
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path

DOCS = Path(__file__).resolve().parent.parent / 'docs'

class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(DOCS), **kwargs)

    def parse_request(self):
        if not super().parse_request():
            return False
        # Binding loopback alone does not reject a foreign hostname resolving to loopback.
        port = self.server.server_address[1]
        hosts = {f'127.0.0.1:{port}', f'localhost:{port}'}
        origins = {f'http://{host}' for host in hosts}
        supplied_hosts = self.headers.get_all('Host', [])
        supplied_origins = self.headers.get_all('Origin', [])
        if (len(supplied_hosts) != 1 or supplied_hosts[0] not in hosts
                or len(supplied_origins) > 1
                or (supplied_origins and supplied_origins[0] not in origins)):
            self.send_error(403, 'Local documentation requests only')
            return False
        return True

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        super().end_headers()

if __name__ == '__main__':
    print('Roadmap: http://127.0.0.1:47834/roadmap/', flush=True)
    ThreadingHTTPServer(('127.0.0.1', 47834), Handler).serve_forever()
