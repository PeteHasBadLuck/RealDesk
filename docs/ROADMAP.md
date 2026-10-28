# RealDesk roadmap

## Phase 1 — Contact-center UI prototype

- [x] Agent desktop layout
- [x] Campaign contact queue, search, and status filters
- [x] Contact details and interaction history
- [x] Simulated softphone controls and agent availability
- [x] Call outcome logging and notes
- [x] Contact editing
- [x] Browser-only static deployment path

## Phase 2 — Multi-user application

- [ ] Backend API and PostgreSQL persistence
- [ ] Secure authentication, sessions, password reset, and roles
- [ ] Campaign creation and contact-list import/export
- [ ] Shared contact history and agent assignment
- [ ] Callback scheduling and due queue
- [ ] Audit trail, validation, rate limiting, and tests
- [ ] Automated backups and restore documentation

## Phase 3 — Real contact-center capabilities

- [ ] SIP/WebRTC integration through a configurable telephony provider
- [ ] Inbound and outbound call handling
- [ ] Call disposition and post-call workflow
- [ ] Call queues and skill-based routing
- [ ] Do-not-call lists, consent records, and regional compliance controls
- [ ] Optional recording/transcription integrations with explicit controls
- [ ] Supervisor dashboard and reports
- [ ] Omnichannel inbox for email and web chat
- [ ] Advanced dialer modes only after reliability and compliance foundations

## Prototype limitations

The current index.html is a static browser prototype. The softphone is simulated and places no calls. Records live in the current browser's local storage and do not sync between devices or agents. There is no backend, authentication, database, or real telephony connection. Do not expose it as a production contact center or enter real customer data yet.
