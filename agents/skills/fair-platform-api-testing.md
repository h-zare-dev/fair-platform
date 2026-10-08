# Skill — Fair Platform API Testing

Use this skill for HTTP/API feature verification.

## Verify
- status codes and response shape
- validation failures
- authentication/authorization behavior
- idempotent retries
- durable-write-before-success semantics when required
- no internal IDs, secrets, stack traces, or sensitive payloads leak in responses
- request/response boundaries stay transport-focused
- failure behavior when PostgreSQL or other required dependencies are unavailable

For webhook endpoints, explicitly verify duplicate delivery and malformed payload behavior. Keep fixtures sanitized.
