"""Loopback-only, disposable demo API. Never reads production files, cookies or tokens."""
import json, secrets, time, threading
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from pathlib import Path

sessions = {}
lock = threading.Lock()
ORIGINS = {'https://discord.com', 'https://ptb.discord.com', 'https://canary.discord.com', 'http://127.0.0.1:47833'}

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args): pass  # capability URLs and headers must not enter logs
    def reply(self, status, value):
        data = json.dumps(value, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Cache-Control', 'no-store')
        origin = self.headers.get('Origin')
        if origin in ORIGINS:
            self.send_header('Access-Control-Allow-Origin', origin)
            self.send_header('Vary', 'Origin')
        self.send_header('Access-Control-Allow-Headers', 'Authorization, Content-Type')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Private-Network', 'true')
        self.end_headers(); self.wfile.write(data)
    def do_OPTIONS(self): self.reply(200, {})
    def do_GET(self):
        if self.path == '/':
            data = Path(__file__).with_name('demo-panel.html').read_bytes()
            self.send_response(200); self.send_header('Content-Type', 'text/html; charset=utf-8'); self.send_header('Cache-Control','no-store'); self.end_headers(); self.wfile.write(data); return
        self.handle_api()
    def do_POST(self): self.handle_api()
    def handle_api(self):
        if self.headers.get('Host') != '127.0.0.1:47833': self.reply(403, {}); return
        if self.headers.get('Origin') and self.headers['Origin'] not in ORIGINS: self.reply(403, {}); return
        try:
            length = int(self.headers.get('Content-Length', 0))
            if length > 30000: self.reply(413, {}); return
            body = json.loads(self.rfile.read(length) or b'{}')
        except (ValueError, json.JSONDecodeError): self.reply(400, {}); return
        with lock:
            if self.path == '/requests' and self.command == 'POST':
                sid, device, panel = (secrets.token_urlsafe(24) for _ in range(3))
                sessions[sid] = dict(device=device, panel=panel, phase='pending', expires=time.time()+600, revision=1, text='Здравствуйте! Спасибо за обращение.\n\nОпишите, пожалуйста, что произошло и какие действия привели к ошибке. Приложите скриншот или короткое видео — это поможет нам разобраться.', code=secrets.token_hex(3).upper())
                self.reply(200, dict(id=sid, device=device, url=f'http://127.0.0.1:47833/#{sid}.{panel}', code=sessions[sid]['code'])); return
            parts = self.path.strip('/').split('/')
            if len(parts) != 3 or parts[0] != 'sessions' or parts[1] not in sessions: self.reply(404, {}); return
            session = sessions[parts[1]]; action = parts[2]
            token = self.headers.get('Authorization','').removeprefix('Bearer ')
            role = 'device' if secrets.compare_digest(token,session['device']) else 'panel' if secrets.compare_digest(token,session['panel']) else None
            if not role: self.reply(403, {}); return
            if session['phase']=='pending' and time.time()>session['expires']: session['phase']='expired'
            if action == 'state' and self.command=='GET':
                raw = '## Majestic RP\n### Уточнение проблемы\n'+session['text']+'\n\n## Россия Онлайн\n### Уточнение проблемы\n'+session['text']
                self.reply(200, dict(phase=session['phase'], revision=session['revision'], code=session['code'], text=session['text'] if role=='panel' else '', raw=raw if session['phase']=='ready' else '')); return
            if self.command!='POST': self.reply(405, {}); return
            if action in ('approve','deny') and role=='panel' and session['phase']=='pending': session['phase']='ready' if action=='approve' else 'denied'
            elif action=='publish' and role=='panel' and session['phase']=='ready':
                text = body.get('text')
                if not isinstance(text,str) or not text.strip() or len(text)>20000: self.reply(422, {}); return
                session['text']=text; session['revision']+=1
            elif action=='revoke': session['phase']='revoked'
            else: self.reply(403, {}); return
            self.reply(200, {'ok':True})

if __name__=='__main__':
    print('Demo panel: http://127.0.0.1:47833 (memory only)')
    ThreadingHTTPServer(('127.0.0.1',47833),Handler).serve_forever()
