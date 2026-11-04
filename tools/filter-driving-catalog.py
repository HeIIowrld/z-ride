"""Conservatively filter catalogue using OSM car graph and parking geometry.

Requires osmium, shapely, pyproj (tools/driving-requirements.txt).
extract PBF UNFILTERED_JSON NETWORK_PICKLE; filter UNFILTERED_JSON NETWORK_PICKLE
Pickles are local intermediates produced by this script, never external inputs.
"""
import argparse
import collections
import hashlib
import json
import pickle
from pathlib import Path

import osmium
from pyproj import Transformer
from shapely import wkb, transform as transform_geometry
from shapely.geometry import Point, Polygon
from shapely.strtree import STRtree

ROOT = Path(__file__).resolve().parents[1] / 'data' / 'places'
PROJECT = Transformer.from_crs('EPSG:4326', 'EPSG:5179', always_xy=True).transform
CAR_ROADS = {'motorway','trunk','primary','secondary','tertiary','unclassified','residential','living_street','service',
             'motorway_link','trunk_link','primary_link','secondary_link','tertiary_link'}
ANCHORS = {'primary','secondary','tertiary','trunk','motorway'}
ALLOWED = {'yes','designated','permissive'}
TERRAIN = {'peak','saddle','cave_entrance','cliff','rock','bare_rock','spring','tree'}


def rejects_access(tags):
    if any(k.startswith(('access:','vehicle:','motor_vehicle:','motorcar:')) for k in tags):
        return True  # Conditional, direction-specific and other refinements need separate interpretation.
    for key in ('motorcar','motor_vehicle','vehicle','access'):
        if key in tags:
            return tags[key] not in ALLOWED
    return False


def usable_road(tags):
    return (tags.get('highway') in CAR_ROADS and not rejects_access(tags)
            and tags.get('area') != 'yes' and tags.get('impassable') != 'yes'
            and tags.get('smoothness') not in ('very_bad','horrible','very_horrible','impassable')
            and tags.get('surface') not in ('sand','mud','deep_gravel')
            and not any(k in tags for k in ('construction','proposed','maxheight','maxwidth','maxweight'))
            and not any(k.endswith(':conditional') for k in tags)
            and not any(tags.get(k)=='yes' for k in ('disused','abandoned','demolished'))
            and tags.get('oneway','no') in ('no','yes','1','true','-1','false','0'))


def layer_of(tags):
    try: return int(tags.get('layer','0'))
    except ValueError: return None


class Extract(osmium.SimpleHandler):
    def __init__(self, ids):
        super().__init__(); self.ids=ids; self.roads=[]; self.pois={}; self.blocked=set(); self.linear_barrier_nodes=set(); self.passages=set(); self.restricted_ways=set(); self.factory=osmium.geom.WKBFactory(); self.errors=collections.Counter()
    def node(self,n):
        oid=f'node/{n.id}'; relevant=oid in self.ids
        barrier=n.tags.get('barrier')
        if barrier in ('entrance','cattle_grid','toll_booth'): self.passages.add(n.id)
        if barrier and barrier not in ('no','entrance','cattle_grid','toll_booth'): self.blocked.add(n.id)
        # Point access restrictions also block a shared road graph node.
        if rejects_access(dict(n.tags)): self.blocked.add(n.id)
        if relevant:
            self.pois[oid]={'geometry':Point(n.location.lon,n.location.lat),'tags':dict(n.tags),'node_ids':{n.id}}
    def way(self,w):
        oid=f'way/{w.id}'; highway=w.tags.get('highway'); relevant=oid in self.ids
        barrier=w.tags.get('barrier')
        if barrier and barrier!='no': self.linear_barrier_nodes.update(n.ref for n in w.nodes)
        if not highway and not relevant:return
        tags=dict(w.tags)
        if highway and usable_road(tags):
            try: nodes=[(n.ref,n.lon,n.lat) for n in w.nodes]
            except osmium.InvalidLocationError: self.errors['road_missing_location']+=1;return
            if len(nodes)>1:self.roads.append({'id':w.id,'tags':tags,'nodes':nodes})
        if relevant and w.is_closed():
            try:
                poly=Polygon([(n.lon,n.lat) for n in w.nodes])
                if not poly.is_valid: self.errors['poi_invalid_polygon']+=1;return
                self.pois[oid]={'geometry':poly,'tags':tags,'node_ids':{n.ref for n in w.nodes}}
            except osmium.InvalidLocationError:self.errors['poi_missing_location']+=1
    def relation(self,r):
        if r.tags.get('type')=='restriction':
            # Discard affected ways entirely, a conservative alternative to ignoring turns.
            for m in r.members:
                if m.type=='w':self.restricted_ways.add(m.ref)
                elif m.type=='n' and m.role=='via':self.blocked.add(m.ref)
    def area(self,a):
        oid=f"{'way' if a.from_way() else 'relation'}/{a.orig_id()}"
        if oid not in self.ids:return
        try:
            poly=wkb.loads(self.factory.create_multipolygon(a),hex=True)
            if not poly.is_valid:self.errors['poi_invalid_multipolygon']+=1;return
            self.pois[oid]={'geometry':poly,'tags':dict(a.tags),'node_ids':set()}
        except Exception:self.errors['poi_area_error']+=1


