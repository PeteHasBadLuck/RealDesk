# Self-host RealDesk

RealDesk is designed to run on a company-controlled server. A browser-only GitHub Pages deployment is not a production deployment: login, database access, VoIP configuration and recording APIs require the backend.

## Requirements

- Linux server or compatible Docker host with Docker Engine and Docker Compose
- A domain name and HTTPS reverse proxy for public use
- A SIP/WebRTC provider or PBX configured for secure WebSocket signaling and WebRTC media
- Persistent, backed-up PostgreSQL volume
- Persistent encrypted recording storage (the Compose setup creates a dedicated volume; the hosted blueprint mounts a persistent disk)

## Start the stack

1. Copy `.env.example` to `.env`.
2. Replace all example secrets with strong, unique random values. Never commit `.env`.
3. For a TLS reverse proxy on the same host, bind the published port to localhost by changing the Compose mapping to `127.0.0.1:8080:80`.
4. Run:

```sh
docker compose up --build -d
docker compose ps
docker compose logs -f api
```

5. Visit `http://localhost:8080` on the host, or use your HTTPS domain when a reverse proxy is configured. The dedicated portals are `/admin.html` and `/agent.html`; successful login redirects users according to their role.
6. Optional seed settings create an initial OWNER user on first startup. If they are blank, no login account is created. Never use example passwords.

The current container runs Prisma schema synchronization at startup for this early stage. Before production upgrades, review schema changes and implement a controlled migration/backup/rollback process.

## Security setup

- Do not expose PostgreSQL or port 3001 directly to the internet.
- Use HTTPS. Browser microphone access and WebRTC generally require a secure context except on localhost.
- Keep secrets outside source control. Losing `VOIP_ENCRYPTION_KEY` makes stored VoIP passwords unrecoverable.
- Prefer individual SIP extensions/credentials per agent. Shared company credentials can cause registration conflicts and weaken call attribution.
- Configure TLS, firewall rules, secure SIP/WSS, and any required STUN/TURN media services.
- Set retention rules for contacts, call metadata and recordings; restrict playback to authorized roles and log access.
- Validate recording consent and applicable laws before recording. Requirements differ by jurisdiction and call participants' locations.
- Do not use this initial version with real customer data until authentication, telephony and storage have been security-reviewed.

## Current implementation boundary

The repository includes a React web application, Fastify API, PostgreSQL data model, login and roles, contact CRUD/CSV import, campaigns, call records and dispositions, encrypted-at-rest VoIP credentials, and admin screens.

Outbound SIP-over-WebSocket/WebRTC calling and consent-gated mixed audio capture are wired into the agent UI, but the integration must be validated against your specific PBX/provider. Inbound-call handling, retention/deletion automation, provider-specific edge cases and a production security review remain incomplete. Recording files are AES-256-GCM encrypted on persistent storage and playback is role-checked; verify that both call participants are captured before relying on recordings.
## Deploy online without installing anything locally

The repository includes `render.yaml` for a hosted deployment. On a device with a browser:

1. Open Render and connect the GitHub repository `PeteHasBadLuck/RealDesk`.
2. Choose **New → Blueprint** and select this repository.
3. Review the services and database in `render.yaml`, then deploy the blueprint. The hosted database and persistent recording disk may require a paid plan; check the provider's current pricing before confirming.
4. In the API service's environment settings, set `SEED_ADMIN_EMAIL` to your real administrator email and set `SEED_ADMIN_PASSWORD` to a unique password of at least 14 characters. Trigger a redeploy so the first administrator can be created.
5. Open the frontend service URL and sign in.
6. Configure a compatible SIP/WebRTC provider in **VoIP settings**. Use a secure `wss://` WebSocket URL and a PBX/provider configured for browser WebRTC audio. A provider account that only offers traditional SIP credentials without WebSocket/WebRTC support will not work directly from the browser.

Hosted deployment requires configuring the environment variables and provider, but does not require installing developer tools on your personal computer. The application is still under active development and should not be used with real customer data until the outstanding telephony, security, and legal checks are complete.


## Hosting costs and limitations

The Render blueprint separates the API and web front end and requests persistent disk storage for recordings. Render may require paid web-service/disk plans for this setup; review the resource plan and charges in Render before pressing Deploy. The sample database plan is intended for evaluation only and should be upgraded to a durable paid database before real customer data is used. No service has been deployed to your Render account by this repository change alone.
