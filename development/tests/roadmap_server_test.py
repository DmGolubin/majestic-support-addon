"""Exercise the HTTP request gate without starting a listener or reading docs."""
import importlib.util
import io
from pathlib import Path
from types import SimpleNamespace
import unittest

spec = importlib.util.spec_from_file_location('roadmap_server', Path(__file__).parents[1] / 'scripts/roadmap-server.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class RequestGate(unittest.TestCase):
    def request(self, headers, method='GET'):
        handler = object.__new__(module.Handler)
        handler.server = SimpleNamespace(server_address=('127.0.0.1', 47834))
        handler.raw_requestline = f'{method} /roadmap/data.json HTTP/1.1\r\n'.encode()
        handler.rfile = io.BytesIO((headers + '\r\n\r\n').encode())
        errors = []
        handler.send_error = lambda code, *args: errors.append(code)
        return handler.parse_request(), errors

    def test_local_navigation(self):
        self.assertEqual(self.request('Host: 127.0.0.1:47834'), (True, []))
        self.assertEqual(self.request('Host: localhost:47834\r\nOrigin: http://localhost:47834', 'HEAD'), (True, []))

    def test_foreign_and_ambiguous_authorities(self):
        for headers in ['Host: foreign.example:47834',
                        'Host: 127.0.0.1:47834\r\nOrigin: https://foreign.example',
                        'Host: 127.0.0.1:47834\r\nOrigin: null',
                        'Host: 127.0.0.1:47834\r\nHost: foreign.example',
                        'Host: 127.0.0.1:47834\r\nOrigin: http://localhost:47834\r\nOrigin: https://foreign.example',
                        'Host: 127.0.0.1:47833', '']:
            with self.subTest(headers=headers):
                self.assertEqual(self.request(headers), (False, [403]))


if __name__ == '__main__':
    unittest.main()
