# Security model and production checklist

## Tenant boundaries

Every contact-center record is scoped by company ID on the server. Do not trust a company ID supplied by the browser. Verify that all new endpoints enforce company scoping and role checks.

## Roles

- OWNER / ADMIN: company configuration, user management and VoIP settings
- SUPERVISOR: company-wide operational views, recordings and audit log
- AGENT: their own call records and contact workspace

Review role permissions before adding endpoints. Use individual agent accounts and avoid shared logins.

## Credentials

- User passwords are hashed using bcrypt.
- VoIP passwords are encrypted at rest using AES-256-GCM and `VOIP_ENCRYPTION_KEY`.
- The keys must be stored in a secret manager or protected environment configuration and must not be committed.
- The SIP client configuration endpoint provides the configured SIP password to an authenticated agent browser so JsSIP can register. Use HTTPS only and prefer per-agent SIP credentials/extensions; do not reuse a privileged PBX trunk credential as an agent login.
- Do not log authentication headers, passwords, SIP secrets, call audio or full contact payloads.
- Production deployment must use HTTPS and secure cookie/token handling appropriate to the deployment threat model.

## Recording and privacy

Call recording may be regulated. Before enabling it, establish lawful basis/consent and notice, a retention schedule, access controls, deletion/export procedures, data processing agreements where applicable, and handling of access requests. Recording must be off by default. Do not capture audio before the required notice/consent process. Test whether the provider records server-side or the application records browser media; these are different sources.

## Before production

- Add automated tests for tenant isolation, authentication, authorization and contact import.
- Add brute-force protections, password reset, session revocation, MFA and login audit events.
- Add encrypted object storage with signed, short-lived playback URLs and retention/deletion jobs.
- Add call recording access audit events.
- Review CSV parsing, upload limits, backup encryption and restore procedures.
- Complete an external security review and jurisdiction-specific legal review.
