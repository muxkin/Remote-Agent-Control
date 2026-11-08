#!/usr/bin/env python3
"""Generate private deployment credentials once; never print secret values."""
import argparse
import base64
import json
import os
from pathlib import Path
import secrets
import subprocess
from urllib.parse import urlsplit


def origin(value):
    try:
        parsed = urlsplit(value)
        port = parsed.port
        valid = (parsed.scheme == 'https' and parsed.hostname and not parsed.username
                 and not parsed.password and parsed.path in ('', '/')
                 and not parsed.query and not parsed.fragment
                 and not any(c.isspace() or c in '\"\'`$\\#' for c in value)
                 and (port is None or port > 0))
    except ValueError:
        valid = False
    if not valid:
        raise argparse.ArgumentTypeError('Use an HTTPS origin without credentials, path or query.')
    return value.rstrip('/')

parser = argparse.ArgumentParser()
parser.add_argument('--directory', type=Path, default=Path('/opt/lago'))
parser.add_argument('--admin-email', required=True)
parser.add_argument('--api-url', required=True, type=origin)
parser.add_argument('--front-url', required=True, type=origin)
parser.add_argument('--organization', default='Pocket Remote')
args = parser.parse_args()
if '@' not in args.admin_email or any(c in args.admin_email for c in '\n\r\"\' $`\\'):
    parser.error('Provide a plain email address for the administrator login.')
if not args.organization.strip() or any(c in args.organization for c in '\n\r\t\"\'$`\\#'):
    parser.error('Provide a plain organization name without control characters or environment syntax.')

os.umask(0o077)
args.directory.mkdir(mode=0o700, parents=True, exist_ok=True)
env_path = args.directory / '.env'
credentials_path = args.directory / 'admin-credentials.json'
if env_path.exists() or credentials_path.exists():
    raise SystemExit('Existing credentials found; refusing to replace them.')

private_key = subprocess.run(
    ['openssl', 'genpkey', '-algorithm', 'RSA', '-pkeyopt', 'rsa_keygen_bits:2048'],
    check=True, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
).stdout
password = 'Aa1!' + secrets.token_urlsafe(32)
settings = {
    'LAGO_API_URL': args.api_url,
    'LAGO_FRONT_URL': args.front_url,
    'LAGO_ORG_NAME': args.organization.strip(),
    'LAGO_ORG_USER_EMAIL': args.admin_email,
    'LAGO_ORG_USER_PASSWORD': password,
    'LAGO_ORG_API_KEY': secrets.token_hex(32),
    'POSTGRES_PASSWORD': secrets.token_hex(32),
    'REDIS_PASSWORD': secrets.token_hex(32),
    'SECRET_KEY_BASE': secrets.token_hex(64),
    'LAGO_ENCRYPTION_PRIMARY_KEY': secrets.token_hex(32),
    'LAGO_ENCRYPTION_DETERMINISTIC_KEY': secrets.token_hex(32),
    'LAGO_ENCRYPTION_KEY_DERIVATION_SALT': secrets.token_hex(32),
    'LAGO_RSA_PRIVATE_KEY': base64.b64encode(private_key).decode(),
    'LAGO_LICENSE': '',
}
with env_path.open('x') as file:
    file.write(''.join(f'{key}={value}\n' for key, value in settings.items()))
with credentials_path.open('x') as file:
    json.dump({'url': settings['LAGO_FRONT_URL'], 'email': args.admin_email, 'password': password}, file, indent=2)
    file.write('\n')
print(f'Credentials generated privately under {args.directory}; no values printed.')
