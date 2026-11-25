# Owner password change — approved scope

Owner approval in conversation, 2026-11-25: allow the signed-in singleton Owner to change their password through Settings → Account Security by supplying the existing password and a confirmed replacement. Minimum **8 characters** with at least one ASCII letter and one digit; no stricter composition requirements. No forgot-password, signup, email reset, or CLI reset changes.

Implementation requirements:

- Use the existing HTTPS Owner session, same-origin JSON CSRF protection, server-side validation, and shared login-attempt throttle.
- Verify the existing Argon2id password, store only a fresh Argon2id hash, and atomically compare the old hash and active session before updating to prevent races with resets, login, and concurrent changes.
- In that same transaction revoke all sessions and emit a password-change audit event without password values.
- Expire the browser cookie, return to login, and never include passwords in application logs or audit.
- Add regression coverage for invalid/missing session, CSRF, wrong existing password, weak/mismatched replacement, successful login with replacement, old-password rejection, and session revocation.
- Draft PR to `development`; no deployment, Ready transition, or merge by assistant.
