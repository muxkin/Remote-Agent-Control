#!/usr/bin/env python3
"""Exercise Lago with temporary, zero-price deployment-check records.

Run on the server after seeding. Reads credentials locally, never prints tokens.
No payment provider, email address, or real customer is attached to test records.
"""
import argparse
import json
import secrets
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

parser = argparse.ArgumentParser()
parser.add_argument('--directory', type=Path, default=Path('/opt/lago'))
parser.add_argument('--base-url', default='http://127.0.0.1:13000')
args = parser.parse_args()
settings = dict(line.split('=', 1) for line in (args.directory / '.env').read_text().splitlines() if '=' in line and not line.startswith('#'))
results = {}


def request(method, path, body=None, authenticated=True):
    headers = {'Content-Type': 'application/json', 'User-Agent': 'Pocket-Lago-Deployment-Check/1.0'}
    if authenticated:
        headers['Authorization'] = 'Bearer ' + settings['LAGO_ORG_API_KEY']
    req = Request(args.base_url + path, data=None if body is None else json.dumps(body).encode(), headers=headers, method=method)
    try:
        with urlopen(req, timeout=60) as response:
            raw = response.read()
            return response.status, json.loads(raw) if raw else {}
    except HTTPError as error:
        raw = error.read()
        try:
            data = json.loads(raw) if raw else {}
        except json.JSONDecodeError:
            data = {'code': 'non_json_response'}
        return error.code, data


def check(label, method, path, body=None):
    status, data = request(method, path, body)
    if status not in (200, 201, 204):
        raise RuntimeError(f'{label}: HTTP {status}, code={data.get("code")}, details={data.get("error_details")}')
    results[label] = True
    return data


code = 'deployment-check-' + secrets.token_hex(5)
created = set()
try:
    status, _ = request('GET', '/api/v1/customers', authenticated=False)
    assert status == 401, f'Unauthenticated API returned {status}'
    results['unauthenticated_api_rejected'] = True
    _, signup = request('POST', '/graphql', {'query': 'mutation($input:RegisterUserInput!){registerUser(input:$input){token}}', 'variables': {'input': {'email': code + '@example.invalid', 'password': secrets.token_urlsafe(32), 'organizationName': code}}}, authenticated=False)
    assert 'signup_disabled' in json.dumps(signup), 'Public signup was not explicitly rejected'
    results['signup_disabled'] = True
    check('feature_create', 'POST', '/api/v1/features', {'feature': {'code': code, 'name': 'Temporary deployment check', 'privileges': [{'code': 'max_bytes', 'value_type': 'integer'}]}})
    created.add('feature')
    check('plan_create', 'POST', '/api/v1/plans', {'plan': {'code': code, 'name': 'Temporary deployment check', 'interval': 'monthly', 'amount_cents': 0, 'amount_currency': 'USD', 'pay_in_advance': False}})
    created.add('plan')
    check('plan_entitlement_assign', 'POST', f'/api/v1/plans/{code}/entitlements', {'entitlements': {code: {'max_bytes': 262144000}}})
    check('customer_create', 'POST', '/api/v1/customers', {'customer': {'external_id': code, 'name': 'Temporary deployment check', 'currency': 'USD', 'timezone': 'Asia/Shanghai'}})
    created.add('customer')
    sub = check('subscription_create', 'POST', '/api/v1/subscriptions', {'subscription': {'external_customer_id': code, 'external_id': code, 'plan_code': code}})
    created.add('subscription')
    assert sub['subscription']['status'] == 'active'
    entitlements = check('subscription_entitlement_read', 'GET', f'/api/v1/subscriptions/{code}/entitlements')['entitlements']
    assert entitlements[0]['privileges'][0]['value'] == 262144000
    check('subscription_entitlement_override', 'PATCH', f'/api/v1/subscriptions/{code}/entitlements', {'entitlements': {code: {'max_bytes': 524288000}}})
    entitlements = check('subscription_override_read', 'GET', f'/api/v1/subscriptions/{code}/entitlements')['entitlements']
    assert entitlements[0]['privileges'][0]['value'] == 524288000
finally:
    for kind, path in [('subscription', f'/api/v1/subscriptions/{code}?on_termination_credit_note=skip&on_termination_invoice=skip'), ('customer', f'/api/v1/customers/{code}'), ('plan', f'/api/v1/plans/{code}'), ('feature', f'/api/v1/features/{code}')]:
        if kind in created:
            check('cleanup_' + kind, 'DELETE', path)
    (args.directory / 'api-verification.json').write_text(json.dumps(results, indent=2) + '\n')
    print(json.dumps(results, indent=2))
