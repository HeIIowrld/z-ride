"""Upgrade the catalogue with bounded display categories and conservative car-access evidence.

Run from the repo: python3 tools/review-place-catalog.py --fuel /path/to/extracted-pois.json
Input is produced by extract-driving-pois.py from a Geofabrik South Korea PBF.
"""
import argparse
import collections
import hashlib
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1] / 'data' / 'places'
CATEGORIES = {
    'nature': '산·숲·자연', 'waterfront': '바다·물가', 'heritage': '역사·유적',
    'culture': '문화·전시', 'leisure': '공원·레저', 'religion': '종교시설',
    'attraction': '기타 명소', 'parking': '주차장',
    'charging_station': '전기차 충전소', 'fuel_station': '주유소·가스충전소',
}


def display_category(row):
    if row['category'] != 'attraction':
        return row['category']
    f = row['facts']
    if f.get('amenity') == 'place_of_worship': return 'religion'
    if f.get('historic'): return 'heritage'
    if f.get('tourism') in ('museum', 'gallery', 'artwork') or f.get('amenity') in ('arts_centre', 'theatre', 'exhibition_centre', 'museum'): return 'culture'
    if f.get('natural') in ('beach', 'water', 'wetland', 'hot_spring', 'spring', 'cape', 'shingle'): return 'waterfront'
    if f.get('leisure') or f.get('tourism') in ('camp_site', 'caravan_site', 'picnic_site', 'theme_park', 'zoo', 'aquarium'): return 'leisure'
    if f.get('natural'): return 'nature'
    return 'attraction'


def car_access(row):
    complete = row.get('accessTags', {}).get('matched', False)
    f = row['accessTags']['tags'] if complete else row['facts']
    # The legacy export omitted mode-specific access tags. Never assert permission
    # from generic access=yes or from a car-oriented facility's existence.
    evidence = {k: v for k, v in f.items() if k in ('access', 'vehicle', 'motor_vehicle', 'motorcar', 'parking') or k.endswith(':conditional') or k.startswith('motorcar:')}
    status, reason = 'unknown', 'no_motorcar_permission_or_route_evidence'
    if complete:
        if any(k in f for k in ('access:conditional', 'vehicle:conditional', 'motor_vehicle:conditional', 'motorcar:conditional', 'motorcar:forward', 'motorcar:backward')):
            reason = 'conditional_access_requires_review'
        else:
            for key in ('motorcar', 'motor_vehicle', 'vehicle', 'access'):
                if key not in f: continue
                value = f[key]
                if value in ('no', 'private', 'permit', 'customers', 'destination', 'employees', 'residents', 'military', 'delivery', 'agricultural', 'forestry'):
                    status, reason = 'restricted_by_tag', key + '=' + value
                elif key != 'access' and value in ('yes', 'designated', 'permissive'):
                    status, reason = 'allowed_by_tag', key + '=' + value
                break
    elif f.get('access') in ('no', 'private', 'permit', 'customers', 'destination', 'employees', 'residents', 'military'):
        reason = 'generic_access_restriction_specific_vehicle_tags_not_exported'
    elif row['facts'].get('natural') in ('peak', 'saddle', 'cave_entrance', 'cliff', 'rock', 'bare_rock'):
        reason = 'terrain_poi_requires_separate_vehicle_entrance'
    if status == 'unknown' and reason == 'no_motorcar_permission_or_route_evidence' and row['facts'].get('natural') in ('peak', 'saddle', 'cave_entrance', 'cliff', 'rock', 'bare_rock'):
        reason = 'terrain_poi_requires_separate_vehicle_entrance'
    return {'status': status, 'reason': reason, 'evidence': evidence, 'routeVerified': False}


def write_json(path, data):
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n')


