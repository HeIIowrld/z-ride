"""Replay demo coordinates on the Pleos AVD via private ADB and Virtual Console."""
import copy, json, math, subprocess, threading, time, uuid
from urllib.request import Request, urlopen

ADB='/opt/android-sdk/platform-tools/adb'
APP='ai.zride.demo.car'

class EmulatorLocationError(RuntimeError):
    pass

START={'latitude':37.5285,'longitude':126.9180}
ROUTES={
 'A':{'name':'여의도 동쪽 스팟 (데모)', 'geometry':[START,{'latitude':37.5285,'longitude':126.9250},{'latitude':37.5320,'longitude':126.9250},{'latitude':37.5320,'longitude':126.9320}]},
 'B':{'name':'여의도 서쪽 스팟 (데모)', 'geometry':[START,{'latitude':37.5240,'longitude':126.9180},{'latitude':37.5240,'longitude':126.9100},{'latitude':37.5290,'longitude':126.9100}]},
 'C':{'name':'짧은 보급품 시연', 'geometry':[{'latitude':37.5389,'longitude':126.9418},{'latitude':37.5399,'longitude':126.943}]}
}
RATES=(1,2,5,10)
MAX_SEGMENT_M=19500


def point(value):
    if not isinstance(value,dict) or set(value)!={'latitude','longitude'}:
        raise ValueError('INVALID_PARAMETERS')
    for key,limit in [('latitude',90),('longitude',180)]:
        n=value[key]
        if type(n) not in (int,float) or not -limit<=n<=limit:
            raise ValueError('INVALID_PARAMETERS')
    return dict(value)

def distance(a,b):
    y=math.radians((a['latitude']+b['latitude'])/2)
    return math.hypot((b['latitude']-a['latitude'])*111195,(b['longitude']-a['longitude'])*111195*math.cos(y))

def at_distance(points,travelled):
    for a,b in zip(points,points[1:]):
        length=distance(a,b)
        if travelled<length and length:
            f=travelled/length
            return {k:a[k]+(b[k]-a[k])*f for k in ['latitude','longitude']},False
        travelled-=length
    return dict(points[-1]),True

