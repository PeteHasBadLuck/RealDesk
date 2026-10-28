# RealDesk roadmap

## Phase 1 — Browser prototype

- [x] Lead overview and summary cards
- [x] Add a lead
- [x] Search and stage filtering
- [x] CSV export
- [x] Docker-based static preview

## Phase 2 — Real self-hosted application

- [ ] Add a backend API and PostgreSQL persistence
- [ ] Add secure authentication and password reset
- [ ] Add organization membership and role-based permissions
- [ ] Add lead detail pages, editable leads, companies, and tasks
- [ ] Add database migrations and input validation
- [ ] Add tests and CI
- [ ] Add HTTPS/reverse proxy and operational health checks
- [ ] Add automated, restorable backups

## Phase 3 — Production readiness

- [ ] Threat model and security review
- [ ] Audit log for sensitive changes
- [ ] Rate limiting and session lifecycle controls
- [ ] Import validation and duplicate detection
- [ ] Document upgrade and rollback procedures
- [ ] Verify license headers and include full AGPL-3.0 license text

## Important prototype limitations

The initial `index.html` is a browser-only demo. Leads are saved to the current browser's local storage, not to the server or a shared database. It has no authentication and is not suitable for real personal/customer data or multi-user use. The Docker setup only serves the static demo; it is not yet a production CRM backend.
