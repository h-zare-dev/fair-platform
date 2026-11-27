# Empty VPS Lab — Owner SSH Bootstrap Runbook

**Status:** operator instructions, NOT evidence of a provisioned VPS. **LAB ONLY**: one disposable Ubuntu VPS with a fresh, empty PasarGuard test instance, synthetic test users, separate Fair PostgreSQL and separate Telegram test bot. Never use a production host, existing PasarGuard customers, real API keys, historical Pasarjew dataset or production Telegram bot. No public staging auto-deploy is authorized by this document.

## 0. Before touching the new host

Owner provisions a **new, disposable** VPS; preserve access to provider console/rescue and initial root password **outside GitHub and ChatGPT**. The initial root password is only for your own one-time first login. Do not send it to any agent or put it in an Issue, PR, shell history or `.env`. Record the intended VPS identity in an Owner-only local file, not a public repo.

On your **Omarchy laptop**, assign the *real* address of the newly provisioned empty host:

```bash
export LAB_IP="REPLACE_WITH_NEW_TEST_VPS_IP"
mkdir -p ~/.ssh
chmod 700 ~/.ssh
ssh-keygen -t ed25519 -a 100 -f ~/.ssh/fair-lab-agent -C fair-platform-disposable-lab
chmod 600 ~/.ssh/fair-lab-agent
chmod 644 ~/.ssh/fair-lab-agent.pub
```

Choose a passphrase appropriate to your operating model. For unattended work after reboot, design a secured agent-unlock mechanism rather than publishing an unencrypted key or pasting its contents into prompts. **The private file `~/.ssh/fair-lab-agent` never leaves the laptop.** Only `~/.ssh/fair-lab-agent.pub` is a public key.

## 1. Verify host identity, don't disable host-key checks

Using the **VPS provider console**, run directly on the new VPS:

```bash
ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub
```

Independently, on the laptop, collect the *observed* key:

```bash
ssh-keyscan -T 10 -t ed25519 "$LAB_IP" 2>/dev/null > ~/.ssh/fair-lab-known_hosts.candidate
ssh-keygen -lf ~/.ssh/fair-lab-known_hosts.candidate
```

**Stop unless fingerprints match exactly.** `ssh-keyscan` is observation only; it is not proof of trust. After manual match:

```bash
mv ~/.ssh/fair-lab-known_hosts.candidate ~/.ssh/fair-lab-known_hosts
chmod 600 ~/.ssh/fair-lab-known_hosts
```

If the VPS is rebuilt or the IP recycled, reverify with the provider console. Never use `StrictHostKeyChecking=no` or automatically trust a changed host key.

## 2. Install ONLY the public key on the disposable VPS

From the **laptop** (first login may request the initial VPS root password):

```bash
cat ~/.ssh/fair-lab-agent.pub | ssh \
  -o StrictHostKeyChecking=yes \
  -o UserKnownHostsFile="$HOME/.ssh/fair-lab-known_hosts" \
  "root@$LAB_IP" \
  'umask 077; mkdir -p /root/.ssh; chmod 700 /root/.ssh; cat >> /root/.ssh/authorized_keys; chmod 600 /root/.ssh/authorized_keys'
```

Verify key-only access **from a new laptop terminal session**, leaving provider recovery accessible:

```bash
ssh -i ~/.ssh/fair-lab-agent \
  -o IdentitiesOnly=yes \
  -o PreferredAuthentications=publickey \
  -o PasswordAuthentication=no \
  -o StrictHostKeyChecking=yes \
  -o UserKnownHostsFile="$HOME/.ssh/fair-lab-known_hosts" \
  "root@$LAB_IP" 'id; hostname; uptime'
```

Only after success and verified provider console access may you disable password and keyboard-interactive SSH using a reviewed `sshd_config.d` drop-in; test `sshd -t` before reload and retain the active original SSH connection. `PermitRootLogin prohibit-password` retains key-only root for the disposable Lab, if explicitly accepted. If using a non-root account instead, restrict sudo/SSH thoughtfully; full Docker control is root-equivalent.

## 3. Simple local SSH alias (optional)

Add to **your laptop's** `~/.ssh/config` (do not commit it):

```sshconfig
Host fair-lab
    HostName REPLACE_WITH_NEW_TEST_VPS_IP
    User root
    IdentityFile ~/.ssh/fair-lab-agent
    IdentitiesOnly yes
    PreferredAuthentications publickey
    PasswordAuthentication no
    StrictHostKeyChecking yes
    UserKnownHostsFile ~/.ssh/fair-lab-known_hosts
```

Then `ssh fair-lab` should work. Do **not** create aliases that can accidentally resolve to production. The runner must allowlist only this verified alias and pinned key; also check a Lab-only sentinel/host identity before performing destructive testing. The sentinel is a safety guard, **not** a replacement for SSH host-key verification.

## 4. What agents are permitted to do — once separately activated

The Owner may authorize the orchestrator to install/update/remove software, create/reset **synthetic** databases and containers, perform migration tests, deploy exact PR images and restart services on this verified Lab host. All side effects are restricted to that host. Keep Docker networks/private DB ports internal and protect test endpoints with firewall/VPN or explicit allowlists; a blank test server is still exposed to the Internet if misconfigured.

Required inventory kept privately by the laptop operator: `LAB_IP`, SSH alias, approved host fingerprint, OS version, provider rescue reference (not credentials), allocated CPU/RAM/disk, allowed network exposure, synthetic PasarGuard base URL, test Telegram destination IDs and test-only tokens in a local protected secret store. A test BotFather token is a secret; **never** post it to this public repository or to agents' GitHub comments/logs.

For real Telegram tests: validate accepted Bot API response and optionally independent observation using an explicitly configured test account/group. Do not mistake send acknowledgment for a guarantee of smartphone push notification. Test 00:00 jobs using an injected/fake application clock and one separately scheduled real Lab event.

Create a clean Lab checkpoint/snapshot before enabling destructive E2E. Lab reset jobs must verify the approved SSH host-key identity and exact Lab namespace/DB names; never run blanket `docker system prune --volumes` or database drop against an unverified target. Limit service restart and migration retries. Logs and test reports must be redacted.

## 5. Activation and verification checklist

- [ ] Root/password login remains Owner-only; isolated key installed and tested.
- [ ] Host fingerprint pinned and matched via provider console; console recovery tested.
- [ ] Laptop-side Orchestrator allowlist targets `fair-lab` only.
- [ ] Test bot token, database encryption key and any GitHub token exist only in the approved local/server secret stores, never GitHub.
- [ ] PasarGuard has no real customers and no shared prod identity/telemetry/API settings.
- [ ] Synthetic DB snapshot, restoration and server-side reset guard verified.
- [ ] Firewall and public listeners audited (including Docker port publishing and IPv6).
- [ ] Owner separately approves initial Lab activation and intended admin privileges.
- [ ] End-to-end demonstration causes a planned failure, routes back to Implementation, fixes, re-reviews/re-tests and deploys again before proposing merge.

**Do not paste the VPS password or private SSH key into any chat, issue, PR or Codex prompt.** An operator-provided private key path/SSH alias suffices once the laptop runner is authorized and initialized.
