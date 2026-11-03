"""Extract fuel POIs, car-access tags and province evidence from a Geofabrik PBF.

Requires osmium and shapely. Output is a local intermediate, not a public export.
Usage: python3 tools/extract-driving-pois.py korea.osm.pbf output.json
"""
import hashlib
import json
import sys
from pathlib import Path
import osmium
from shapely import wkb
from shapely.geometry import Point
from shapely.prepared import prep

PROVINCES = {'서울특별시','부산광역시','대구광역시','인천광역시','광주광역시','대전광역시','울산광역시','세종특별자치시','경기도','강원도','강원특별자치도','충청북도','충청남도','전라북도','전북특별자치도','전라남도','전남광주통합특별시','경상북도','경상남도','제주특별자치도'}
ACCESS = {'access','vehicle','motor_vehicle','motorcar','access:conditional','vehicle:conditional','motor_vehicle:conditional','motorcar:conditional','motorcar:forward','motorcar:backward'}

class Extract(osmium.SimpleHandler):
    def __init__(self, ids):
        super().__init__(); self.ids=ids;self.fuel={};self.access={};self.regions=[];self.factory=osmium.geom.WKBFactory();self.errors=[]
    def tags(self, obj, kind):
        oid=f'{kind}/{obj.id}'
        if oid not in self.ids and obj.tags.get('amenity') != 'fuel': return {}
        t=dict(obj.tags)
        if oid in self.ids:self.access[oid]={k:v for k,v in t.items() if k in ACCESS}
        return t
    def node(self,n):
        t=self.tags(n,'node')
        if t.get('amenity')=='fuel':self.fuel[f'node/{n.id}']={'type':'node','id':n.id,'lat':n.location.lat,'lon':n.location.lon,'timestamp':n.timestamp.isoformat(),'tags':t}
    def way(self,w):
        t=self.tags(w,'way')
        if t.get('amenity')=='fuel' and not w.is_closed():
            points=[(n.lon,n.lat) for n in w.nodes];p=points[len(points)//2]
            self.fuel[f'way/{w.id}']={'type':'way','id':w.id,'center':{'lat':p[1],'lon':p[0]},'timestamp':w.timestamp.isoformat(),'tags':t,'location_basis':'osm_way_mid_node'}
    def relation(self,r):self.tags(r,'relation')
    def area(self,a):
        if a.tags.get('amenity') != 'fuel' and a.tags.get('boundary') != 'administrative': return
        t=dict(a.tags); name=t.get('name:ko') or t.get('name','')
        is_region=t.get('boundary')=='administrative' and t.get('admin_level')=='4' and name in PROVINCES
        if t.get('amenity')!='fuel' and not is_region:return
        try: poly=wkb.loads(self.factory.create_multipolygon(a),hex=True)
        except Exception as e:
            self.errors.append({'id':a.orig_id(),'error':type(e).__name__});return
        if is_region:self.regions.append((name,prep(poly)));return
        kind='way' if a.from_way() else 'relation';p=poly.representative_point()
        self.fuel[f'{kind}/{a.orig_id()}']={'type':kind,'id':a.orig_id(),'center':{'lat':p.y,'lon':p.x},'timestamp':a.timestamp.isoformat(),'tags':t,'location_basis':'osm_polygon_representative_point'}


def main():
    pbf,out=map(Path,sys.argv[1:]);root=Path(__file__).resolve().parents[1]/'data/places';m=json.loads((root/'manifest.json').read_text());ids={r['id'] for s in m['shards'] if s['category']!='fuel_station' for r in json.loads((root/s['path']).read_text())}
    h=Extract(ids);h.apply_file(str(pbf),locations=True,idx='flex_mem',filters=[osmium.filter.EmptyTagFilter()])
    if not h.regions:raise ValueError('No KR province polygons; cannot scope fuel records')
    elements=[];outside=0
    for obj in h.fuel.values():
        loc=obj if obj['type']=='node' else obj['center'];p=Point(loc['lon'],loc['lat'])
        region=next((name for name,poly in h.regions if poly.covers(p)),None)
        if not region:outside+=1;continue
        obj['region']=region;elements.append(obj)
    with osmium.io.Reader(str(pbf)) as reader: snapshot=reader.header().get('osmosis_replication_timestamp')
    payload={'osm3s':{'timestamp_osm_base':snapshot},'elements':elements,'accessById':h.access,
        'source':{'url':'https://download.geofabrik.de/asia/'+pbf.name,'pbf_sha256':hashlib.file_digest(pbf.open('rb'),'sha256').hexdigest(),'pbf_bytes':pbf.stat().st_size,
        'region_polygons':len(h.regions),'fuel_outside_region_polygons':outside,'geometry_errors':h.errors}}
    out.write_text(json.dumps(payload,ensure_ascii=False)+'\n');print({'fuel':len(elements),'matched_original_ids':len(h.access),'regions':len(h.regions),'outside':outside,'errors':len(h.errors),'snapshot':snapshot})

if __name__=='__main__':main()
