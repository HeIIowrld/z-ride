"""Fixed demo journeys; private ADB + official Pleos Virtual Console only.

No supplied shell, URL, file path, credentials or real phone coordinates are accepted.
"""
import copy, json, math, subprocess, threading, time, uuid
from urllib.request import Request, urlopen

ADB='/opt/android-sdk/platform-tools/adb'
APP='ai.zride.demo.car'
START={'latitude':37.5285,'longitude':126.9180}
ROUTES={
 'A':{'name':'여의도 동쪽 스팟 (데모)', 'geometry':[START,{'latitude':37.5285,'longitude':126.9250},{'latitude':37.5320,'longitude':126.9250},{'latitude':37.5320,'longitude':126.9320}]},
 'B':{'name':'여의도 서쪽 스팟 (데모)', 'geometry':[START,{'latitude':37.5240,'longitude':126.9180},{'latitude':37.5240,'longitude':126.9100},{'latitude':37.5290,'longitude':126.9100}]}
}

def distance(a,b):
    y=math.radians((a['latitude']+b['latitude'])/2)
    return math.hypot((b['latitude']-a['latitude'])*111195,(b['longitude']-a['longitude'])*111195*math.cos(y))

def at_distance(points,travelled):
    for a,b in zip(points,points[1:]):
        length=distance(a,b)
        if travelled<=length and length:
            f=travelled/length
            return {k:a[k]+(b[k]-a[k])*f for k in ['latitude','longitude']},False
        travelled-=length
    return dict(points[-1]),True

class Simulator:
    def __init__(self):
        self.locks={i:threading.RLock() for i in range(1,4)}
        self.states={i:{'source':'DEMO_ROUTE','state':'IDLE','revision':0,'position':dict(START),'speedKph':0,'rate':5,'geometry':[],'distanceM':0,'routeStatus':'NONE','error':None} for i in range(1,4)}
    def adb(self,i,*args,input_data=None):
        r=subprocess.run([ADB,'-s',f'emulator-{5552+i*2}',*args],input=input_data,capture_output=True,timeout=8)
        if r.returncode:raise RuntimeError('EMULATOR_UNAVAILABLE')
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
        # Stop before changing gear, matching the official console's Park sequence.
        self.console(i,'/vehicle/controls?speed=0&accelerator=0&brake=0&steering=0','PUT')
        self.console(i,'/vehicle/gear?gear='+gear,'PUT')
        if speed:self.console(i,f'/vehicle/controls?speed={speed}&accelerator=0&brake=0&steering=0','PUT')
    def geo(self,i,p,speed):
        self.adb(i,'emu','geo','fix',str(p['longitude']),str(p['latitude']),'0','8',str(round(speed/1.852,3)))
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
            for k in ['commandId','submittedAt','lastTick']:s.pop(k,None)
            s['progressM']=round(s.pop('travelled',0));s['distanceM']=round(s['distanceM'])
            return s
    def act(self,i,body):
        if not isinstance(body,dict) or set(body)-{'action','route','speedKph','rate','expectedRevision'}:raise ValueError('INVALID_COMMAND')
        action=body.get('action')
        if action not in ['destination','reroute','start','pause','park','cancel']:raise ValueError('INVALID_ACTION')
        route=body.get('route','A');speed=body.get('speedKph',30);rate=body.get('rate',5)
        if route not in ROUTES or type(speed) not in [int,float] or not math.isfinite(speed) or not 1<=speed<=60 or type(rate) is not int or rate not in [1,5,10]:raise ValueError('INVALID_PARAMETERS')
        with self.locks[i]:
            s=self.states[i]
            if type(body.get('expectedRevision')) is not int or body['expectedRevision']!=s['revision']:raise ValueError('REVISION_CONFLICT')
            # Read a real emulator response before changing local demo state.
            self.console(i,'/vehicle/state')
            if action in ['destination','reroute']:
                points=copy.deepcopy(ROUTES[route]['geometry'])
                if action=='reroute':
                    if not s['geometry']:raise ValueError('DESTINATION_REQUIRED')
                    points[0]=dict(s['position'])
                else:
                    self.motion(i,0,'Park');s.update(position=dict(START),state='READY',speedKph=0)
                    self.geo(i,s['position'],0)
                self.submit(i,s,points)
                s.update(route=route,destination=ROUTES[route]['name'],geometry=points,travelled=0,distanceM=sum(distance(a,b) for a,b in zip(points,points[1:])))
            elif action=='start':
                self.receipt(i,s)
                if not s['geometry'] or s['routeStatus']!='APPLIED':raise ValueError('ROUTE_NOT_APPLIED')
                self.motion(i,speed,'Drive');s.update(state='MOVING',speedKph=speed,rate=rate,lastTick=time.monotonic())
            elif action in ['park','pause','cancel']:
                self.motion(i,0,'Park' if action!='pause' else 'Drive')
                self.geo(i,s['position'],0)
                s.update(state={'park':'PARKED','pause':'PAUSED','cancel':'CANCELLED'}[action],speedKph=0)
                if action=='cancel':self.submit(i,s,[],'NONE');s['geometry']=[]
            s['revision']+=1;s['error']=None
            return self.snapshot(i)
    def tick(self,i,now):
        with self.locks[i]:
            s=self.states[i]
            if s['state']=='IDLE':return
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
                s['travelled']=s.get('travelled',0)+s['speedKph']/3.6*elapsed*s['rate']
                point,arrived=at_distance(s['geometry'],s['travelled']);self.geo(i,point,s['speedKph']);s['position']=point
                if arrived:
                    self.motion(i,0,'Park');self.geo(i,point,0);s.update(state='ARRIVED',speedKph=0,travelled=s['distanceM']);s['revision']+=1
            except Exception:
                s.update(state='ERROR',speedKph=0,error='EMULATOR_OR_ROUTE_UNAVAILABLE');s['revision']+=1
                try:self.motion(i,0,'Park')
                except Exception:pass
    def run(self):
        while True:
            for i in range(1,4):self.tick(i,time.monotonic())
            time.sleep(1)

simulator=Simulator()
