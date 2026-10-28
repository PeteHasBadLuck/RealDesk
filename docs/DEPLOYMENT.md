# Run RealDesk locally

## Requirements

- Docker Engine
- Docker Compose plugin

## Start

From the repository root:

```sh
docker compose up --build -d
```

Open `http://localhost:8080`.

## Stop

```sh
docker compose down
```

## Important

This is currently a static browser prototype, not a production CRM. Records are stored in browser local storage, so they do not sync between devices or users and are not stored in the container. The initial Compose configuration has no database, login, or HTTPS termination. Do not expose it publicly or use it for real lead/customer data until the backend, authentication, reverse proxy, and backup strategy have been implemented and reviewed.
