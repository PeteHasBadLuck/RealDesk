# RealDesk

Open-source, self-hosted lead management.

## MVP direction

RealDesk starts as a single-organization CRM that runs on your own server. Your data stays in your deployment; no hosted account is required.

### First milestone

- Lead list and pipeline stages
- Contacts and company details
- Lead owner, source, value, notes, and next action
- Search and status filtering
- CSV export
- Docker-based deployment

## Development

This repository is the starting point for the RealDesk MVP. The initial UI is intentionally dependency-free and can be opened locally in a browser. The next implementation step is to connect persistence and authentication, then package the app for Docker.

## Self-hosting principles

- No telemetry by default
- Data stored on the operator's server
- Backups and exports controlled by the operator
- Clear security documentation before production use

## License

AGPL-3.0-or-later. See `LICENSE`.