def walk(graph,seeds):
    visited=set(seeds);todo=list(seeds)
    while todo:
        for nxt in graph.get(todo.pop(),()):
            if nxt not in visited:visited.add(nxt);todo.append(nxt)
    return visited


def network(roads,blocked,restricted):
    forward=collections.defaultdict(list);reverse=collections.defaultdict(list);seeds=set();accepted=[]
    for road in roads:
        if road['id'] in restricted or not usable_road(road['tags']):continue
        tags=road['tags'];nodes=road['nodes'];oneway=tags.get('oneway', 'yes' if tags.get('junction')=='roundabout' or tags['highway'] in ('motorway','motorway_link') else 'no')
        added=False
        for a,b in zip(nodes,nodes[1:]):
            if a[0] in blocked or b[0] in blocked:continue
            if oneway not in ('yes','1','true'):
                forward[b[0]].append(a[0]);reverse[a[0]].append(b[0])
            if oneway!='-1':
                forward[a[0]].append(b[0]);reverse[b[0]].append(a[0])
            added=True
            if tags['highway'] in ANCHORS:seeds.update((a[0],b[0]))
        if added:accepted.append(road)
    # Both arrival and departure must be possible relative to the anchor network.
    connected=(walk(forward,seeds)&walk(reverse,seeds))-blocked
    return connected,accepted,{'anchorNodes':len(seeds),'roundTripNodes':len(connected),'acceptedWays':len(accepted),'blockedNodes':len(blocked),'restrictionMemberWays':len(restricted)}


def road_points(connected,roads):
    points=[];refs=[];seen=set()
    for r in roads:
        tags=r['tags']; layer=layer_of(tags)
        # Geometry-only matches must not join bridges/tunnels to surface facilities.
        if layer is None or tags.get('bridge','no')!='no' or tags.get('tunnel','no')!='no':continue
        for node,lon,lat in r['nodes']:
            if node not in connected or (node,layer) in seen:continue
            seen.add((node,layer));x,y=PROJECT(lon,lat);points.append(Point(x,y))
            refs.append({'roadNodeId':node,'roadWayId':r['id'],'latitude':lat,'longitude':lon,'layer':layer,'highway':tags['highway']})
    return points,refs


