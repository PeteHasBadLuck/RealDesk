# RealDesk

RealDesk is an open-source, self-hosted contact-center application inspired by modern agent workspaces. It is being developed as two distinct role-based workspaces backed by one API and database.

## Product workspaces

### Admin / supervisor
- Company user accounts and roles
- Campaign creation and contact-list management
- VoIP configuration form with encrypted-at-rest credentials
- Call history, dispositions, reporting and audit events
- Recording access UI (requires production storage adapter)

### Call agent
- Sign-in and role-based workspace
- Contact search, add/edit, CSV import and export
- Microphone permission request
- Call record creation and mandatory ending-reason workflow
- Callback, interest, no-answer, wrong-number, sale and do-not-call dispositions
- Agent-scoped call history

## Stack

- Web: React, TypeScript, Vite, Nginx
- API: Fastify, TypeScript, JWT authentication, Zod validation
- Data: PostgreSQL + Prisma
- Deployment: Docker Compose; Render blueprint included as an online hosting option

## Run on a server

See [self-hosting deployment instructions](docs/DEPLOYMENT.md). You do not need to install development tools on your personal laptop if you deploy the repository to a supported cloud host.

## Current implementation status

This is an early working foundation, not a production-ready contact center yet.

Implemented in the repository:
- Separate admin/supervisor and agent navigation
- Password login and role checks
- Company-scoped contacts, contact CRUD and CSV import/export
- Campaign creation
- Call records and required call disposition endpoint
- VoIP settings form and encrypted-at-rest credential storage
- Audit log and call summary endpoints
- Docker-based frontend/API/PostgreSQL deployment definitions

Not yet production-complete:
- SIP/WebRTC signaling and actual inbound/outbound calling
- Real call-media capture/recording pipeline
- Encrypted object storage, retention and playback authorization
- Password reset, MFA, session revocation and comprehensive tests
- Production migration/backup/restore process
- Telephony-provider-specific adapter and end-to-end validation

The current browser microphone check is not the same as connecting a phone call. The browser's local microphone audio is not a complete recording of both sides of a real call. Recording endpoints intentionally remain disabled until secure object storage is implemented. Do not enter real customer data or expose this version publicly until the outstanding security and telephony work is complete.

## Security

Read [Security and recording checklist](docs/SECURITY.md). Call recording laws and consent requirements depend on jurisdiction and participants. Recording should only be enabled after the company has established lawful notice/consent, retention, access control, and deletion processes.

## License

AGPL-3.0-or-later; see [LICENSE](LICENSE).
