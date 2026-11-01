"""Headless verification of the two actual debug APKs. Only emulator targets.

Uses the installed SDK's ADB, the official local Pleos Virtual Console backend,
and explicit debug-only app test Intents. Does not spoof car state in our app.
"""
from pathlib import Path
import json
import subprocess
import time
import re
import urllib.parse
import urllib.request
import sys

sys.stdout.reconfigure(encoding='utf-8')
ROOT = Path(__file__).resolve().parents[1]
ADB = Path(r'C:\Users\jeff4\AppData\Local\Android\Sdk\platform-tools\adb.exe')
EVIDENCE = ROOT / 'evidence'
EVIDENCE.mkdir(exist_ok=True)
CAR = ('emulator-5554', 'ai.zride.demo.car')
PHONE = ('emulator-5556', 'ai.zride.demo.phone')
CHECKS = []
USERS = {}

def adb(device, *args, binary=False, timeout=40):
    if device not in (CAR[0], PHONE[0]): raise ValueError('Only our named emulators are permitted')
    r = subprocess.run([str(ADB), '-s', device, *map(str,args)], capture_output=True, timeout=timeout)
    if r.returncode:
        raise RuntimeError('ADB '+str(args[:3])+' failed: '+r.stderr.decode('utf-8','replace')+r.stdout.decode('utf-8','replace'))
    return r.stdout if binary else r.stdout.decode('utf-8','replace').strip()

def record(name, **data):
    entry={'check':name,'passed':True,**data}
    CHECKS.append(entry)
    print(json.dumps(entry,ensure_ascii=False),flush=True)

def private(app, file):
    device,pkg=app
    try:
        text=adb(device,'shell','run-as',pkg,'--user',USERS[device],'cat','files/'+file,timeout=8)
        return json.loads(text)
    except (RuntimeError,json.JSONDecodeError): return None

def wait_value(fn, label, timeout=25):
    deadline=time.monotonic()+timeout
    while time.monotonic()<deadline:
        result=fn()
        if result: return result
        time.sleep(.3)
    raise AssertionError('Timed out: '+label)

def room(app): return private(app,'room-state.json')
def room_when(app, predicate):
    value=room(app)
    return value if value and predicate(value) else None

def start(app, action=None, extras=None, fresh=False):
    if action and action != 'connect' and not fresh:
        ack_before=executed_count(app,action) if action in ('soundOn','soundOff','inspectCabin') else None
        args=['shell','am','broadcast','--user','current','-a','ai.zride.demo.DEBUG_COMMAND','-p',app[1],
              '--es','testAction',action]
        for key,value in (extras or {}).items():
            kind='--ez' if isinstance(value,bool) else '--ef' if isinstance(value,float) else '--es'
            args += [kind,key,str(value).lower() if isinstance(value,bool) else str(value)]
        output=adb(app[0],*args)
        if ack_before is not None:
            wait_value(lambda:executed_count(app,action)>ack_before,'debug acknowledgement '+action,10)
        return output
    args=['shell','am','start']
    if fresh: args.append('-S')
    args+=['-n',app[1]+'/.MainActivity','-f','0x20000000']
    if action: args+=['--es','testAction',action]
    for key,value in (extras or {}).items():
        kind='--ez' if isinstance(value,bool) else '--ef' if isinstance(value,float) else '--es'
        args += [kind,key,str(value).lower() if isinstance(value,bool) else str(value)]
    return adb(app[0],*args)

def executed_count(app,name):
    logs=adb(app[0],'logcat','-d','-s','ZRideDiag:I')
    count=0
    for line in logs.splitlines():
        m=re.search(r'ZRideDiag: (\{.*\})$',line)
        if m:
            try:
                event=json.loads(m.group(1))
                if event.get('event')=='test.executed' and event.get('data',{}).get('action')==name:count+=1
            except ValueError:pass
    return count

def action(app, name, expected, extras=None, timeout=20):
    before=private(app,'last-action-result.json') or {}
    old_id=before.get('commandId')
    start(app,name,extras)
    receipt=wait_value(lambda: next_receipt(app,old_id),name+' result',timeout)
    if receipt.get('ok') is not expected:
        raise AssertionError(name+' unexpected result: '+json.dumps(receipt,ensure_ascii=False))
    return receipt

def next_receipt(app,old_id):
    value=private(app,'last-action-result.json')
    return value if value and value.get('commandId')!=old_id else None

