# LeadScout + RealDesk product architecture

## Product relationship

LeadScout is the parent platform and primary company workspace. RealDesk is a companion contact-center product. The product family shares company identity, users, permissions, provider integrations, and an approved lead handoff; each product has its own navigation and feature area.

- **LeadScout:** prompt-based lead discovery, web research through configured providers, source tracking, deduplication, qualification, saved lists, and exports.
- **RealDesk:** contact management, campaigns, agent workspaces, VoIP calling, call dispositions, callbacks, recordings, and reporting.
- **Shared platform:** company tenancy, authentication, user and role management, encrypted integration credentials, audit trail, usage limits, and product access controls.

## Recommended implementation shape

Keep the first version in the existing RealDesk repository as a monorepo and introduce LeadScout as a sibling app, rather than making LeadScout depend on scraping RealDesk's UI.

Suggested target structure:

```text
apps/
  web/       # LeadScout parent workspace
  api/       # shared platform API, auth, tenancy, integration credentials
  realdesk/  # companion call-center workspace
  leads/     # lead research and list-building workers/API module
packages/
  shared/    # shared schemas, types, permissions, and UI primitives
```

This is a target structure, not a claim that these new apps already exist. Move existing RealDesk UI into its companion workspace in small, tested steps; avoid a risky one-shot rewrite.

## Core workflow

1. A company creates one LeadScout account and invites its users.
2. An authorized administrator configures provider API keys in LeadScout settings.
3. A user submits a lead-search prompt with geography, industry, company criteria, target count, and allowed fields.
4. LeadScout turns the prompt into a bounded research job and queries configured providers. Fetching public pages must respect provider terms, robots/access restrictions, rate limits, and applicable law; do not bypass authentication or anti-bot controls.
5. Each result stores source URL, collection timestamp, provider, and field-level provenance where practical. Normalize and deduplicate results, label uncertainty, and do not fabricate missing details.
6. The user reviews the proposed list, removes unwanted records, and approves it.
7. Approved leads can be exported as CSV or imported into a RealDesk contact list/campaign. Preserve source attribution and opt-out/do-not-call flags.

## Tenant isolation and security

- Every provider credential, research job, lead, list, and usage record must be scoped to a company.
- Encrypt API keys at rest with a server-side encryption key supplied through deployment secrets. Never return stored secrets to the browser; show only a masked identifier and provide rotate/delete actions.
- Keep provider requests server-side. Validate provider destinations and restrict outbound fetches to mitigate SSRF; block private, loopback, link-local, and cloud metadata addresses, including after DNS resolution and redirects.
- Use per-company quotas, concurrency limits, request timeouts, maximum pages/results, and auditable usage accounting.
- Treat web content as untrusted data, not instructions. Never execute page scripts or let scraped text override system prompts or tool permissions.
- Record source and collection time. Support deletion, correction, retention policies, and opt-out suppression.
- Distinguish public business information from personal data. Enforce relevant privacy, marketing, data-protection, and do-not-call requirements for the markets where customers operate.
- Do not expose private provider keys in logs, URLs, frontend bundles, or error messages.

## First release scope

1. Shared sign-in and company settings in LeadScout.
2. Encrypted bring-your-own-key settings for one search provider and one optional business-data provider.
3. Prompt form with explicit filters and a result cap; preview research plan before execution.
4. Asynchronous jobs with progress, retries, and per-company limits.
5. Results table with provenance, confidence, deduplication, and manual review.
6. Saved lists, CSV export, and an authenticated, tenant-scoped handoff to RealDesk.
7. Audit events and tests for tenant isolation, key masking, provider failures, rate limits, and malicious URLs.

## Non-goals for the first release

- Unrestricted crawling of the whole internet.
- Circumventing paywalls, logins, CAPTCHAs, rate limits, or site access controls.
- Harvesting sensitive personal information or treating guessed email addresses as verified.
- Automatically placing calls or enrolling every discovered lead into a campaign without user review.

## Deployment

The parent platform can be deployed as a hosted web workspace with the shared API, PostgreSQL, and a background job worker. RealDesk can be enabled in the same deployment or deployed separately against the same authenticated platform API. Customers should not need local development tools. Before real customer data is used, validate authentication boundaries, key encryption, provider terms, privacy obligations, backup/restore, and deletion workflows.
