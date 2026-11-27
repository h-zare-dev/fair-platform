"""Regression assertions for the Owner-approved PR-full / staging-fast split.

These are intentionally stdlib-only: the release gate must not depend on an
unreviewed package installer just to verify its own workflow invariants.
"""

from pathlib import Path
import re
import unittest


ROOT = Path(__file__).resolve().parents[2]
WORKFLOW = ROOT / '.github/workflows/ci.yml'


class FastDeliveryTests(unittest.TestCase):
    def setUp(self):
        self.workflow = WORKFLOW.read_text()
        self.containers = self.workflow.split('\n  containers:\n', 1)[1].split(
            '\n  owner-merge:\n', 1)[0]
        self.browser = self.containers.split(
            '      - name: Browser acceptance on local synthetic containers\n', 1)[1].split(
                '      - name: Fast staging release safety regressions\n', 1)[0]

    def test_full_e2e_and_backup_checks_still_run_before_owner_merge(self):
        self.assertIn('pull_request:\n    branches: [development, main]', self.workflow)
        self.assertIn("if: github.event_name != 'push' || github.ref != 'refs/heads/development'",
                      self.browser)
        for command in ('pnpm test:web', 'pnpm test:backup', 'FAIR_RELEASE_DOCKER_TEST=1'):
            self.assertIn(command, self.browser)

    def test_fast_postmerge_does_not_disable_quality_image_security_or_owner_gate(self):
        self.assertIn('      - name: Format check', self.workflow)
        self.assertIn('      - name: Lint', self.workflow)
        self.assertIn('      - name: Typecheck', self.workflow)
        self.assertIn('      - name: Test', self.workflow)
        self.assertIn('      - name: Fast staging release safety regressions', self.containers)
        self.assertIn('      - name: Scan API image', self.containers)
        self.assertIn('      - name: Scan Web image', self.containers)
        self.assertIn('      - name: Scan Caddy', self.containers)
        self.assertIn('      - name: Scan PostgreSQL', self.containers)
        self.assertIn('      - name: Validate Compose and Caddy', self.containers)
        self.assertIn('needs: [quality, security, containers, owner-merge]', self.workflow)
        self.assertIn("needs.owner-merge.outputs.authorized == 'true'", self.workflow)
        self.assertIn('\n  publish:\n', self.workflow)
        self.assertNotIn('\n  deploy:\n', self.workflow)
        self.assertNotIn('secrets.STAGING_BOOTSTRAP_', self.workflow)

    def test_build_cache_scopes_isolate_all_four_images(self):
        for scope in ('fp-api', 'fp-web', 'fp-caddy', 'fp-postgres'):
            self.assertIn(f'cache-from: type=gha,scope={scope}', self.containers)
            self.assertIn(f'cache-to: type=gha,scope={scope},mode=max', self.containers)
        self.assertEqual(self.containers.count('          load: true'), 4)

    def test_both_custom_go_builders_are_pinned_to_a_patched_toolchain(self):
        # A stale Caddy Go stdlib image failed PR #80's unchanged Trivy
        # HIGH/CRITICAL gate with CVE-2026-97054 (patched in Go 1.27.4).
        builders = []
        for dockerfile in ('Dockerfile.caddy', 'Dockerfile.postgres'):
            content = (ROOT / 'docker' / dockerfile).read_text()
            from_line = content.splitlines()[0]
            match = re.fullmatch(
                r'FROM golang:(\d+)\.(\d+)\.(\d+)-alpine3\.24@sha256:([0-9a-f]{64}) AS build',
                from_line,
            )
            self.assertIsNotNone(match, f'{dockerfile}: Go builder must pin an immutable official digest')
            version = tuple(map(int, match.group(1, 2, 3)))
            self.assertGreaterEqual(version, (1, 27, 4), f'{dockerfile}: unsupported vulnerable Go toolchain')
            builders.append((version, match.group(4)))
        self.assertEqual(builders[0], builders[1], 'Caddy/gosu must use one reviewed Go builder')

    def test_release_failures_retain_diagnostics_and_rollback(self):
        release = (ROOT / 'scripts/staging/release.py').read_text()
        delivery = (ROOT / 'scripts/staging/ci-post-merge-local.sh').read_text()
        diagnostics = (ROOT / 'scripts/staging/diagnose-release.py').read_text()
        for phase in ('STARTUP', 'HEALTH', 'SMOKE'):
            self.assertIn(f'APP_{phase}_FAILED_PREVIOUS_RELEASE_RESTORED', delivery)
        self.assertIn("state['appFailure']", release)
        self.assertIn("resolved('app-rollback')", release)
        self.assertIn("'failed_app_phase'", diagnostics)
        self.assertIn("'staging-no-backup-v1'", release)


if __name__ == '__main__':
    unittest.main()
