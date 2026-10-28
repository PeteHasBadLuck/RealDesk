# LeadScout product family

**LeadScout is the parent platform**: the primary company workspace for AI-assisted lead research, provider API keys, saved prospect lists, and integrations. **RealDesk is its companion contact-center product** for campaigns, agents, internet calling, and call outcomes. The shared-platform architecture is documented in [docs/LEADSCOUT_ARCHITECTURE.md](docs/LEADSCOUT_ARCHITECTURE.md).

## LeadScout parent workspace

Open `/leadscout.html` after deployment and sign in with the same company account used by RealDesk. The first LeadScout MVP includes:
- A separate parent-platform workspace with company identity and shared authentication
- Company-admin settings for a Brave Search API key, encrypted at rest using the server encryption key; saved secrets are never returned to the browser
- Prompt-based web research with a bounded result count, source URLs, descriptions, and collection timestamps
- Tenant-scoped saved results and research history, plus CSV export
- A link to the RealDesk contact-center companion

The current research MVP uses web-search results as sourced prospect candidates. It does **not** yet crawl pages for structured phone/email enrichment, verify that each result is a real business, or automatically import leads into RealDesk campaigns. Review source links and verify data before outreach. Provider usage and terms may incur costs.

## RealDesk companion

RealDesk is the contact-center component of the LeadScout product family. It currently has role-based admin/supervisor and agent workspaces backed by the same API and database. LeadScout and RealDesk share the existing company login; the broader shared settings and seamless list-to-campaign handoff remain future work.

## Product workspaces

### Admin / supervisor
- Company user accounts and roles
- Campaign creation, contact assignment to individual agents, and agent availability presence and contact-list management
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

This is a substantial working foundation, but it is not yet a production-ready contact center. The CI workflow builds both containers and runs API integration smoke tests against PostgreSQL.

Implemented in the repository:
- Separate LeadScout parent workspace, RealDesk admin/supervisor workspace, and agent navigation
- LeadScout provider key storage with encryption at rest, prompt-based Brave Search, sourced lead candidates, research history, and CSV export
- Company self-registration, password login, role checks, password changes, and server-side session revocation
- Company-scoped contacts, contact CRUD, and CSV import/export for status, notes, do-not-call flags, and callback dates
- Campaign creation
- Call records, required call-ending reasons, scheduled callback times, and contact-specific call history
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
- Password reset, MFA, and a broader browser end-to-end / load-testing suite (API integration smoke tests now run in CI)
- Production migration/backup/restore process
- Telephony-provider-specific adapter and end-to-end validation

The agent desktop uses SIP over secure WebSocket and WebRTC media; it requires a compatible PBX/provider, HTTPS, suitable NAT traversal (STUN/TURN), and provider-specific configuration. The browser recording path encrypts captured WebRTC audio on server storage, but verify that both sides are present with your actual PBX and browser before relying on recordings. Retention/deletion automation, database backup/restore, external security review, and jurisdiction-specific recording-compliance review remain incomplete. Do not use this version for real customer data until these checks are complete.

## LeadScout provider setup

LeadScout provider keys use the server-side `VOIP_ENCRYPTION_KEY` setting for authenticated encryption; configure a random value of at least 32 characters before saving keys. Sign in as a company owner/admin, open `/leadscout.html`, and add a Brave Search API key from [Brave Search API](https://brave.com/search/api/). The application stores only the encrypted key and exposes provider status, never the saved secret. Do not place provider keys in frontend environment variables or commit them to Git.

Read the [LeadScout architecture plan](docs/LEADSCOUT_ARCHITECTURE.md) for boundaries and future roadmap.

## Setup and security

Read the [VoIP setup guide](docs/VOIP_SETUP.md) before connecting a PBX, and the [security and recording checklist](docs/SECURITY.md) before handling real customer data. Call recording laws and consent requirements depend on jurisdiction and participants. Recording should only be enabled after the company has established lawful notice/consent, retention, access control, and deletion processes.

## License

AGPL-3.0-or-later; see [LICENSE](LICENSE).
