import json,unittest
from unittest.mock import patch
from simulation import EmulatorLocationError,Simulator,START,at_distance

class SimulationTests(unittest.TestCase):
    def setUp(self):
        self.sim=Simulator();self.commands=[];self.receipts={}
        def private(i,*args,input_data=None):
            self.commands.append((i,args))
            if args==('cat','files/room-state.json'):return json.dumps({'roomId':'test-room'})
            if args==('tee','files/demo-route.tmp'):
                body=json.loads(input_data);self.receipts[i]={'commandId':body['commandId'],'route':{'routeRevision':len(self.commands)},'error':None};return ''
            if args==('cat','files/demo-route-result.json'):return json.dumps(self.receipts.get(i,{}))
            return ''
        self.sim.private=private;self.sim.console=lambda *args,**kwargs:{};self.sim.geo=lambda *args:None
    def act(self,action,**args):return self.sim.act(1,{'action':action,'expectedRevision':self.sim.states[1]['revision'],**args})
    def test_reroute_retains_current_position_and_vehicle_isolation(self):
        self.act('destination');self.sim.tick(1,100);self.act('start',rate=1)
        self.sim.states[1]['lastTick']=100;self.sim.tick(1,102)
        before=self.sim.snapshot(1);self.assertGreater(before['progressM'],0)
        rerouted=self.act('reroute',route='B')
        self.assertEqual(rerouted['position'],before['position']);self.assertEqual(rerouted['geometry'][0],before['position'])
        self.assertEqual(rerouted['routeStatus'],'PENDING');self.assertEqual(self.sim.snapshot(2)['state'],'IDLE')
        self.assertNotIn('commandId',rerouted)
    def test_destination_ack_required_revision_conflict_and_command_boundaries(self):
        self.act('destination')
        self.receipts={}
        with self.assertRaisesRegex(ValueError,'ROUTE_NOT_APPLIED'):self.act('start')
        with self.assertRaisesRegex(ValueError,'REVISION_CONFLICT'):self.sim.act(1,{'action':'park','expectedRevision':0})
        with self.assertRaisesRegex(ValueError,'INVALID_COMMAND'):self.act('park',command='rm')
        with self.assertRaisesRegex(ValueError,'INVALID_PARAMETERS'):self.act('start',speedKph=float('nan'))
    def test_arrival_parks_and_cancel_clears_server_route(self):
        self.act('destination');self.sim.tick(1,100);self.act('start')
        s=self.sim.states[1];s['travelled']=s['distanceM'];s['lastTick']=100
        with patch.object(self.sim,'motion') as motion:self.sim.tick(1,101);motion.assert_called_once_with(1,0,'Park')
        self.assertEqual(self.sim.snapshot(1)['state'],'ARRIVED')
        result=self.act('cancel');self.assertEqual(result['state'],'CANCELLED');self.assertEqual(result['geometry'],[])
    def test_motion_failure_stops_simulation_instead_of_faking_progress(self):
        self.act('destination');self.sim.tick(1,100);self.act('start')
        with patch.object(self.sim,'geo',side_effect=RuntimeError):self.sim.tick(1,102)
        self.assertEqual(self.sim.snapshot(1)['state'],'ERROR')
        self.assertEqual(self.sim.snapshot(1)['speedKph'],0)
    def test_partial_native_snapshot_is_retried_before_route_submission(self):
        original=self.sim.private;reads=0
        def partial(i,*args,**kwargs):
            nonlocal reads
            if args==('cat','files/room-state.json'):
                reads+=1
                if reads==1:return '{'
            return original(i,*args,**kwargs)
        self.sim.private=partial
        result=self.act('destination');self.assertEqual(reads,2);self.assertEqual(result['routeStatus'],'PENDING')

    def test_custom_route_can_seek_and_change_rate_without_resetting_position(self):
        end={'latitude':37.529,'longitude':126.919}
        self.act('destination',route='custom',start=START,end=end,rate=2)
        self.sim.tick(1,100)
        sought=self.act('seek',progress=.5)
        self.assertEqual(sought['state'],'PARKED')
        self.assertAlmostEqual(sought['position']['latitude'],(START['latitude']+end['latitude'])/2)
        self.assertNotIn('roomId',sought)
        self.act('start',rate=2)
        self.sim.states[1]['lastTick']=100
        self.sim.tick(1,101)
        before=self.sim.snapshot(1)
        sped=self.act('start',rate=10)
        self.assertEqual(sped['position'],before['position'])
        self.assertEqual(sped['rate'],10)
        self.assertEqual(self.act('seek',progress=1)['state'],'ARRIVED')
        with self.assertRaisesRegex(ValueError,'ROUTE_FINISHED'):self.act('start')

    def test_invalid_custom_geometry_is_rejected_before_emulator_write(self):
        for end in [START,{'latitude':0,'longitude':0}]:
            with self.assertRaisesRegex(ValueError,'INVALID_ROUTE_LENGTH'):
                self.act('destination',route='custom',start=START,end=end)
        with self.assertRaisesRegex(ValueError,'INVALID_PARAMETERS'):
            self.act('destination',route='custom',start=START,end={'latitude':float('nan'),'longitude':0})
        self.assertEqual(self.commands,[])

    def test_unsupported_console_uses_android_test_provider_and_releases_it(self):
        sim=Simulator()
        commands=[]
        def adb(i,*args):
            commands.append(args)
            return "KO: unknown command, try 'help'" if args[:1]==('emu',) else ''
        sim.adb=adb
        sim.geo(1,START,0)
        sim.geo(1,START,30)
        sim.clear_geo(1)
        self.assertEqual(sum('add-test-provider' in args for args in commands),1)
        self.assertEqual(sum('set-test-provider-location' in args for args in commands),2)
        self.assertIn('remove-test-provider',commands[-2])
        self.assertEqual(commands[-1][-1],'default')
        self.assertFalse(sim.mock_gps)
        sim.adb=lambda *args:'KO: other failure'
        with self.assertRaises(EmulatorLocationError):sim.geo(1,START,0)

if __name__=='__main__':unittest.main()