def assess(rows,data):
    connected,roads,stats=network(data['roads'],data['blocked'],data['restricted_ways'])
    points,refs=road_points(connected,roads)
    if not points:raise ValueError('No connected car road points')
    tree=STRtree(points);pois=data['pois'];projected={};direct={};excluded={}
    for row in rows:
        oid=row['id'];poi=pois.get(oid)
        if row['facts'].get('natural') in TERRAIN or poi and poi['tags'].get('natural') in TERRAIN:
            excluded[oid]='terrain_not_vehicle_destination';continue
        if not poi:excluded[oid]='missing_current_geometry';continue
        if rejects_access(poi['tags']):excluded[oid]='facility_access_restricted_or_conditional';continue
        if any(poi['tags'].get(k) for k in ('disused:amenity','abandoned:amenity','demolished:amenity')) or any(poi['tags'].get(k)=='yes' for k in ('disused','abandoned','demolished')):
            excluded[oid]='inactive_facility';continue
        geom=transform_geometry(poi['geometry'],PROJECT,interleaved=False);projected[oid]=geom;layer=layer_of(poi['tags'])
        if row['category']=='attraction':continue
        # A node must be the same actual OSM road node; never snap a nearby POI.
        if geom.geom_type=='Point':
            candidates=tree.query(geom.buffer(0.001))
            hits=[int(i) for i in candidates if refs[int(i)]['roadNodeId'] in poi['node_ids'] and refs[int(i)]['layer']==layer]
        else:
            candidates=tree.query(geom)
            hits=[int(i) for i in candidates if refs[int(i)]['layer']==layer and geom.covers(points[int(i)])]
        if hits:
            # Use a real network node as arrival position, not the polygon centre.
            centre=Point(*PROJECT(row['longitude'],row['latitude']))
            hit=min(hits,key=lambda i:centre.distance(points[i]))
            direct[oid]=refs[hit]
    parking={r['id']:r for r in rows if r['category']=='parking' and r['id'] in direct and r['id'] not in excluded}
    parking_ids=list(parking);parking_geoms=[projected[oid] for oid in parking_ids]
    parking_tree=STRtree(parking_geoms) if parking_geoms else None
    kept=[]
    for row in rows:
        oid=row['id']
        if oid in excluded:continue
        geom=projected[oid];proof=None;method=None;parking_id=None;walk_distance=0.0
        if row['category'] in ('parking','fuel_station') and oid in direct:
            proof=direct[oid];method='car_road_node_inside_facility'
        elif row['category']=='charging_station' and oid in direct and geom.geom_type=='Point':
            proof=direct[oid];method='shared_car_road_node'
        elif parking_tree is not None:
            point=Point(*PROJECT(row['longitude'],row['latitude']))
            for i in parking_tree.query(geom):
                pid=parking_ids[int(i)];pg=parking_geoms[int(i)]
                # No mere distance match across a road, fence, river or separate grounds.
                same_site=pg.covers(geom) if geom.geom_type=='Point' else geom.covers(pg)
                distance=point.distance(pg)
                walk_allowed=pois[pid]['tags'].get('foot','yes') in ALLOWED and poi['tags'].get('foot','yes') in ALLOWED
                if same_site and distance<=100 and walk_allowed:
                    candidate=direct[pid]
                    # Navigation node must also be close to the POI, not a remote carpark edge.
                    if point.distance(Point(*PROJECT(candidate['longitude'],candidate['latitude'])))>150:continue
                    proof=candidate;method='connected_parking_same_site';parking_id=pid;walk_distance=round(distance,2);break
        if not proof:
            excluded[oid]='no_connected_same_site_car_arrival';continue
        row=dict(row)
        row['drivingAssessment']={'status':'osm_network_connected','method':method,'roadWayId':proof['roadWayId'], 'roadNodeId':proof['roadNodeId'],
            'arrival':{'latitude':proof['latitude'],'longitude':proof['longitude']},'parkingId':parking_id,
            'poiToParkingDistanceM':walk_distance,'networkRoundTrip':True,'fieldVerified':False,'snapshotAt':data['source']['snapshotAt']}
        kept.append(row)
    return kept,excluded,stats


def extract(pbf,catalog,out):
    rows=json.loads(catalog.read_text());h=Extract({r['id'] for r in rows})
    h.apply_file(str(pbf),locations=True,idx='flex_mem',filters=[osmium.filter.EmptyTagFilter()])
    with osmium.io.Reader(str(pbf)) as reader:snapshot=reader.header().get('osmosis_replication_timestamp')
    data={'roads':h.roads,'pois':h.pois,'blocked':h.blocked | (h.linear_barrier_nodes-h.passages),'restricted_ways':h.restricted_ways,
          'source':{'snapshotAt':snapshot,'url':'https://download.geofabrik.de/asia/'+pbf.name,'sha256':hashlib.file_digest(pbf.open('rb'),'sha256').hexdigest(),'geometryErrors':dict(h.errors),'linearBarrierNodes':len(h.linear_barrier_nodes),'explicitBarrierPassages':len(h.passages)}}
    with out.open('wb') as f:pickle.dump(data,f,pickle.HIGHEST_PROTOCOL)
    print(json.dumps({'roads':len(h.roads),'pois':len(h.pois),'barriersOrRestrictedNodes':len(data['blocked']),'restrictionMemberWays':len(h.restricted_ways),'source':data['source']},ensure_ascii=False),flush=True)


