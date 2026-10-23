from contextlib import contextmanager
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from functools import partial
from threading import Thread

@contextmanager
def server(directory):
    class Handler(SimpleHTTPRequestHandler):
        def log_message(self, *_):
            pass
    http = ThreadingHTTPServer(('127.0.0.1', 0), partial(Handler, directory=str(directory)))
    thread = Thread(target=http.serve_forever, daemon=True)
    thread.start()
    try:
        yield f'http://127.0.0.1:{http.server_port}'
    finally:
        http.shutdown()
        http.server_close()
        thread.join()
