"""Actual phone MapLibre/LocationManager -> world API test on our headless AVDs.

Run verify-demo.py first to create and approve a fresh shared room. Coordinates
are injected through the Android emulator GPS, never directly into our app.
"""
from pathlib import Path
import hashlib
import json
import subprocess
import sys
import time
import urllib.parse
import urllib.request

sys.stdout.reconfigure(encoding='utf-8')
ROOT=Path(__file__).resolve().parents[1]
ADB=Path(r'C:\Users\jeff4\AppData\Local\Android\Sdk\platform-tools\adb.exe')
OUT=ROOT/'evidence'
PHONE=('emulator-5556','ai.zride.demo.phone')
CAR=('emulator-5554','ai.zride.demo.car')
USERS={}
CHECKS=[]

def adb(app,*args,binary=False):
    result=subprocess.run([str(ADB),'-s',app[0],*map(str,args)],capture_output=True,timeout=30)
    if result.returncode:raise RuntimeError(result.stderr.decode('utf-8','replace')+result.stdout.decode('utf-8','replace'))
    return result.stdout if binary else result.stdout.decode('utf-8','replace').strip()

def private(app,name,binary=False):
    try:
        data=adb(app,'exec-out','run-as',app[1],'--user',USERS[app[0]],'cat','files/'+name,binary=binary)
        return data if binary else json.loads(data)
    except (RuntimeError,ValueError):return None

def wait(fn,label,timeout=30):
    end=time.monotonic()+timeout
    while time.monotonic()<end:
        value=fn()
        if value:return value
        time.sleep(.3)
    raise AssertionError('Timed out: '+label)

def record(name,**data):
    result={'check':name,'passed':True,**data};CHECKS.append(result)
    print(json.dumps(result,ensure_ascii=False),flush=True)

def command(action,**extras):
    args=['shell','am','broadcast','--user','current','-a','ai.zride.demo.DEBUG_COMMAND','-p',PHONE[1],'--es','testAction',action]
    for key,value in extras.items():args+=['--ez' if isinstance(value,bool) else '--es',key,str(value).lower() if isinstance(value,bool) else str(value)]
    adb(PHONE,*args)
    # Receiver queues actions for 200 ms; avoid replacing a pending command.
    time.sleep(.4)

def fix(latitude,longitude):
    previous=(private(PHONE,'map-state.json') or {}).get('location') or {}
    if abs(previous.get('latitude',0)-latitude)<.00001 and abs(previous.get('longitude',0)-longitude)<.00001:
        # Use a distinct point 2.2m away so a new callback is observable.
        latitude+=.00002
    adb(PHONE,'emu','geo','fix',longitude,latitude)
    def actual():
        state=private(PHONE,'map-state.json') or {};location=state.get('location') or {}
        if abs(location.get('latitude',0)-latitude)<.00001 and abs(location.get('longitude',0)-longitude)<.00001:return location
    return wait(actual,'actual Android Location callback')

def claim(spawn_id):
    before=private(PHONE,'world-last-result.json')
    command('worldClaim',spawnId=spawn_id,passengerConfirmed=True)
    return wait(lambda:new_result(before),'world claim result')

def new_result(before):
    value=private(PHONE,'world-last-result.json')
    return value if value and value!=before else None

def console_gear(gear):
    req=urllib.request.Request('http://127.0.0.1:8088/vehicle/gear?'+urllib.parse.urlencode({'gear':gear}),method='PUT')
    with urllib.request.urlopen(req,timeout=10) as result:return json.load(result)