def filter_catalog(catalog,evidence):
    rows=json.loads(catalog.read_text())
    with evidence.open('rb') as f:data=pickle.load(f)
    kept,excluded,stats=assess(rows,data)
    if not kept:raise ValueError('Empty result; refusing to overwrite catalogue')
    m=json.loads((ROOT/'manifest.json').read_text());meta=json.loads((ROOT/'metadata.json').read_text());shards=[]
    for s in m['shards']:(ROOT/s['path']).unlink()
    for category in ('attraction','charging_station','parking','fuel_station'):
        group=[r for r in kept if r['category']==category]
        for i in range(0,len(group),5000):
            path=ROOT/f'{category}-{i//5000:03}.json';chunk=group[i:i+5000]
            path.write_text('[\n'+',\n'.join('  '+json.dumps(r,ensure_ascii=False,separators=(',',':')) for r in chunk)+'\n]\n')
            raw=path.read_bytes();shards.append({'path':path.name,'category':category,'count':len(chunk),'bytes':len(raw),'sha256':hashlib.sha256(raw).hexdigest()})
    m.update(format='z-ride-place-catalog-v3',count=len(kept),shards=shards,
        byCategory=dict(collections.Counter(r['category'] for r in kept)),byRegion=dict(collections.Counter(r['region'] for r in kept)),
        byDisplayCategory=dict(collections.Counter(r['displayCategory'] for r in kept)),byCarAccess=dict(collections.Counter(r['carAccess']['status'] for r in kept)),
        drivingFilter={'source':data['source'],'inputCount':len(rows),'retainedCount':len(kept),'excludedCount':len(excluded),
            'excludedByReason':dict(collections.Counter(excluded.values())),'methods':dict(collections.Counter(r['drivingAssessment']['method'] for r in kept)),
            'network':stats,'evidenceSha256':hashlib.file_digest(evidence.open('rb'),'sha256').hexdigest(),
            'inputSha256':hashlib.file_digest(catalog.open('rb'),'sha256').hexdigest(),'audit':'exclusions.json',
            'policy':'Shared car-road node or connected same-site parking. No distance-only snapping. Turn-restriction member ways, conditional/restricted access and barriers excluded. No live or field guarantee.'})
    meta.update(count=m['count'],by_category=m['byCategory'],by_region=m['byRegion'],by_display_category=m['byDisplayCategory'],by_car_access=m['byCarAccess'],
        unnamed=sum(r['unnamed'] for r in kept),export_format=m['format'],driving_filter=m['drivingFilter'])
    meta['fuel_source'].setdefault('unfiltered_count',meta['fuel_source']['count']);meta['fuel_source']['count']=m['byCategory'].get('fuel_station',0)
    legacy=meta.setdefault('legacy_unfiltered_statistics',{})
    for key in ('by_tag','skipped','source_extracted_count','quality_filter'):
        if key in meta:legacy[key]=meta.pop(key)
    meta['legacy_statistics_note']='legacy_unfiltered_statistics contains the original unfiltered extraction statistics; current counts describe the filtered catalogue.'
    meta['export_note']='v3 conservative road-network and same-site parking subset; drivingAssessment records the mapped arrival evidence.'
    meta['car_access_note']='carAccess is tag-only. drivingAssessment adds OSM car-network arrival/return evidence. No field verification or external navigation-engine validation was performed.'
    meta['coverage_note']='Conservative subset with mapped car-network and same-site arrival evidence. OSM completeness, live access and field conditions are not guaranteed. Excluded records remain in Git history only.'
    for name,obj in [('manifest.json',m),('metadata.json',meta),('sample.json',kept[:1]),('exclusions.json',[{'id':k,'reason':v} for k,v in sorted(excluded.items())])]:
        text=('[\n'+',\n'.join('  '+json.dumps(r,ensure_ascii=False,separators=(',',':')) for r in obj)+'\n]\n') if name=='exclusions.json' else json.dumps(obj,ensure_ascii=False,indent=2)+'\n'
        (ROOT/name).write_text(text)
    print(json.dumps(m['drivingFilter'],ensure_ascii=False,indent=2));print(m['byCategory']);print(m['byDisplayCategory'])


def main():
    ap=argparse.ArgumentParser();sub=ap.add_subparsers(dest='command',required=True)
    p=sub.add_parser('extract');p.add_argument('pbf',type=Path);p.add_argument('catalog',type=Path);p.add_argument('out',type=Path)
    p=sub.add_parser('filter');p.add_argument('catalog',type=Path);p.add_argument('evidence',type=Path)
    a=ap.parse_args()
    if a.command=='extract':extract(a.pbf,a.catalog,a.out)
    else:filter_catalog(a.catalog,a.evidence)

if __name__=='__main__':main()