def console(endpoint,**params):
    url='http://127.0.0.1:8088'+endpoint+'?'+urllib.parse.urlencode({k:str(v).lower() if isinstance(v,bool) else v for k,v in params.items()})
    req=urllib.request.Request(url,method='PUT')
    with urllib.request.urlopen(req,timeout=10) as r: return json.load(r)

def sanitized(value):
    if isinstance(value,dict):
        return {k:sanitized(v) for k,v in value.items() if k not in ('token','accessToken','refreshToken','joinCode','joinExpiresAt')}
    if isinstance(value,list): return [sanitized(v) for v in value]
    return value

def save_json(name,value):
    (EVIDENCE/name).write_text(json.dumps(sanitized(value),ensure_ascii=False,indent=2)+'\n',encoding='utf-8')

def screenshot(app,name):
    data=adb(app[0],'exec-out','screencap','-p',binary=True)
    assert data.startswith(b'\x89PNG\r\n\x1a\n')
    (EVIDENCE/name).write_bytes(data)

def run():
    for app,module in [(CAR,'carapp'),(PHONE,'phoneapp')]:
        wait_value(lambda:adb(app[0],'shell','getprop','sys.boot_completed')=='1','boot '+app[0],60)
        USERS[app[0]]=adb(app[0],'shell','am','get-current-user')
        apk=ROOT/'android'/module/'build'/'outputs'/'apk'/'debug'/(module+'-debug.apk')
        assert 'Success' in adb(app[0],'install','-r',apk)
        record('APK installed',device=app[0],package=app[1],user=USERS[app[0]],bytes=apk.stat().st_size)
    adb(CAR[0],'forward','tcp:8088','tcp:8088')
    console('/vehicle/gear',gear='Park')
    # Console setting is independently observed through the actual SDK callback.
    console('/vehicle/ev-battery',field='soc',value=67)
    console('/vehicle/hvac',fan_speed=3)
    prior_room=(room(CAR) or {}).get('roomId')
    start(CAR,'connect',fresh=True)
    vehicle=wait_value(lambda:room_when(CAR,lambda r:r.get('roomId')!=prior_room and bool(r.get('joinCode')) and r.get('vehicle',{}).get('playAllowed')),'car fresh room and actual gate')
    room_id=vehicle['roomId']
    code=vehicle['joinCode']
    record('actual vehicle gate',ux=vehicle['vehicle']['ux'],gear=vehicle['vehicle']['gear'],roomId=room_id)
    start(PHONE,extras={'joinCode':code,'seat':'FRONT_PASSENGER','autoConnect':True},fresh=True)
    pending=wait_value(lambda:room_when(PHONE,lambda r:r.get('roomId')==room_id and r.get('state')=='PENDING'),'phone pending in car room')
    record('actual phone joined same room pending approval',roomId=room_id,pendingVehicleSource=pending['vehicle']['source'])
    start(CAR,'approvePending')
    approved=wait_value(lambda:room_when(PHONE,lambda r:r.get('state')!='PENDING' and any(m.get('approved') and m.get('role')=='FRONT_PASSENGER' for m in r.get('members',[]))),'host approval')
    record('host approved passenger',roomId=approved['roomId'],seatEvidence=[m.get('seatEvidence') for m in approved['members'] if m.get('role')=='FRONT_PASSENGER'])
    action(CAR,'roundStart',True)
    wait_value(lambda:room_when(PHONE,lambda r:r.get('state')=='PLAYING'),'battle playing')
    record('parked battle started')
    accepted=action(PHONE,'fire',True,{'testAngleDeg':60.0})
    record('passenger permitted sector accepted',receipt=accepted)
    rejected=action(PHONE,'fire',False,{'testAngleDeg':-135.0})
    assert rejected['error']['code']=='ANGLE_OUTSIDE_SECTOR'
    record('passenger outside sector rejected',code=rejected['error']['code'])
    # Switch the emulator, never fabricate a vehicle.report in our application.
    console('/vehicle/gear',gear='Drive')
    paused=wait_value(lambda:room_when(PHONE,lambda r:r.get('state')=='PAUSED' and not r.get('vehicle',{}).get('playAllowed')),'actual Drive transition pauses battle')
    record('actual Drive pauses battle',pauseReason=paused.get('pauseReason'),vehicle=paused.get('vehicle'))
    screenshot(CAR,'car-driving-blocked.png')
    rejected=action(PHONE,'fire',False,{'testAngleDeg':60.0})
    record('battle fire blocked in Drive',code=rejected.get('error',{}).get('code'))
    collected=action(PHONE,'collect',True,{'pickupId':'DEMO_PICKUP_A','passengerConfirmed':True})
    assert collected.get('data',{}).get('gpsVerified') is False
    record('phone independent collection in Drive',receipt=collected)
    duplicate=action(PHONE,'collect',False,{'pickupId':'DEMO_PICKUP_A','passengerConfirmed':True})
    assert duplicate['error']['code']=='ALREADY_COLLECTED'
    record('duplicate pickup rejected',code=duplicate['error']['code'])
    screenshot(PHONE,'phone-driving-collection.png')
    console('/vehicle/gear',gear='Park')
    # Merely parking must not automatically resume the shared battle.
    time.sleep(1)
    still_paused=room(PHONE)
    assert still_paused['state']=='PAUSED'
    record('Park does not auto-resume battle')
    action(CAR,'roundStart',True)
    wait_value(lambda:room_when(PHONE,lambda r:r.get('state')=='PLAYING'),'explicit parked resume')
    support=action(CAR,'supportPulse',True)
    assert support['data']['suppliesConsumed']==1
    assert support['data']['inventory']['supplies']==0
    record('collected supply consumed by vehicle support',receipt=support)
    boosted=action(PHONE,'fire',True,{'testAngleDeg':60.0})
    record('supported passenger shot',receipt=boosted)
    start(CAR,'soundOn')
    start(PHONE,'soundOn')
    # A separate direction inside the passenger sector can miss; still tests opt-in feedback.
    action(PHONE,'fire',True,{'testAngleDeg':0.0})
    time.sleep(.5)
    start(PHONE,'soundOff')
    start(CAR,'soundOff')
    start(CAR,'inspectCabin')
    cabin=wait_value(lambda:private(CAR,'cabin-state.json'),'cabin READ diagnostic')
    console('/vehicle/hvac',fan_speed=5)
    cabin=wait_value(lambda:fan_callback_five(),'actual HVAC fan callback after Console input')
    save_json('cabin-state.json',cabin)
    record('cabin READ diagnostic captured',entries=len(cabin))
    record('actual HVAC fan callback',oldConsoleInput=3,newConsoleInput=5,sdkCallback=5)
    screenshot(CAR,'car-parked-coop.png')
    screenshot(PHONE,'phone-parked-coop.png')
    save_json('car-final-snapshot.json',room(CAR))
    save_json('phone-final-snapshot.json',room(PHONE))
    for app,name in [(CAR,'car'),(PHONE,'phone')]:
        log=adb(app[0],'logcat','-d','-s','ZRideDiag:I')
        (EVIDENCE/(name+'-diagnostics.log')).write_text(log,encoding='utf-8')
        frame_counts=[int(x) for x in re.findall(r'playbackFrames=(\d+)',log)]
        assert frame_counts and max(frame_counts)>0,'No AudioTrack frame progress: '+name
        assert 'USAGE_GAME result=1' in log and 'focus abandoned' in log
        record('game audio '+name,focusGranted=True,playbackFrames=max(frame_counts),focusAbandoned=True,physicalAudibilityTested=False)
    record('screenshots and sanitized snapshots saved',actualPhoneHardware=False,actualVehicleHardware=False)

def fan_callback_five():
    value=private(CAR,'cabin-state.json')
    if value and any(v.get('feature')=='hvac.fanSpeed' and v.get('kind')=='callback' and v.get('value')==5 for v in value.values()):return value
    return None

try:
    run()
    report={'checkedDate':'2026-11-01','status':'passed','method':'Headless ADB + actual APKs + official local Virtual Console API',
            'checks':CHECKS,'limitations':['emulators only','GPS pickups are fixtures, not location verified',
            'Seat Boolean semantics quarantined; manual seat roles','charging current state not yet proven',
            'audio output route/presentation is not proof of separate physical speakers','in-memory server, no persistent rewards']}
except Exception as error:
    report={'checkedDate':'2026-11-01','status':'failed','checks':CHECKS,'error':str(error)}
    print(json.dumps({'FAILED':str(error)},ensure_ascii=False),flush=True)
    raise
finally:
    save_json('headless-integration-results.json',report)
