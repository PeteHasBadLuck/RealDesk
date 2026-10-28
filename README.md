# RealDesk

Open-source, self-hostable contact-center software inspired by modern agent workspaces.

## Current prototype

The browser prototype focuses on the contact-center agent workflow:

- Campaign contact queue with search and status filters
- Agent availability state
- Selected-contact details and recent interaction history
- Simulated softphone controls
- Call outcome logging, notes, and contact editing
- Browser-local sample data and responsive layout
- GitHub Pages workflow for a browser-only demo

## Try it in a browser

The static prototype can be published with GitHub Pages. No local installation is needed to view it. See [deployment instructions](docs/DEPLOYMENT.md).

## Important limitations

This is an early UI prototype, not a production telephony system. The call controls are simulations and do not place calls. Records are stored in the current browser only and do not sync between users or devices. There is no server-side authentication, database, SIP/WebRTC integration, call recording, predictive dialer, or omnichannel routing yet. Do not use it for real customer data.

## Planned architecture

- Frontend: TypeScript-based agent desktop
- Backend: authenticated API and PostgreSQL
- Telephony: pluggable SIP/WebRTC provider integration
- Deployment: Docker Compose, reverse proxy, and documented backups
- Security: roles, audit trail, consent and do-not-call controls

## License

AGPL-3.0-or-later. See [LICENSE](LICENSE).
