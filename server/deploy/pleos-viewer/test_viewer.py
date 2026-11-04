from pathlib import Path
import sys
sys.path.insert(0,str(Path(__file__).resolve().parent))
import importlib.util,json,time,unittest,urllib.request,urllib.error,threading
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('pleos_viewer',Path(__file__).with_name('viewer.py'))
viewer=importlib.util.module_from_spec(spec);spec.loader.exec_module(viewer)

class ViewerTests(unittest.TestCase):
    def setUp(self):viewer.cache.update(at=0,value=None)
    def test_active_android_user_and_fresh_snapshot_are_filtered_before_publication(self):
        seen=[]
        def command(args,timeout=2):
            seen.append(args)
            if args[0]=='systemctl':return 'active' if '@1.'in args[-1] else ''
            if args[-1]=='sys.boot_completed':return '1'
            if args[-1]=='get-current-user':return '10'
            if 'cat'in args:return json.dumps({'roomId':'12345678-1234-1234-1234-123456789012','state':'READY','members':[{}],'joinCode':'MUST_NOT_PUBLISH','token':'MUST_NOT_PUBLISH','vehicle':{'gear':'P','ux':'ALLOWED','rawGps':'MUST_NOT_PUBLISH'}})
            return str(int(time.time()))
        with patch.object(viewer,'command',side_effect=command):value=viewer.catalog()
        self.assertTrue(value['vehicles'][0]['roomConnected'])
        self.assertEqual(value['vehicles'][1]['state'],'STOPPED')
        self.assertNotIn('MUST_NOT_PUBLISH',json.dumps(value))
        self.assertTrue(any('--user'in args and '10'in args for args in seen))
    def test_stale_snapshot_never_claims_live_party_connection(self):
        def command(args,timeout=2):
            if args[0]=='systemctl':return 'active'
            if args[-1]=='sys.boot_completed':return '1'
            if args[-1]=='get-current-user':return '10'
            if 'cat'in args:return json.dumps({'roomId':'12345678-1234-1234-1234-123456789012'})
            return str(int(time.time())-60)
        with patch.object(viewer,'command',side_effect=command):self.assertFalse(viewer.catalog()['vehicles'][0]['roomConnected'])
    def test_public_http_exposes_no_control_or_arbitrary_file_endpoint(self):
        server=viewer.ThreadingHTTPServer(('127.0.0.1',0),viewer.Handler);thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start();base='http://127.0.0.1:'+str(server.server_port)
        try:
            for path in ['/','/1','/2','/3','/viewer.js']:
                with urllib.request.urlopen(base+path) as r:self.assertEqual(r.status,200)
            for path in ['/4','/novnc/../../etc/passwd','/novnc/%2Fetc/passwd','/control','/viewer.py']:
                with self.assertRaises(urllib.error.HTTPError) as error:urllib.request.urlopen(base+path)
                self.assertEqual(error.exception.code,404)
            with self.assertRaises(urllib.error.HTTPError) as error:urllib.request.urlopen(urllib.request.Request(base+'/control',data=b'{}'))
            self.assertEqual(error.exception.code,404)
        finally:server.shutdown();server.server_close();thread.join()

if __name__=='__main__':unittest.main()
