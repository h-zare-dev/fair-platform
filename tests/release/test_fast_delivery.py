"""Regression assertions for fast PR checks and Owner-gated post-merge image release.

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
        self.images = self.workflow.split('\n  image-release:\n', 1)[1].split(
            '\n  publish:\n', 1)[0]
        self.browser = self.images.split(
            '      - name: Browser acceptance on local synthetic containers\n', 1)[1].split(
                '      - name: Scan API image\n', 1)[0]

    def test_e2e_and_backup_checks_run_only_after_owner_merge(self):
        self.assertIn('pull_request:\n    branches: [development, main]', self.workflow)
        self.assertIn("needs.owner-merge.outputs.authorized == 'true'", self.images)
        self.assertNotIn('      - name: Browser acceptance', self.containers)
        for command in ('pnpm test:web', 'pnpm test:backup', 'FAIR_RELEASE_DOCKER_TEST=1'):
            self.assertIn(command, self.browser)

    def test_pr_is_lightweight_and_postmerge_preserves_security_gates(self):
        self.assertIn('      - name: Format check', self.workflow)
        self.assertIn('      - name: Lint', self.workflow)
        self.assertIn('      - name: Typecheck', self.workflow)
        self.assertIn('      - name: Test', self.workflow)
        self.assertIn('Validate Compose configuration without building images', self.containers)
        self.assertNotIn('docker/build-push-action@', self.containers)
        self.assertNotIn('image-ref:', self.containers)
        self.assertIn('      - name: Scan API image', self.images)
        self.assertIn('      - name: Scan Web image', self.images)
        self.assertIn('      - name: Scan Caddy', self.images)
        self.assertIn('      - name: Scan PostgreSQL', self.images)
        self.assertIn('      - name: Validate built Caddy image', self.images)
        self.assertIn('needs: [quality, security, containers, owner-merge]', self.images)
        self.assertIn('needs: [image-release, owner-merge]', self.workflow)
        self.assertIn("needs.owner-merge.outputs.authorized == 'true'", self.workflow)
        self.assertIn('\n  publish:\n', self.workflow)
        self.assertNotIn('\n  deploy:\n', self.workflow)
        self.assertNotIn('secrets.STAGING_BOOTSTRAP_', self.workflow)

    def test_build_cache_scopes_isolate_all_four_images(self):
        for scope in ('fp-api', 'fp-web', 'fp-caddy', 'fp-postgres'):
            self.assertIn(f'cache-from: type=gha,scope={scope}', self.images)
            self.assertIn(f'cache-to: type=gha,scope={scope},mode=max', self.images)
        self.assertEqual(self.images.count('          load: true'), 4)

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
