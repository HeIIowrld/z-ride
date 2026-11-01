from pathlib import Path
import json,re,subprocess,hashlib

ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'evidence'
ADB=Path(r'C:\Users\jeff4\AppData\Local\Android\Sdk\platform-tools\adb.exe')
def run(serial,*args):return subprocess.check_output([str(ADB),'-s',serial,*args],timeout=30).decode('utf-8','replace')
def read(serial,pkg,user,file):return json.loads(run(serial,'shell','run-as',pkg,'--user',user,'cat','files/'+file))
baseline=json.loads((OUT/'headless-integration-results.json').read_text(encoding='utf-8'))
assert baseline['status']=='passed'
cutoff=next(x['receipt']['data']['supportUntil']-5000 for x in baseline['checks'] if x['check']=='collected supply consumed by vehicle support')
report={'date':'2026-11-01','mode':'emulators only; no audible physical-speaker test','source':'app-private persisted diagnostics from latest successful baseline test window','eventsAfter':cutoff,'audio':{},'apks':[]}
for serial,pkg,user,label in [('emulator-5554','ai.zride.demo.car','10','car'),('emulator-5556','ai.zride.demo.phone','0','phone')]:
    # Logcat is a rotating buffer. Persisted app events preserve this test even
    # after verbose SDK callbacks have evicted its audio lines from logcat.
    logs=run(serial,'shell','run-as',pkg,'--user',user,'cat','files/diagnostics.jsonl')
    events=[]
    for line in logs.splitlines():
        try:
            event=json.loads(line)
            if event.get('time',0)>=cutoff:events.append(event)
        except ValueError:pass
    (OUT/(label+'-audio-events.json')).write_text(json.dumps([e for e in events if e.get('event')=='audio'],ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    messages=[e['data']['message'] for e in events if e.get('event')=='audio']
    frames=[int(m.group(1)) for x in messages if (m:=re.search(r'playbackFrames=(\d+)',x))]
    assert any('USAGE_GAME result=1' in x for x in messages),label+' focus not granted'
    assert frames and max(frames)>0,label+' no playback frame progress'
    assert any('focus abandoned' in x for x in messages),label+' focus not released'
    report['audio'][label]={'focusGranted':True,'playbackFrames':max(frames),'focusAbandoned':True,'messages':messages,
                            'physicalAudibilityTested':False,'separateSeatSpeakersTested':False}
    apk=ROOT/'android'/('carapp' if label=='car' else 'phoneapp')/'build'/'outputs'/'apk'/'debug'/('carapp-debug.apk' if label=='car' else 'phoneapp-debug.apk')
    installed=next(x for x in baseline['checks'] if x['check']=='APK installed' and x['package']==pkg)
    assert installed['bytes']==apk.stat().st_size,'APK changed since the integration test'
    report['apks'].append({'path':str(apk),'bytes':apk.stat().st_size,'sha256':hashlib.sha256(apk.read_bytes()).hexdigest()})
cabin=read('emulator-5554','ai.zride.demo.car','10','cabin-state.json')
fan=[v for v in cabin.values() if v.get('feature')=='hvac.fanSpeed' and v.get('kind')=='callback']
assert any(v.get('value')==5 for v in fan),'HVAC fan callback 5 not observed'
report['hvacFan']={'consoleTestInput':5,'actualSdkCallbacks':fan,'passed':True}
report['cabinCapabilities']=[v for v in cabin.values() if v.get('kind')=='capability']
report['seatOccupancy']={'status':'UNVERIFIED_SEMANTICS','policy':'raw Boolean logged, normalized UNKNOWN; host-approved manual role mapping',
                        'consoleTrueObservedSdkFalse':True,'consoleFalseObservedSdkTrue':True}
report['status']='passed'
(OUT/'cabin-state.json').write_text(json.dumps(cabin,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
(OUT/'signal-and-audio-results.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
print(json.dumps({'status':'passed','audio':{k:{'playbackFrames':v['playbackFrames'],'focusGranted':v['focusGranted']} for k,v in report['audio'].items()},
                  'hvacFanCallback':5,'cabinGroups':len(report['cabinCapabilities']),'seat':'UNVERIFIED_SEMANTICS'},ensure_ascii=False))
