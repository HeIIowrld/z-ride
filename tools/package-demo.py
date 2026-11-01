"""Copy reproducible demo sources/APKs/evidence, excluding SDKs and credentials."""
from pathlib import Path
import hashlib
import json
import os
import shutil
import sys
import zipfile

sys.stdout.reconfigure(encoding='utf-8')

ROOT=Path(__file__).resolve().parents[1]
DEST=Path(sys.argv[1]) if len(sys.argv)>1 else Path.cwd()/'outputs'/'Z-RIDE_구현검증_20261101'/'demo_v0.3.0'
DEST.mkdir(parents=True,exist_ok=True)
SKIP={'.git','.gradle','node_modules','build','evidence','__pycache__','downloads','jdk','.infra-lock-stage'}
SERVER_FILES={'server.mjs','world.mjs','package.json','package-lock.json','pnpm-lock.yaml','pnpm-workspace.yaml','protocol.json','openapi.json','README.md','Dockerfile','.dockerignore','compose.yaml','.env.example','.gitignore','infra-preparation-results.json','openapi-validation-results.json','ws-liveness-results.json'}
TOOLS_FILES={'Start-Demo.ps1','verify-demo.py','verify-phone-map.py','capture-signal-evidence.py','package-demo.py'}
def include(path):
    relative=path.relative_to(ROOT)
    parts=relative.parts
    if len(parts)==1:return relative.name in {'README.md','.gitignore'}
    if parts[0]=='server':return (len(parts)==2 and path.name in SERVER_FILES) or (parts[1] in {'docs','test','tools'} and path.suffix in {'.md','.mjs'})
    if parts[0]=='tools':return len(parts)==2 and path.name in TOOLS_FILES
    if parts[0]=='android':
        return path.name!='local.properties' and (path.suffix in {'.java','.xml','.gradle','.properties','.pro','.sh','.bat'} or path.name in {'gradlew','README.md','gradle-wrapper.jar'})
    return False

archive=DEST/'Z-RIDE-demo-source.zip'
count=0
with zipfile.ZipFile(archive,'w',zipfile.ZIP_DEFLATED) as z:
    for directory,subdirs,names in os.walk(ROOT):
        subdirs[:]=[name for name in subdirs if name not in SKIP]
        for name in names:
            path=Path(directory)/name
            if include(path):z.write(path,'Z-RIDE/'+path.relative_to(ROOT).as_posix());count+=1

copied=[]
for module in ('carapp','phoneapp'):
    source=ROOT/'android'/module/'build'/'outputs'/'apk'/'debug'/(module+'-debug.apk')
    target=DEST/source.name;shutil.copy2(source,target);copied.append(target)
evidence_names=['headless-integration-results.json','signal-and-audio-results.json','cabin-state.json',
    'car-final-snapshot.json','phone-final-snapshot.json','car-parked-coop.png','car-driving-blocked.png',
    'phone-map-integration-results.json','phone-map-state.json','phone-world-nearby.json','phone-seoul-map.png','phone-map-screen.png']
evidence_dest=DEST/'evidence';evidence_dest.mkdir(exist_ok=True)
for name in evidence_names:
    source=ROOT/'evidence'/name
    if source.exists():shutil.copy2(source,evidence_dest/name);copied.append(evidence_dest/name)
for name in ('test-results.json','receipt-limit-results.json','world-test-results.json','ws-liveness-results.json'):
    source=ROOT/'server'/name
    if source.exists():shutil.copy2(source,evidence_dest/name);copied.append(evidence_dest/name)
server_archive=DEST/'Z-RIDE-server-api-infra.zip'
with zipfile.ZipFile(server_archive,'w',zipfile.ZIP_DEFLATED) as z:
    for directory,subdirs,names in os.walk(ROOT/'server'):
        subdirs[:]=[name for name in subdirs if name not in SKIP]
        for name in names:
            path=Path(directory)/name
            if include(path):z.write(path,'Z-RIDE-server/'+path.relative_to(ROOT/'server').as_posix())
copied.append(server_archive)
manifest={'sourceFiles':count,'excluded':['Android SDK/Studio/system images','download archives/JDK','node_modules/Gradle cache/build intermediates','local.properties','runtime room tokens and join codes'],
    'files':[{'name':path.relative_to(DEST).as_posix(),'bytes':path.stat().st_size,'sha256':hashlib.sha256(path.read_bytes()).hexdigest()} for path in [archive,*copied]]}
(DEST/'manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
print(json.dumps({'destination':str(DEST),'sourceFiles':count,'copiedFiles':len(copied),'archiveBytes':archive.stat().st_size},ensure_ascii=False))