def save(name,value):
    (OUT/name).write_text(json.dumps(value,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')

def run():
    for app in (CAR,PHONE):USERS[app[0]]=adb(app,'shell','am','get-current-user')
    current=private(PHONE,'room-state.json')
    assert current and current['roomId']==private(CAR,'room-state.json')['roomId'],'Run verify-demo.py first'
    state=wait(lambda:rendered(),'native map and Korean vector tiles fully rendered',90)
    record('native MapLibre OpenFreeMap render',styleLoaded=state['styleLoaded'],fullyRenderedFrame=state['fullyRenderedFrame'],building3dLayerPresent=state['building3dLayerPresent'],realMapSourcePresent=state['realMapSourcePresent'])
    for permission in ('android.permission.ACCESS_COARSE_LOCATION','android.permission.ACCESS_FINE_LOCATION'):
        adb(PHONE,'shell','pm','grant',PHONE[1],permission)
    command('gpsRefresh')
    location=fix(37.5665,126.978)
    assert location['source']=='EMULATOR_GPS' and 0<location['accuracyM']<=50
    record('Android LocationManager actual emulator callback',source=location['source'],accuracyM=location['accuracyM'],hardwareAttested=False)
    command('mapFocusGPS')
    command('mapRefresh')
    wait(lambda:(private(PHONE,'map-state.json') or {}).get('nearbySpawnCount')==3,'three Seoul test spawns')
    record('authenticated nearby Seoul game points',spawnCount=3,realChargers=False)
    console_gear('Drive')
    wait(lambda:(private(PHONE,'room-state.json') or {}).get('state')=='PAUSED','Drive pauses shared battle')
    before=private(CAR,'room-state.json')['collection']['inventory']['supplies']
    fix(37.5665,126.978)
    result=claim('SEOUL_CITYHALL_TEST_A')
    assert result.get('claimed') is True,result
    assert result['validationTier']=='MOCK_DEMO' and result['hardwareAttested'] is False
    record('map location claim during Drive',receipt=result)
    wait(lambda:private(CAR,'room-state.json')['collection']['inventory']['supplies']==before+1,'WS vehicle shared inventory update')
    record('world claim updates vehicle inventory through WebSocket',before=before,after=before+1)
    fix(37.5665,126.978)
    duplicate=claim('SEOUL_CITYHALL_TEST_A')
    assert 'ALREADY_CLAIMED' in str(duplicate.get('error','')),duplicate
    record('duplicate actual phone claim rejected',result=duplicate)
    # Claim B was discovered near Seoul before moving; fresh far-away fix must fail.
    fix(37.5765,126.978)
    outside=claim('SEOUL_CITYHALL_TEST_B')
    assert 'OUTSIDE_SPAWN' in str(outside.get('error','')),outside
    record('fresh out-of-range Android location rejected',result=outside)
    fix(37.5665,126.978)
    command('mapFocusGPS')
    command('mapRefresh')
    wait(lambda:(private(PHONE,'map-state.json') or {}).get('nearbySpawnCount')==3,'return Seoul markers')
    time.sleep(1)
    command('mapSnapshot')
    wait(lambda:(private(PHONE,'map-state.json') or {}).get('snapshotSaved'),'map bitmap snapshot')
    bitmap=private(PHONE,'map-snapshot.png',binary=True)
    assert bitmap and bitmap.startswith(b'\x89PNG\r\n\x1a\n')
    (OUT/'phone-seoul-map.png').write_bytes(bitmap)
    (OUT/'phone-map-screen.png').write_bytes(adb(PHONE,'exec-out','screencap','-p',binary=True))
    state=private(PHONE,'map-state.json');save('phone-map-state.json',state)
    save('phone-world-nearby.json',private(PHONE,'world-nearby.json'))
    record('native map bitmap and phone screen saved',width=state.get('snapshotWidth'),height=state.get('snapshotHeight'))
    console_gear('Park')
    wait(lambda:(private(CAR,'room-state.json') or {}).get('vehicle',{}).get('playAllowed'),'return Park')
    apk=ROOT/'android/phoneapp/build/outputs/apk/debug/phoneapp-debug.apk'
    return {'status':'passed','method':'actual native APK and LocationManager callbacks; headless emulator geo fix + official Console','checks':CHECKS,
        'apk':{'bytes':apk.stat().st_size,'sha256':hashlib.sha256(apk.read_bytes()).hexdigest()},
        'limitations':['emulator GPS only; no physical phone/field visit','client-reported locations not hardware attested','game points are test fixtures, not real charging stations','in-memory guest inventory']}

def rendered():
    state=private(PHONE,'map-state.json') or {}
    return state if all(state.get(k) for k in ('styleLoaded','fullyRenderedFrame','realMapSourcePresent','building3dLayerPresent')) else None

try:
    report=run()
except Exception as error:
    report={'status':'failed','checks':CHECKS,'error':str(error)}
    raise
finally:
    save('phone-map-integration-results.json',report)
