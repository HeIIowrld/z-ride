"""Validate the checked-in OSM catalogue with Python's standard library."""
import collections
import hashlib
import json
import math
import re
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1] / 'data' / 'places'


def check(condition, message):
    if not condition:
        raise ValueError(message)


def load_json(raw):
    def reject_constant(value):
        raise ValueError(f'Non-finite JSON constant: {value}')
    return json.loads(raw, parse_constant=reject_constant)


def main():
    manifest = load_json((ROOT / 'manifest.json').read_bytes())
    metadata = load_json((ROOT / 'metadata.json').read_bytes())
    schema = load_json((ROOT / 'schema.json').read_bytes())
    required = set(schema['items']['required'])
    check(manifest['license'] == metadata['license'] == 'ODbL-1.0', 'License mismatch')
    check(manifest['snapshotAt'] == metadata['snapshot_at'], 'Snapshot mismatch')
    seen, paths = set(), set()
    categories, regions = collections.Counter(), collections.Counter()
    display, access = collections.Counter(), collections.Counter()
    from importlib.util import spec_from_file_location, module_from_spec
    spec = spec_from_file_location("catalog_review", Path(__file__).with_name("review-place-catalog.py"))
    review = module_from_spec(spec); spec.loader.exec_module(review)
    check(manifest["format"] == metadata["export_format"] == "z-ride-place-catalog-v3", "Format mismatch")
    check(manifest["displayCategories"] == review.CATEGORIES and len(review.CATEGORIES) <= 10, "Display category cap")
    parking_ids, parking_references = set(), set()
    methods = collections.Counter()
    unnamed = 0
    for shard in manifest['shards']:
        path = Path(shard['path'])
        check(path.name == shard['path'] and path.suffix == '.json', 'Unsafe shard path')
        check(path.name not in paths, 'Duplicate shard path')
        paths.add(path.name)
        raw = (ROOT / path).read_bytes()
        check(len(raw) == shard['bytes'], f'{path}: byte count mismatch')
        check(hashlib.sha256(raw).hexdigest() == shard['sha256'], f'{path}: SHA-256 mismatch')
        rows = load_json(raw)
        check(isinstance(rows, list) and 0 < len(rows) <= 5000, f'{path}: invalid array')
        check(len(rows) == shard['count'], f'{path}: count mismatch')
        for row in rows:
            check(isinstance(row, dict) and set(row) == required, f'{path}: invalid fields')
            check(isinstance(row['id'], str) and re.fullmatch(r'(node|way|relation)/[1-9][0-9]*', row['id']), 'Invalid OSM ID')
            check(row['id'] not in seen, f'Duplicate ID: {row["id"]}')
            seen.add(row['id'])
            for field in ('name', 'region', 'address', 'osmModifiedAt', 'sourceUrl'):
                check(isinstance(row[field], str), f'Invalid {field}')
            check(row['name'].strip() and row['region'].strip(), 'Missing name or region')
            for field, bound in (('latitude', 90), ('longitude', 180)):
                value = row[field]
                check(type(value) in (int, float) and math.isfinite(value) and -bound <= value <= bound, f'Invalid {field}')
            check(row['category'] == shard['category'] and row['category'] in manifest['byCategory'], 'Category mismatch')
            check(row['theme'] in schema['items']['properties']['theme']['enum'], 'Unknown theme')
            check(type(row['unnamed']) is bool, 'Invalid unnamed flag')
            check(isinstance(row['facts'], dict) and all(isinstance(v, str) for v in row['facts'].values()), 'Invalid facts')
            check(row['sourceUrl'] == 'https://www.openstreetmap.org/' + row['id'], 'Source URL mismatch')
            check(datetime.fromisoformat(row['osmModifiedAt'].replace('Z', '+00:00')).utcoffset() is not None, 'Missing timestamp timezone')
            check(row['reviewStatus'] == 'pending' and row['gameEnabled'] is False, 'Unexpected game activation')
            tags = row['accessTags']
            check(set(tags) == {'snapshotAt','matched','tags'} and type(tags['matched']) is bool, 'Invalid access source')
            check(tags['snapshotAt'] == metadata['access_source']['snapshot_at'], 'Access snapshot mismatch')
            check(isinstance(tags['tags'], dict) and all(isinstance(v, str) for v in tags['tags'].values()), 'Invalid access tags')
            check(tags['matched'] or not tags['tags'], 'Unmatched source with tags')
            check(row['displayCategory'] in manifest['displayCategories'], 'Unknown display category')
            check(row['displayCategory'] == review.display_category(row), 'Display classification mismatch')
            check(row['carAccess'] == review.car_access(row), 'Access evidence mismatch')
            check(row['carAccess']['routeVerified'] is False, 'Unverified routing marked verified')
            proof=row['drivingAssessment']
            check(set(proof)==set(schema['items']['properties']['drivingAssessment']['required']), 'Invalid driving fields')
            check(proof['status']=='osm_network_connected' and proof['networkRoundTrip'] is True and proof['fieldVerified'] is False, 'Invalid driving evidence status')
            check(proof['method'] in schema['items']['properties']['drivingAssessment']['properties']['method']['enum'], 'Unknown arrival method')
            check(proof['snapshotAt']==manifest['drivingFilter']['source']['snapshotAt'], 'Driving source mismatch')
            for k in ('roadWayId','roadNodeId'):
                check(type(proof[k]) is int and proof[k]>0, 'Invalid road reference')
            arrival=proof['arrival']
            check(set(arrival)=={'latitude','longitude'}, 'Invalid arrival fields')
            for k,bound in (('latitude',90),('longitude',180)):
                check(type(arrival[k]) in (float,int) and math.isfinite(arrival[k]) and -bound<=arrival[k]<=bound, 'Invalid arrival coordinate')
            check(type(proof['poiToParkingDistanceM']) in (float,int) and 0<=proof['poiToParkingDistanceM']<=100, 'Invalid parking distance')
            check(row['facts'].get('natural') not in {'peak','saddle','cave_entrance','cliff','rock','bare_rock','spring','tree'}, 'Terrain retained')
            check(row['carAccess']['status']!='restricted_by_tag', 'Restricted facility retained')
            if row['category']=='parking': parking_ids.add(row['id'])
            if proof['method']=='connected_parking_same_site':
                check(isinstance(proof['parkingId'],str), 'Missing same-site parking')
                parking_references.add(proof['parkingId'])
            else: check(proof['parkingId'] is None, 'Unexpected parking reference')
            methods[proof['method']] += 1
            display[row['displayCategory']] += 1
            access[row['carAccess']['status']] += 1
            categories[row['category']] += 1
            regions[row['region']] += 1
            unnamed += row['unnamed']
    check(parking_references<=parking_ids, 'Missing retained parking reference')
    audit=load_json((ROOT/'exclusions.json').read_bytes())
    excluded_ids={r['id'] for r in audit}
    check(len(excluded_ids)==len(audit) and not excluded_ids&seen, 'Invalid exclusion IDs')
    filt=manifest['drivingFilter']
    check(filt==metadata['driving_filter'], 'Driving metadata mismatch')
    check(methods==filt['methods'], 'Driving evidence method totals mismatch')
    check(len(audit)==filt['excludedCount'] and len(seen)==filt['retainedCount'] and len(audit)+len(seen)==filt['inputCount'], 'Filtering totals mismatch')
    check(collections.Counter(r['reason'] for r in audit)==filt['excludedByReason'], 'Exclusion reason mismatch')
    check(len(seen) == manifest['count'] == metadata['count'], 'Total count mismatch')
    check(categories == manifest['byCategory'] == metadata['by_category'], 'Category totals mismatch')
    check(regions == manifest['byRegion'] == metadata['by_region'], 'Region totals mismatch')
    check(unnamed == metadata['unnamed'], 'Unnamed count mismatch')
    check(display == manifest['byDisplayCategory'] == metadata['by_display_category'], 'Display totals mismatch')
    check(access == manifest['byCarAccess'] == metadata['by_car_access'], 'Access totals mismatch')
    check(categories['fuel_station'] == metadata['fuel_source']['count'], 'Fuel provenance count mismatch')
    check({p.name for p in ROOT.glob('*-0*.json')} == paths, 'Unlisted or missing shard')
    sample = load_json((ROOT / 'sample.json').read_bytes())
    check(len(sample) == 1 and sample[0]['id'] in seen, 'Sample missing from catalogue')
    print(f'OK: {len(seen):,} OSM objects; {len(paths)} shards; {len(regions)} regions; {dict(categories)}')


if __name__ == '__main__':
    main()
