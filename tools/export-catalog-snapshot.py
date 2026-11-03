"""Export full rows from an immutable Git catalogue snapshot, without checkout changes."""
import json
from pathlib import Path
import re
import subprocess
import sys


def main():
    sha,out=sys.argv[1:]
    if not re.fullmatch('[0-9a-f]{40}',sha):raise ValueError('Use the full immutable commit SHA')
    def read(path):return json.loads(subprocess.check_output(['git','show',sha+':'+path]))
    manifest=read('data/places/manifest.json');rows=[]
    for shard in manifest['shards']:
        if Path(shard['path']).name!=shard['path']:raise ValueError('Unsafe shard path')
        rows.extend(read('data/places/'+shard['path']))
    if len(rows)!=manifest['count']:raise ValueError('Snapshot count mismatch')
    Path(out).write_text(json.dumps(rows,ensure_ascii=False));print(len(rows))

if __name__=='__main__':main()
