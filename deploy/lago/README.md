# Optional Lago deployment

This package provides a self-hosted Lago v1.57.0 stack and initial resource entitlement plans for Remote-Agent-Control. Both Node and Cloudflare use the same optional provider; see [resource policies](../../docs/RESOURCE_LIMITS.md). It does not configure payment collection or merge application accounts with Lago administrator accounts.

## Installation

Use a Linux host with Docker Compose v2 and a TLS reverse proxy. Run `python3 preflight.py` before pulling images; it checks CPU, memory, free disk and loopback port availability. The stack includes PostgreSQL, Redis, migrations, API, workers, scheduler, frontend and PDF renderer. API/frontend bind to loopback; database, Redis and PDF ports are not published.

These templates are for a new installation. Preserve the existing Compose project, volume names, credentials and image digests when upgrading an existing deployment. Never replace its environment file with newly generated credentials.

1. Copy this directory to `/opt/lago`, restrict access to that directory, and generate credentials once:

   ```bash
   python3 init-env.py --directory /opt/lago \
     --admin-email admin@example.com \
     --api-url https://billing-api.example.com \
     --front-url https://billing.example.com \
     --organization 'Pocket Remote'
   ```

   Use your own domains and login email. This creates private `.env` and `admin-credentials.json` files, refuses to overwrite existing credentials, and does not print secrets. SMTP is configured separately.

2. Run `docker compose config --quiet`. Pull the image versions, record their resolved digests in private deployment notes and pin those digests in your deployed configuration. Start `db` and `redis`, run `docker compose run --rm migrate`, then start `api`, `worker`, `clock`, `front` and `pdf`. Wait for migrations and administrator creation before exposing either public domain. Public organization signup and the Sidekiq web console are disabled.

3. Configure HTTPS for your two domains. When using Cloudflare orange-cloud DNS, use Full (strict) with a valid origin certificate. Choose one reverse-proxy arrangement:

   - **Host Nginx:** replace the example domains in `nginx.conf`. Obtain the certificate first using an HTTP-only ACME challenge configuration; the HTTPS example expects `/etc/letsencrypt/live/lago/`. API/frontend listen at `127.0.0.1:13000` and `127.0.0.1:18080`. Configure certificate renewal and reload.
   - **Containerized Caddy:** copy `compose.proxy.yaml` to the private `compose.override.yaml`, set `LAGO_PROXY_NETWORK` to the existing proxy network, and replace the domains in `Caddyfile`. Attach Caddy to that network. The API and frontend have dedicated aliases; database/Redis remain private. Validate and reload the existing proxy while preserving its other sites.

4. Sign in, configure the billing entity, currency and timezone, then run `python3 verify-api.py`. It creates zero-price temporary records, checks feature/plan/subscription entitlements and overrides, then removes them. It does not test paid charging. Check API/worker health, browser login, disabled signup, TLS and PDF rendering on your own deployment.

5. Run `python3 configure-resources.py` to create missing features and initial plans from `features.json` and `resource-plans.json`. Existing entitlements are preserved. Later changes belong in the Lago console; the application assigns only the configured default plan. See [resource policy operations](../../docs/RESOURCE_LIMITS.md) before enabling it on an application instance.

6. Make `backup.sh` executable and install `lago-backup.service` / `lago-backup.timer` under `/etc/systemd/system/`. Enable the timer, run an initial backup and validate a restore in an isolated environment. The timer runs at 03:45 UTC with up to 15 minutes jitter and keeps 14 days of local backups.

Do not run `docker compose down -v` on an existing installation: it removes persistent volumes. Host-specific overrides, credentials, verification output and backups remain private; they are not source files to publish.

## Backups

The private `.env` contains database/Redis credentials, encryption and signing keys, the initial administrator password and API key. The backup script saves it with PostgreSQL, Redis RDB state, local invoice/export files and deployed configuration under `/opt/lago/backups`. Queue, database and file copies are not a globally atomic snapshot. Restore to an isolated environment and reconcile jobs before enabling a payment provider. Configure an off-server backup destination separately.

Lago invoice files are separate from users' encrypted application attachments. Resource enforcement does not remove existing files when an account exceeds its allowance; users can download decrypted copies and clean up through the application.

## Edition and scope

The stack uses official public images. `LAGO_LICENSE` stays empty unless the owner supplies a valid commercial license; no license checks are modified. Feature availability depends on the installed Lago version and edition. Validate the entitlement endpoints used by this integration using `verify-api.py` before enabling resource enforcement. Payment providers, taxes, SMTP and automatic charging need separate configuration.

- [Official Compose at v1.57.0](https://github.com/getlago/lago/blob/v1.57.0/docker-compose.yml)
- [Self-hosted editions](https://getlago.com/docs/guide/lago-self-hosted/overview)
- [Entitlements](https://getlago.com/docs/guide/entitlements)
- [Docker deployment](https://getlago.com/docs/guide/lago-self-hosted/docker)
