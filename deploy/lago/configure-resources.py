#!/usr/bin/env python3
"""Create initial resource plans. Existing plans/entitlements are never overwritten.

After initialization, Lago's administrator UI is the source of policy values.
Zero-price internal plans enable entitlements only; payment is not configured.
"""
import argparse
import json
from pathlib import Path
from urllib.request import Request, urlopen
from urllib.error import HTTPError

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--directory', type=Path, default=Path('/opt/lago'))
parser.add_argument('--base-url', default='http://127.0.0.1:13000')
args = parser.parse_args()
root = args.directory
env = dict(line.split('=', 1) for line in (root / '.env').read_text().splitlines() if '=' in line)
config = json.loads((root / 'resource-plans.json').read_text())
features = json.loads((root / 'features.json').read_text())['features']


def request(path, data=None):
    req = Request(args.base_url.rstrip('/') + '/api/v1' + path,
                  headers={'Authorization': 'Bearer ' + env['LAGO_ORG_API_KEY'], 'Content-Type': 'application/json'},
                  data=None if data is None else json.dumps(data).encode())
    try:
        with urlopen(req, timeout=30) as response:
            return json.load(response)
    except HTTPError as error:
        if error.code == 404:
            return None
        raise RuntimeError(f'Lago returned HTTP {error.code}') from None


for feature in features:
    if not request('/features/' + feature['code']):
        request('/features', {'feature': feature})

if not request('/features/relay'):
    request('/features', {'feature': {'code': 'relay', 'name': '月中转流量', 'privileges': [
        {'code': 'max_bytes', 'name': '自然月流量上限（字节）', 'value_type': 'integer'},
        {'code': 'time_zone', 'name': '自然月时区', 'value_type': 'string'}]}})

for plan in config['plans']:
    if not request('/plans/' + plan['code']):
        request('/plans', {'plan': {'code': plan['code'], 'name': plan['name'], 'interval': 'monthly',
                                   'amount_cents': 0, 'amount_currency': 'USD', 'pay_in_advance': False,
                                   'description': 'Internal resource entitlement plan. No public checkout or payment collection.'}})
    existing = request('/plans/' + plan['code'] + '/entitlements')
    if not existing['entitlements']:
        request('/plans/' + plan['code'] + '/entitlements', {'entitlements': {
            'storage': {'max_bytes': plan['storageBytes']},
            'relay': {'max_bytes': plan['relayBytes'], 'time_zone': config['timeZone']}}})
    print(json.dumps({'plan': plan['code'], 'entitlements': request('/plans/' + plan['code'] + '/entitlements')['entitlements']}, ensure_ascii=False))
