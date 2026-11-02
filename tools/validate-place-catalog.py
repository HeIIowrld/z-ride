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
            categories[row['category']] += 1
            regions[row['region']] += 1
            unnamed += row['unnamed']
    check(len(seen) == manifest['count'] == metadata['count'], 'Total count mismatch')
    check(categories == manifest['byCategory'] == metadata['by_category'], 'Category totals mismatch')
    check(regions == manifest['byRegion'] == metadata['by_region'], 'Region totals mismatch')
    check(unnamed == metadata['unnamed'], 'Unnamed count mismatch')
    check({p.name for p in ROOT.glob('*-0*.json')} == paths, 'Unlisted or missing shard')
    sample = load_json((ROOT / 'sample.json').read_bytes())
    check(len(sample) == 1 and sample[0]['id'] in seen, 'Sample missing from catalogue')
    print(f'OK: {len(seen):,} OSM objects; {len(paths)} shards; {len(regions)} regions; {dict(categories)}')


if __name__ == '__main__':
    main()
