# Security Policy

## Secrets
No production secret belongs in Git, issues, PRs, logs, screenshots, fixtures, or documentation examples.

## Sensitive Pasarguard Data
Raw webhook payloads may contain subscription URLs and proxy credentials. They are short-lived debugging data, protected at rest by deployment controls, never indexed wholesale, never copied into normalized business tables, and purged by retention.

## Logging Redaction
Never log Pasarguard API tokens, Telegram bot tokens, webhook secrets, session secrets, subscription URLs, proxy credentials, passwords, or private keys.

## Authentication
Owner authentication uses strong password hashing (Argon2id direction), server-side sessions, Secure/HttpOnly/SameSite cookies, CSRF protection where relevant, rate limiting, session rotation, and audit logging. Do not store JWTs in localStorage.

The proposed FP-003B temporary dashboard needs explicit Owner approval of the access channel (private tunnel/network versus protected HTTPS), session/bootstrap implementation and isolated persistent safe source. These security requirements are **not proof that authentication is implemented**. Every read API must enforce Owner authorization, bounded allowlisted responses and private-data redaction; read-only access by itself is not secure.

## Bootstrap
The first Owner is created through a one-time bootstrap/CLI flow. Permanent Owner passwords do not live in `.env`.

## Application Secrets
Runtime integration secrets may be stored encrypted with an external master key/environment secret. UI masks secrets and changes are audited.

## Environment
Keep `.env` minimal and deployment-oriented. Do not place runtime/tool versions in `.env`.

## Telegram
Fair has its own bot token. Pasarguard admin Telegram destination remains sourced from Pasarguard rather than becoming authoritative local profile data.

## Dependency / CI Security
Use dependency updates, CodeQL, secret scanning, Trivy/container scanning, and package audit as CI evolves.

## Production Access
AI agents do not receive autonomous production SSH/deploy authority. Production actions remain human-controlled.
