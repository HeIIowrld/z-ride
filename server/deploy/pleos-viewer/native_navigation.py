"""Fixed emulator-only SDK requests. Public status excludes coordinates/names."""
import json,uuid,threading
from simulation import simulator,ROUTES
lock=threading.Lock()
indices={i:0 for i in range(1,4)}
driving={i:False for i in range(1,4)}
def status(i):
    try:
        if driving[i]:simulator.console(i,'/vehicle/state')
        value=json.loads(simulator.private(i,'cat','files/navigation-sdk-state.json'))
        return {k:value.get(k) for k in ['source','sdkConnected','event','status','routeRevision','error','geometryAvailable','termsAgreed','positionSource']}
    except Exception:return {'source':'PLEOS_NAVI_HELPER','sdkConnected':False,'status':'UNAVAILABLE'}
def execute(i,body):
    if not isinstance(body,dict) or set(body)!= {'action'} or body['action'] not in ['destinationA','destinationB','reroute','cancel','drive','park','locationNext']:raise ValueError('INVALID_COMMAND')
    with lock:
        action=body['action']
        # Exclude concurrent demo journey playback before taking SDK control.
        if simulator.snapshot(i)['state']=='MOVING':raise ValueError('DEMO_JOURNEY_ACTIVE')
        if action in ['drive','park']:
            simulator.motion(i,30 if action=='drive' else 0,'Drive' if action=='drive' else 'Park')
            driving[i]=action=='drive'
        elif action=='locationNext':
            points=ROUTES['A']['geometry'];indices[i]=(indices[i]+1)%len(points);simulator.geo(i,points[indices[i]],30)
        else:
            command={'commandId':str(uuid.uuid4()),'action':action}
            if action.startswith('destination'):
                name=action[-1];point=ROUTES[name]['geometry'][-1];command.update(action='destination',**point,name=ROUTES[name]['name'].replace(' (데모)',' (SDK)'))
            simulator.private(i,'tee','files/navigation-command.tmp',input_data=json.dumps(command).encode())
            simulator.private(i,'mv','files/navigation-command.tmp','files/navigation-command.json')
        return {'requested':action,'completion':'CHECK_SDK_CALLBACK','sdk':status(i)}