def main():
    ap = argparse.ArgumentParser(); ap.add_argument('--fuel', type=Path, required=True); args = ap.parse_args()
    manifest = json.loads((ROOT/'manifest.json').read_text())
    if manifest['format'] not in ('z-ride-place-catalog-v1','z-ride-place-catalog-v2'):
        raise ValueError('Restore the unfiltered catalogue before rebuilding v2; v3 is a filtered subset')
    metadata = json.loads((ROOT/'metadata.json').read_text())
    rows = [r for s in manifest['shards'] if s['category'] != 'fuel_station' for r in json.loads((ROOT/s['path']).read_text())]
    fuel_raw = args.fuel.read_bytes(); payload = json.loads(fuel_raw)
    if payload.get('remark'): raise ValueError('Incomplete Overpass response: '+payload['remark'])
    if not payload.get('elements'): raise ValueError('Empty fuel response')
    fuel_rows = []; skipped = collections.Counter()
    for obj in payload['elements']:
        t = obj.get('tags', {})
        if t.get('amenity') != 'fuel': raise ValueError('Unexpected feature')
        if any(t.get(k) in ('yes', 'fuel') for k in ('disused', 'abandoned', 'demolished', 'disused:amenity', 'abandoned:amenity', 'demolished:amenity')):
            skipped['inactive'] += 1; continue
        if t.get('boat') == 'yes' and t.get('motorcar') == 'no': skipped['marine_only'] += 1; continue
        point = obj if obj['type'] == 'node' else obj.get('center', {})
        if 'lat' not in point or 'lon' not in point: raise ValueError('Missing location')
        oid = f"{obj['type']}/{obj['id']}"
        name = t.get('name:ko') or t.get('name')
        if name and re.search(r'폐업|영업.?종료|폐쇄|철거|\b(closed|disused|abandoned)\b', name, re.I):
            skipped['closed_name'] += 1; continue
        facts = {k:v for k,v in t.items() if k in ('amenity','access','vehicle','motor_vehicle','motorcar','brand','operator','opening_hours','self_service','maxheight','boat') or k.startswith(('fuel:', 'access:', 'vehicle:', 'motor_vehicle:', 'motorcar:'))}
        facts['location_basis'] = 'osm_node' if obj['type'] == 'node' else obj['location_basis']
        fuel_rows.append({'id':oid, 'name':name or '이름 미등록 주유소', 'category':'fuel_station',
            'latitude':point['lat'], 'longitude':point['lon'],
            'region':obj['region'],
            'address':t.get('addr:full') or ' '.join(t[k] for k in ('addr:city','addr:district','addr:street','addr:housenumber') if k in t),
            'theme':'supply', 'facts':facts, 'unnamed':not bool(name), 'osmModifiedAt':obj['timestamp'],
            'sourceUrl':'https://www.openstreetmap.org/'+oid, 'reviewStatus':'pending', 'gameEnabled':False})
    fuel_ids = {r['id'] for r in fuel_rows}
    reassigned = sum(r['id'] in fuel_ids for r in rows)
    rows = [r for r in rows if r['id'] not in fuel_ids] + fuel_rows
    if len({r['id'] for r in rows}) != len(rows): raise ValueError('Duplicate IDs')
    for r in rows:
        source_tags = payload['accessById'].get(r['id']) if r['category'] != 'fuel_station' else {k:v for k,v in r['facts'].items() if k in ('access','vehicle','motor_vehicle','motorcar') or k.endswith(':conditional') or k.startswith('motorcar:')}
        r['accessTags'] = {'snapshotAt':payload['osm3s']['timestamp_osm_base'], 'matched':source_tags is not None, 'tags':source_tags or {}}
        r['displayCategory'] = display_category(r); r['carAccess'] = car_access(r)
    shards=[]
    for category in ('attraction','charging_station','parking','fuel_station'):
        group=[r for r in rows if r['category']==category]
        for i in range(0,len(group),5000):
            path=ROOT/f'{category}-{i//5000:03}.json'
            # Keep compact rows to preserve readable 5k-line shards.
            path.write_text('[\n'+',\n'.join('  '+json.dumps(r,ensure_ascii=False,separators=(',',':')) for r in group[i:i+5000])+'\n]\n')
            raw=path.read_bytes(); shards.append({'path':path.name,'category':category,'count':len(group[i:i+5000]),'bytes':len(raw),'sha256':hashlib.sha256(raw).hexdigest()})
    manifest.update(snapshots={'legacyPlaces':manifest['snapshotAt'], 'fuelAndAccess':payload['osm3s']['timestamp_osm_base']},format='z-ride-place-catalog-v2',count=len(rows),shards=shards,
        byCategory=dict(collections.Counter(r['category'] for r in rows)),byRegion=dict(collections.Counter(r['region'] for r in rows)),
        displayCategories=CATEGORIES,byDisplayCategory=dict(collections.Counter(r['displayCategory'] for r in rows)),
        byCarAccess=dict(collections.Counter(r['carAccess']['status'] for r in rows)))
    metadata.update(count=manifest['count'],by_category=manifest['byCategory'],by_region=manifest['byRegion'],unnamed=sum(r['unnamed'] for r in rows),
        export_format=manifest['format'],by_display_category=manifest['byDisplayCategory'],by_car_access=manifest['byCarAccess'])
    metadata['fuel_source'] = {**payload['source'], 'snapshot_at':payload['osm3s']['timestamp_osm_base'],
        'response_sha256':hashlib.sha256(fuel_raw).hexdigest(), 'count':len(fuel_rows), 'reassigned_original_ids':reassigned, 'skipped':dict(skipped),
        'license':'ODbL-1.0', 'note':'Fuel POIs scoped by Korean province polygons. Polygon representative points are not vehicle entrances. Not a complete or live operational inventory.'}
    metadata['access_source'] = {**payload['source'], 'snapshot_at':payload['osm3s']['timestamp_osm_base'],
        'matched_original_ids':len(payload['accessById']), 'note':'Current tags joined by OSM ID; original geometry and descriptive tags retain their original snapshot.'}
    metadata['car_access_note']='accessTags preserves current mode-specific tags including conditional restrictions. Generic access=yes does not confirm motorcar permission. No record has route or entrance verification. allowed_by_tag is not a routing guarantee.'
    metadata['coverage_note']='Original OSM attractions/parking/charging plus fuel POIs selected from Korean province polygons. Not a complete inventory. POI coordinates are not entrances or driving-route endpoints. Different snapshots and regional boundaries are documented per source.'
    metadata['legacy_statistics_note']='by_tag, province_polygons, source_extracted_count, quality_filter and skipped describe the original v1 snapshot only; fuel and access enrichment have separate source metadata.'
    write_json(ROOT/'manifest.json',manifest);write_json(ROOT/'metadata.json',metadata)
    sample=json.loads((ROOT/'sample.json').read_text());byid={r['id']:r for r in rows};write_json(ROOT/'sample.json',[byid[r['id']] for r in sample])
    print(json.dumps({'count':len(rows),'display':manifest['byDisplayCategory'],'carAccess':manifest['byCarAccess'],'fuel':len(fuel_rows)},ensure_ascii=False,indent=2))


if __name__=='__main__':main()