class Simulator:
    def __init__(self):
        self.locks={i:threading.RLock() for i in range(1,4)}
        self.mock_gps=set()
        self.states={i:{'source':'DEMO_ROUTE','state':'IDLE','revision':0,'position':dict(START),'speedKph':0,'rate':5,'geometry':[],'distanceM':0,'routeStatus':'NONE','error':None} for i in range(1,4)}
    def adb(self,i,*args,input_data=None):
        r=subprocess.run([ADB,'-s',f'emulator-{5552+i*2}',*args],input=input_data,capture_output=True,timeout=8)
        if r.returncode and not (args[:3]==('emu','geo','fix') and b'unknown command' in r.stdout.lower()):
            raise RuntimeError('EMULATOR_UNAVAILABLE')
        return r.stdout.decode().strip()
    def private(self,i,*args,input_data=None):
        user=self.adb(i,'shell','am','get-current-user')
        if not user.isdigit():raise RuntimeError('ANDROID_USER_UNAVAILABLE')
        return self.adb(i,'shell','run-as',APP,'--user',user,*args,input_data=input_data)
    def console(self,i,path,method='GET'):
        self.adb(i,'forward',f'tcp:{8080+i}','tcp:8088')
        # The official simulator requires a live browser-session lease for writes.
        with urlopen(Request(f'http://127.0.0.1:{8080+i}/browser/session?client=zride-journey-{i}',method='POST'),timeout=5) as r:r.read()
        with urlopen(Request(f'http://127.0.0.1:{8080+i}'+path,method=method),timeout=5) as r:return json.load(r)
    def motion(self,i,speed,gear):
        self.console(i,'/vehicle/controls?speed=0&accelerator=0&brake=100&steering=0','PUT')
        self.console(i,'/vehicle/gear?gear='+gear,'PUT')
        self.console(i,f'/vehicle/controls?speed={speed}&accelerator=0&brake=0&steering=0','PUT')
    def geo(self,i,p,speed):
        if i not in self.mock_gps:
            response=self.adb(i,'emu','geo','fix',str(p['longitude']),str(p['latitude']),'0','8',str(round(speed/1.852,3)))
            if response.splitlines() and response.splitlines()[-1]=='OK':
                return
            if 'unknown command' not in response.lower():
                raise EmulatorLocationError('EMULATOR_LOCATION_REJECTED')
            self.adb(i,'shell','cmd','appops','set','2000','android:mock_location','allow')
            self.mock_gps.add(i)
            try:
                self.adb(i,'shell','cmd','location','providers','add-test-provider','gps','--requiresSatellite')
                self.adb(i,'shell','cmd','location','providers','set-test-provider-enabled','gps','true')
            except Exception:
                self.clear_geo(i)
                raise
        try:
            self.adb(i,'shell','cmd','location','providers','set-test-provider-location','gps',
                     '--location',f"{p['latitude']},{p['longitude']}",'--accuracy','5')
        except RuntimeError as exc:
            self.clear_geo(i)
            raise EmulatorLocationError('EMULATOR_LOCATION_REJECTED') from exc
    def clear_geo(self,i):
        if i not in self.mock_gps:return
        try:self.adb(i,'shell','cmd','location','providers','remove-test-provider','gps')
        finally:
            try:self.adb(i,'shell','cmd','appops','set','2000','android:mock_location','default')
            finally:self.mock_gps.discard(i)
    def submit(self,i,s,geometry,source='DEMO_ROUTE'):
        # The reference APK refreshes this diagnostic file on every snapshot.
        # A read during truncation is transient, not an invalid browser command.
        for attempt in range(5):
            try:
                room=json.loads(self.private(i,'cat','files/room-state.json'))
                if not isinstance(room,dict) or not room.get('roomId'):raise ValueError()
                break
            except ValueError:
                if attempt==4:raise RuntimeError('VEHICLE_SNAPSHOT_UNAVAILABLE')
                time.sleep(.05)
        command=str(uuid.uuid4())
        body={'commandId':command,'roomId':room['roomId'],'source':source,'geometry':geometry}
        self.private(i,'tee','files/demo-route.tmp',input_data=json.dumps(body).encode())
        self.private(i,'mv','files/demo-route.tmp','files/demo-route.json')
        s.update(commandId=command,routeStatus='PENDING',roomId=room['roomId'],submittedAt=time.monotonic())
    def receipt(self,i,s):
        if s['routeStatus']!='PENDING':return
        try:r=json.loads(self.private(i,'cat','files/demo-route-result.json'))
        except Exception:r={}
        if r.get('commandId')==s.get('commandId'):
            if r.get('error'):raise RuntimeError('ROUTE_SUBMIT_FAILED')
            s.update(routeStatus='APPLIED',serverRouteRevision=r['route']['routeRevision'])
        elif time.monotonic()-s['submittedAt']>25:raise RuntimeError('VEHICLE_ROUTE_BRIDGE_TIMEOUT')
    def snapshot(self,i):
        with self.locks[i]:
            s=copy.deepcopy(self.states[i])
            for k in ['commandId','submittedAt','lastTick','roomId']:s.pop(k,None)
            s['progressM']=round(s.pop('travelled',0));s['distanceM']=round(s['distanceM'])
            return s
    def act(self,i,body):
        if not isinstance(body,dict) or set(body)-{'action','route','speedKph','rate','expectedRevision','start','end','progress'}:raise ValueError('INVALID_COMMAND')
        action=body.get('action')
        if action not in ['destination','reroute','start','pause','park','cancel','seek']:raise ValueError('INVALID_ACTION')
        route=body.get('route','A');speed=body.get('speedKph',30);rate=body.get('rate',5)
        if not isinstance(route,str) or route not in (*ROUTES,'custom') or type(speed) not in (int,float) or not 1<=speed<=60 or type(rate) is not int or rate not in RATES:raise ValueError('INVALID_PARAMETERS')
        if action in ('destination','reroute') and route=='custom':
            points=[point(body.get('start')),point(body.get('end'))]
        else:
            points=copy.deepcopy(ROUTES.get(route,ROUTES['A'])['geometry'])
        progress=body.get('progress')
        if action=='seek' and (type(progress) not in (int,float) or not 0<=progress<=1):
            raise ValueError('INVALID_PARAMETERS')
        with self.locks[i]:
            s=self.states[i]
            if type(body.get('expectedRevision')) is not int or body['expectedRevision']!=s['revision']:raise ValueError('REVISION_CONFLICT')
            if action in ('destination','reroute'):
                if action=='reroute':
                    if not s['geometry']:raise ValueError('DESTINATION_REQUIRED')
                    points[0]=dict(s['position'])
                lengths=[distance(a,b) for a,b in zip(points,points[1:])]
                length=sum(lengths)
                if length<1 or max(lengths)>MAX_SEGMENT_M:raise ValueError('INVALID_ROUTE_LENGTH')
            if action in ('start','seek'):
                self.receipt(i,s)
                if not s['geometry'] or s['routeStatus']!='APPLIED':raise ValueError('ROUTE_NOT_APPLIED')
                if action=='start' and s.get('travelled',0)>=s['distanceM']:raise ValueError('ROUTE_FINISHED')
            # Read a real emulator response before changing local demo state.
            self.console(i,'/vehicle/state')
            if action in ['destination','reroute']:
                self.submit(i,s,points)
                if action=='destination':
                    self.motion(i,0,'Park')
                    self.geo(i,points[0],0)
                    s.update(position=dict(points[0]),state='READY',speedKph=0)
                s.update(route=route,destination=ROUTES[route]['name'] if route in ROUTES else '직접 설정한 도착점',
                         geometry=points,travelled=0,distanceM=length,rate=rate)
            elif action=='start':
                if s['state']!='MOVING' or s['speedKph']!=speed:self.motion(i,speed,'Drive')
                s.update(state='MOVING',speedKph=speed,rate=rate,lastTick=time.monotonic())
            elif action=='seek':
                travelled=s['distanceM']*progress
                position,_=at_distance(s['geometry'],travelled)
                self.motion(i,0,'Park')
                self.geo(i,position,0)
                s.update(position=position,travelled=travelled,state='ARRIVED' if progress==1 else 'PARKED',speedKph=0)
            elif action in ['park','pause','cancel']:
                self.motion(i,0,'Park' if action!='pause' else 'Drive')
                if action!='cancel' and s['geometry']:self.geo(i,s['position'],0)
                s.update(state={'park':'PARKED','pause':'PAUSED','cancel':'CANCELLED'}[action],speedKph=0)
                if action=='cancel':
                    self.clear_geo(i)
                    self.submit(i,s,[],'NONE')
                    s.update(geometry=[],distanceM=0,travelled=0,destination=None)
            s['revision']+=1;s['error']=None
            return self.snapshot(i)
    def tick(self,i,now):
        with self.locks[i]:
            s=self.states[i]
            if s['state'] in ['IDLE','ERROR']:return
            try:
                self.receipt(i,s)
                if s['state'] not in ['MOVING','PAUSED']:return
                observed=self.console(i,'/vehicle/state')
                actual=observed.get('gear',{}).get('actual',{}).get('value')
                if actual and actual!='Drive':
                    s.update(state='PARKED' if actual=='Park' else 'PAUSED',speedKph=0);s['revision']+=1
                    return
                if s['state']=='PAUSED':return
                elapsed=min(3,max(0,now-s.get('lastTick',now)));s['lastTick']=now
                if s['routeStatus']!='APPLIED':return
                travelled=s.get('travelled',0)+s['speedKph']/3.6*elapsed*s['rate']
                point,arrived=at_distance(s['geometry'],travelled)
                self.geo(i,point,s['speedKph'])
                s.update(position=point,travelled=travelled)
                if arrived:
                    self.motion(i,0,'Park');self.geo(i,point,0);s.update(state='ARRIVED',speedKph=0,travelled=s['distanceM']);s['revision']+=1
            except Exception as exc:
                error=str(exc) if isinstance(exc,EmulatorLocationError) else 'EMULATOR_OR_ROUTE_UNAVAILABLE'
                s.update(state='ERROR',speedKph=0,error=error);s['revision']+=1
                try:self.motion(i,0,'Park')
                except Exception:pass
                try:self.clear_geo(i)
                except Exception:pass
    def run(self):
        while True:
            for i in range(1,4):self.tick(i,time.monotonic())
            time.sleep(1)

    def shutdown(self):
        for i,s in self.states.items():
            with self.locks[i]:
                if s['state'] in ('MOVING','PAUSED'):
                    try:self.motion(i,0,'Park')
                    except Exception:pass
                try:self.clear_geo(i)
                except Exception:pass

simulator=Simulator()
