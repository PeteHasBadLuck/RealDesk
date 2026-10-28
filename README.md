# RealDesk

RealDesk is an open-source, self-hosted contact-center application inspired by modern agent workspaces. It is being developed as two distinct role-based workspaces backed by one API and database.

## Product workspaces

### Admin / supervisor
- Company user accounts and roles
- Campaign creation and contact-list management
- VoIP configuration form with encrypted-at-rest credentials
- Call history, dispositions, reporting and audit events
- Call recording list and playback for authorized roles, using encrypted persistent files; retention controls still need completing

### Call agent
- Sign-in and role-based workspace
- Contact search, add/edit, CSV import and export
- SIP phone registration, incoming call answer/reject, and outbound calling through JsSIP/WebRTC
- Call record creation and mandatory ending-reason workflow
- Callback, interest, no-answer, wrong-number, sale and do-not-call dispositions
- Agent-scoped call history

## Stack

- Web: React, TypeScript, Vite, Nginx
- API: Fastify, TypeScript, JWT authentication, Zod validation
- Data: PostgreSQL + Prisma
- Deployment: Docker Compose; Render blueprint included as an online hosting option

## Deploy online without installing anything locally

[Deploy RealDesk on Render](https://render.com/deploy?repo=https://github.com/PeteHasBadLuck/RealDesk) using the included `render.yaml` blueprint. Render will ask you to connect GitHub and review the services, database, persistent recording disk, and any charges before deploying. After provisioning, set the initial administrator email and a unique password in the API service environment, redeploy, open the frontend URL, and sign in. The API and frontend are separate hosted services; the agent portal is `/agent.html` and the admin portal is `/admin.html`.

For self-hosting on a server you control, see [deployment instructions](docs/DEPLOYMENT.md). You do not need to install development tools on your personal laptop.

## Current implementation status

This is an early working foundation, not a production-ready contact center yet.

Implemented in the repository:
- Separate admin/supervisor and agent navigation
- Password login and role checks
- Company-scoped contacts, contact CRUD and CSV import/export
- Campaign creation
- Call records and required call disposition endpoint
- VoIP settings form and encrypted-at-rest credential storage
- SIP-over-WebSocket/WebRTC outbound and inbound call client integration, pending provider-specific end-to-end validation
- Consent-gated mixed local/remote browser audio capture when the SIP peer connection exposes both tracks
- Per-agent SIP credential fields encrypted at rest, with a company-level fallback configuration
- Separate admin and agent portal entrypoints (`/admin.html` and `/agent.html`)
- AES-256-GCM encrypted recording files on persistent server storage, plus role-checked playback API
- Audit log and call summary endpoints
- Docker-based frontend/API/PostgreSQL deployment definitions

Not yet production-complete:
- Provider-specific PBX validation and handling of telephony edge cases
- Recording-quality validation across supported browsers/providers and legal-compliance review
- Production-grade recording retention/deletion jobs and optional S3-compatible object storage adapter
- Password reset, MFA, session revocation and comprehensive tests
- Production migration/backup/restore process
- Telephony-provider-specific adapter and end-to-end validation

The agent desktop uses SIP over secure WebSocket and WebRTC media; it requires a compatible PBX/provider, HTTPS, suitable NAT traversal (STUN/TURN), and provider-specific configuration. The browser recording path encrypts captured WebRTC audio on server storage, but verify that both sides are present with your actual PBX and browser before relying on recordings. Retention/deletion automation, database backup/restore, external security review, and jurisdiction-specific recording-compliance review remain incomplete. Do not use this version for real customer data until these checks are complete.

## Security

Read [Security and recording checklist](docs/SECURITY.md). Call recording laws and consent requirements depend on jurisdiction and participants. Recording should only be enabled after the company has established lawful notice/consent, retention, access control, and deletion processes.

## License

AGPL-3.0-or-later; see [LICENSE](LICENSE).
