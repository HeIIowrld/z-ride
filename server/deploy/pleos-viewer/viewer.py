#!/usr/bin/env python3
"""Interactive screen catalog for fixed Pleos AVDs. Pointer/keyboard control uses VNC; no arbitrary command endpoint."""
import json, re, subprocess, threading, time
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from pathlib import Path
from urllib.parse import urlsplit, unquote
from simulation import simulator
import native_navigation

ROOT=Path(__file__).resolve().parent
NOVNC=Path('/usr/share/novnc').resolve()
ADB='/opt/android-sdk/platform-tools/adb'
APP='ai.zride.demo.car'
cache={'at':0,'value':None}
lock=threading.Lock()

def command(args,timeout=2):
    try:
        r=subprocess.run(args,capture_output=True,text=True,timeout=timeout)
        return r.stdout.strip() if r.returncode==0 else ''
    except (OSError,subprocess.TimeoutExpired):return ''

def catalog():
    with lock:
        if time.monotonic()-cache['at']<3 and cache['value'] is not None:return cache['value']
        vehicles=[]
        for i in range(1,4):
            active=command(['systemctl','is-active',f'pleos-vehicle@{i}.service'])=='active'
            serial=f'emulator-{5552+i*2}'
            boot=active and command([ADB,'-s',serial,'shell','getprop','sys.boot_completed'])=='1'
            row={'id':str(i),'name':f'Pleos 차량 {i}','state':'RUNNING' if boot else 'BOOTING' if active else 'STOPPED','viewerPath':f'/vehicles/{i}','source':'ACTUAL_PLEOS_AVD','viewOnly':False,'roomConnected':False}
            if boot:
                user=command([ADB,'-s',serial,'shell','am','get-current-user'])
                if not user.isdigit():user='0'
                prefix=[ADB,'-s',serial,'shell','run-as',APP,'--user',user]
                raw=command(prefix+['cat','files/room-state.json'])
                stamp=command(prefix+['stat','-c','%Y','files/room-state.json'])
                try:
                    room=json.loads(raw);fresh=stamp.isdigit() and 0<=time.time()-int(stamp)<10
                    if fresh and re.fullmatch(r'[a-f0-9-]{36}',str(room.get('roomId',''))):
                        row.update(roomId=room['roomId'],roomConnected=True,roomState=room.get('state'),participants=len(room.get('members',[])),snapshotAt=int(stamp)*1000)
                        v=room.get('vehicle',{});row['gear']=v.get('gear','UNKNOWN');row['ux']=v.get('ux','UNKNOWN')
                except (ValueError,TypeError):pass
            vehicles.append(row)
        value={'vehicles':vehicles,'updatedAt':int(time.time()*1000),'note':'실제 Pleos 화면 웹 조작 가능. 중지된 차량은 화면을 만들지 않음.'}
        cache.update(at=time.monotonic(),value=value)
        return value

class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        path=unquote(urlsplit(self.path).path)
        match=re.fullmatch(r'/simulation/([123])',path)
        if match:return self.send_body(json.dumps(simulator.snapshot(int(match[1])),ensure_ascii=False).encode(),'application/json; charset=utf-8')
        match=re.fullmatch(r'/navigation/([123])',path)
        if match:return self.send_body(json.dumps(native_navigation.status(int(match[1]))).encode(),'application/json')
        if path=='/status.json':return self.send_body(json.dumps(catalog(),ensure_ascii=False).encode(),'application/json; charset=utf-8')
        if path in ['/','/index.html']:file=ROOT/'index.html'
        elif re.fullmatch(r'/[123]/?',path):file=ROOT/'viewer.html'
        elif path in ['/app.js','/viewer.js','/simulation.js','/native-navigation.js','/style.css']:file=ROOT/path[1:]
        elif path.startswith('/novnc/'):
            file=(NOVNC/path[len('/novnc/'):]).resolve()
            if not file.is_relative_to(NOVNC) or file.suffix not in ['.js','.css','.svg','.png','.woff','.woff2']:return self.send_error(404)
        else:return self.send_error(404)
        if not file.is_file():return self.send_error(404)
        types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png'}
        self.send_body(file.read_bytes(),types.get(file.suffix,'application/octet-stream'))
    def do_POST(self):
        match=re.fullmatch(r'/(simulation|navigation)/([123])',urlsplit(self.path).path)
        if not match:return self.send_error(404)
        if self.headers.get('Origin')!='https://hyundai.hjpark.net':return self.send_error(403)
        try:
            size=int(self.headers.get('Content-Length','0'))
            if not 0<size<=1024 or self.headers.get_content_type()!='application/json':return self.send_error(400)
            body=json.loads(self.rfile.read(size));value=native_navigation.execute(int(match[2]),body) if match[1]=='navigation' else simulator.act(int(match[2]),body)
            self.send_body(json.dumps(value,ensure_ascii=False).encode(),'application/json; charset=utf-8')
        except (ValueError,TypeError) as e:
            self.send_body(json.dumps({'error':str(e) if isinstance(e,ValueError) and str(e) in ['REVISION_CONFLICT','INVALID_ACTION','INVALID_PARAMETERS','INVALID_COMMAND','DESTINATION_REQUIRED','ROUTE_NOT_APPLIED'] else 'INVALID_COMMAND'}).encode(),'application/json',409)
        except Exception:
            self.send_body(b'{"error":"EMULATOR_UNAVAILABLE"}','application/json',503)
    def send_body(self,body,kind,status=200):
        self.send_response(status)
        for name,value in {'Content-Type':kind,'Content-Length':str(len(body)),'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' wss://hyundai.hjpark.net; frame-ancestors 'self'; base-uri 'none'; form-action 'none'"}.items():self.send_header(name,value)
        self.end_headers();self.wfile.write(body)
    def log_message(self,*args):pass

if __name__=='__main__':
    threading.Thread(target=simulator.run,daemon=True).start()
    ThreadingHTTPServer(('0.0.0.0',8090),Handler).serve_forever()
