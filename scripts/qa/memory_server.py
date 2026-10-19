from contextlib import contextmanager
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from functools import partial
from threading import Thread

@contextmanager
def server():
    class Handler(SimpleHTTPRequestHandler):
        def log_message(self, *_):
            pass
    http = ThreadingHTTPServer(('127.0.0.1', 47836), partial(Handler, directory='artifacts/memory19'))
    thread = Thread(target=http.serve_forever, daemon=True)
    thread.start()
    try:
        yield
    finally:
        http.shutdown()
        http.server_close()
        thread.join()
