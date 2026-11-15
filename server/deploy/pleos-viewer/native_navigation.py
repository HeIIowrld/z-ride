"""Fixed emulator-only SDK requests. Public status excludes coordinates/names."""
import json,uuid,threading,time,math
from simulation import simulator,ROUTES,distance
lock=threading.Lock()
indices={i:0 for i in range(1,4)}
driving={i:False for i in range(1,4)}

def wait_for_observation(i, file, matches, refresh=None):
    deadline=time.monotonic()+5
    while time.monotonic()<deadline:
        if refresh:
            refresh()
        try:
            value=json.loads(simulator.private(i,'cat','files/'+file))
        except (RuntimeError,ValueError):
            value={}
        if matches(value):
            return True
        time.sleep(.35)
    return False

def motion_matches(value, gear, speed, since):
    return (value.get('gear')==gear and isinstance(value.get('speedMps'), (int,float))
            and abs(value['speedMps']*3.6-speed)<2 and value.get('observedAt',0)>=since)

def position_matches(value, target):
    lat,lon=value.get('nativeLatitude'),value.get('nativeLongitude')
    return (isinstance(lat,(int,float)) and isinstance(lon,(int,float))
            and math.isfinite(lat) and math.isfinite(lon)
            and distance({'latitude':lat,'longitude':lon},target)<80)

def status(i):
    try:
        value=simulator.fresh_snapshot(i,'navigation-sdk-state.json')
        if driving[i] and value.get('sdkConnected'):
            simulator.console(i,'/vehicle/state')
        return {k:value.get(k) for k in ['source','sdkConnected','event','status','routeRevision','error','geometryAvailable','termsAgreed','positionSource']}
    except Exception:return {'source':'PLEOS_NAVI_HELPER','sdkConnected':False,'status':'UNAVAILABLE'}
def execute(i,body):
    if not isinstance(body,dict) or set(body)!= {'action'} or body['action'] not in ['destinationA','destinationB','reroute','cancel','drive','park','locationNext']:raise ValueError('INVALID_COMMAND')
    with lock:
        action=body['action']
        # Exclude concurrent demo journey playback before taking SDK control.
        if simulator.snapshot(i)['state']=='MOVING':raise ValueError('DEMO_JOURNEY_ACTIVE')
        if action != 'park' and not status(i).get('sdkConnected'):
            raise ValueError('NAVIGATION_SDK_NOT_CONNECTED')
        completion='CHECK_SDK_CALLBACK'
        if action in ['drive','park']:
            moving=action=='drive'
            speed,gear=(30,'Drive') if moving else (0,'Park')
            since=int(time.time()*1000)-1000
            simulator.motion(i,speed,gear)
            confirmed=wait_for_observation(i,'vehicle-motion.json',
                lambda value:motion_matches(value,'D' if moving else 'P',speed,since),
                lambda:simulator.console(i,f'/vehicle/controls?speed={speed}&accelerator=0&brake=0&steering=0','PUT'))
            driving[i]=moving and confirmed
            if moving and not confirmed:
                simulator.motion(i,0,'Park')
            completion='MOTION_CONFIRMED' if confirmed else 'MOTION_NOT_CONFIRMED'
        elif action=='locationNext':
            points=ROUTES['A']['geometry']
            next_index=(indices[i]+1)%len(points)
            target=points[next_index]
            simulator.geo(i,target,30)
            indices[i]=next_index
            confirmed=wait_for_observation(i,'navigation-sdk-state.json',
                lambda value:position_matches(value,target),
                (lambda:simulator.console(i,'/vehicle/state')) if driving[i] else None)
            completion='NATIVE_POSITION_CONFIRMED' if confirmed else 'NATIVE_POSITION_NOT_CONFIRMED'
        else:
            command={'commandId':str(uuid.uuid4()),'action':action}
            if action.startswith('destination'):
                name=action[-1];point=ROUTES[name]['geometry'][-1];command.update(action='destination',**point,name=ROUTES[name]['name'].replace(' (데모)',' (SDK)'))
            simulator.private(i,'tee','files/navigation-command.tmp',input_data=json.dumps(command).encode())
            simulator.private(i,'mv','files/navigation-command.tmp','files/navigation-command.json')
        return {'requested':action,'completion':completion,'sdk':status(i)}
