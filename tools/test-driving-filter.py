"""Regression fixtures for topology, parking containment and conservative exclusion."""
import importlib.util
from pathlib import Path
import unittest
from shapely.geometry import Point, Polygon

spec=importlib.util.spec_from_file_location('driving',Path(__file__).with_name('filter-driving-catalog.py'))
d=importlib.util.module_from_spec(spec);spec.loader.exec_module(d)

A=(1,127.0,37.0); B=(2,127.001,37.0); C=(3,127.002,37.0)
PARK=Polygon([(127.0008,36.9998),(127.0012,36.9998),(127.0012,37.0002),(127.0008,37.0002)])

def road(i,nodes,**tags):return {'id':i,'nodes':nodes,'tags':{'highway':'service',**tags}}

def row(oid,category='parking',facts=None,lon=127.001,lat=37.0):
    return {'id':oid,'category':category,'facts':facts or {},'latitude':lat,'longitude':lon}

def fixture(pois,roads=None,blocked=None,restricted=None):
    return {'roads':roads or [road(1,[A,B],highway='tertiary'),road(2,[B,C])], 'pois':pois,'blocked':set(blocked or []),'restricted_ways':set(restricted or []),'source':{'snapshotAt':'2026-11-02T21:21:26Z'}}

def poi(geom,tags=None,node_ids=None):return {'geometry':geom,'tags':tags or {},'node_ids':set(node_ids or [])}

class DrivingTests(unittest.TestCase):
    def test_public_connected_parking_kept(self):
        kept,excluded,_=d.assess([row('way/10')],fixture({'way/10':poi(PARK)}))
        self.assertEqual(len(kept),1);self.assertFalse(excluded)
        self.assertEqual(kept[0]['drivingAssessment']['roadNodeId'],2)
        self.assertFalse(kept[0]['drivingAssessment']['fieldVerified'])

    def test_nearby_but_disconnected_road_is_not_enough(self):
        off=Polygon([(127.0029,36.9999),(127.0031,36.9999),(127.0031,37.0001),(127.0029,37.0001)])
        roads=[road(1,[A,B],highway='tertiary'),road(9,[(8,127.003,37.0),(9,127.0031,37.0)])]
        kept,_,_=d.assess([row('way/10',lon=127.003)],fixture({'way/10':poi(off)},roads))
        self.assertFalse(kept)

    def test_oneway_dead_end_cannot_depart(self):
        nodes,_,_=d.network([road(1,[A,B],highway='tertiary'),road(2,[B,C],oneway='yes')],set(),set())
        self.assertNotIn(3,nodes)

    def test_barrier_breaks_graph(self):
        nodes,_,_=d.network([road(1,[A,B],highway='tertiary'),road(2,[B,C])],{2},set())
        self.assertNotIn(3,nodes)

    def test_restriction_ways_removed(self):
        nodes,_,_=d.network([road(1,[A,B],highway='tertiary'),road(2,[B,C])],set(),{2})
        self.assertNotIn(3,nodes)

    def test_peak_on_road_is_excluded(self):
        kept,excluded,_=d.assess([row('node/2','attraction',{'natural':'peak'})],fixture({'node/2':poi(Point(B[1:]),node_ids=[2])}))
        self.assertFalse(kept);self.assertEqual(excluded['node/2'],'terrain_not_vehicle_destination')

    def test_adjacent_attraction_is_not_same_site(self):
        rows=[row('way/10'),row('node/20','attraction',lon=127.00121)]
        pois={'way/10':poi(PARK),'node/20':poi(Point(127.00121,37.0),node_ids=[20])}
        kept,excluded,_=d.assess(rows,fixture(pois))
        self.assertEqual([r['id'] for r in kept],['way/10']);self.assertIn('node/20',excluded)

    def test_attraction_containing_parking_can_arrive_at_parking(self):
        site=Polygon([(127.0007,36.9997),(127.0013,36.9997),(127.0013,37.0003),(127.0007,37.0003)])
        rows=[row('way/10'),row('way/20','attraction')]
        kept,_,_=d.assess(rows,fixture({'way/10':poi(PARK),'way/20':poi(site)}))
        self.assertEqual(len(kept),2)
        self.assertEqual(kept[1]['drivingAssessment']['parkingId'],'way/10')

    def test_private_facility_is_excluded(self):
        kept,excluded,_=d.assess([row('way/10')],fixture({'way/10':poi(PARK,{'access':'private'})}))
        self.assertFalse(kept);self.assertEqual(excluded['way/10'],'facility_access_restricted_or_conditional')

    def test_bridge_does_not_join_surface_parking(self):
        roads=[road(1,[A,B],highway='tertiary',bridge='yes')]
        # Supply another ground-level public road so the spatial index exists.
        roads.append(road(8,[(8,127.01,37),(9,127.02,37)],highway='tertiary'))
        kept,_,_=d.assess([row('way/10')],fixture({'way/10':poi(PARK)},roads))
        self.assertFalse(kept)

    def test_restricted_or_uncertain_roads_excluded(self):
        for tags in ({'highway':'footway'},{'highway':'track'},{'highway':'service','access':'private'}, {'highway':'service','motorcar:conditional':'yes @ (Mo-Fr)'}):
            self.assertFalse(d.usable_road(tags))
        self.assertFalse(d.rejects_access({'access':'no','motorcar':'yes'}))

    def test_point_requires_shared_node(self):
        rows=[row('node/20','charging_station')]
        kept,_,_=d.assess(rows,fixture({'node/20':poi(Point(B[1:]),node_ids=[20])}))
        self.assertFalse(kept)

class ExtractionTests(unittest.TestCase):
    def test_linear_wall_and_explicit_passage(self):
        xml=b'<osm version="0.6"><node id="1" lat="37" lon="127"/><node id="2" lat="37" lon="127.001"><tag k="barrier" v="entrance"/></node><node id="3" lat="37" lon="127.002"/><way id="1"><nd ref="1"/><nd ref="2"/><nd ref="3"/><tag k="barrier" v="fence"/></way></osm>'
        h=d.Extract(set());h.apply_buffer(xml,'osm',locations=True)
        blocked=h.blocked|(h.linear_barrier_nodes-h.passages)
        self.assertIn(1,blocked);self.assertIn(3,blocked);self.assertNotIn(2,blocked)

    def test_current_peak_tag_is_excluded(self):
        r=row('node/2','attraction')
        kept,excluded,_=d.assess([r],fixture({'node/2':poi(Point(B[1:]),{'natural':'peak'},[2])}))
        self.assertFalse(kept);self.assertEqual(excluded['node/2'],'terrain_not_vehicle_destination')


if __name__=='__main__':unittest.main()
