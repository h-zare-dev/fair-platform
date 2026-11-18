"""Regression tests for eventual-consistency-safe, Owner-only staging deploys."""
import importlib.util
from pathlib import Path
import unittest


SCRIPT = Path(__file__).resolve().parents[2] / 'scripts/staging/verify-owner-merge.py'
spec = importlib.util.spec_from_file_location('verify_owner_merge', SCRIPT)
gate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gate)

REPOSITORY = 'h-zare-dev/fair-platform'
SHA = '06715bb74698074e5b8d536c563d8a1a9e791602'
ASSOCIATION = f'https://api.github.com/repos/{REPOSITORY}/commits/{SHA}/pulls'
DETAIL = f'https://api.github.com/repos/{REPOSITORY}/pulls/71'


def pull(**changes):
    result = {'number': 71, 'merge_commit_sha': SHA, 'base': {'ref': 'development'}}
    result.update(changes)
    return result


def detail(**changes):
    result = {'merged': True, 'merge_commit_sha': SHA,
              'base': {'ref': 'development'}, 'merged_by': {'login': 'h-zare-dev'}}
    result.update(changes)
    return result


class OwnerMergeTests(unittest.TestCase):
    def test_immediate_owner_merge(self):
        urls = []

        def fetch(url):
            urls.append(url)
            return [pull(url='https://example.invalid/evil')] if url == ASSOCIATION else detail()

        self.assertTrue(gate.verify_owner_merge(REPOSITORY, SHA, fetch, attempts=1))
        self.assertEqual(urls, [ASSOCIATION, DETAIL])

    def test_commit_association_eventually_appears(self):
        calls, pauses = [], []

        def fetch(url):
            calls.append(url)
            if url == ASSOCIATION:
                return [] if calls.count(ASSOCIATION) < 3 else [pull()]
            return detail()

        self.assertTrue(gate.verify_owner_merge(REPOSITORY, SHA, fetch,
                                                pause=pauses.append, attempts=4))
        self.assertEqual(pauses, [gate.RETRY_SECONDS] * 2)

    def test_merged_by_arrives_after_commit_association(self):
        details = iter([detail(merged_by=None), detail()])

        def fetch(url):
            return [pull()] if url == ASSOCIATION else next(details)

        self.assertTrue(gate.verify_owner_merge(REPOSITORY, SHA, fetch,
                                                pause=lambda _: None, attempts=2))

    def test_non_owner_never_authorized(self):
        def fetch(url):
            return [pull()] if url == ASSOCIATION else detail(merged_by={'login': 'other'})

        self.assertFalse(gate.verify_owner_merge(REPOSITORY, SHA, fetch,
                                                 pause=lambda _: None, attempts=2))

    def test_wrong_merge_commit_or_base_never_authorized(self):
        for association in (pull(merge_commit_sha='a' * 40), pull(base={'ref': 'main'})):
            with self.subTest(association=association):
                self.assertFalse(gate.verify_owner_merge(
                    REPOSITORY, SHA, lambda _url: [association],
                    pause=lambda _: None, attempts=2))

    def test_mismatched_pr_detail_never_authorized(self):
        def fetch(url):
            return [pull()] if url == ASSOCIATION else detail(merge_commit_sha='b' * 40)

        self.assertFalse(gate.verify_owner_merge(REPOSITORY, SHA, fetch,
                                                 pause=lambda _: None, attempts=2))

    def test_missing_evidence_exhausts_bounded_retries(self):
        pauses = []
        self.assertFalse(gate.verify_owner_merge(REPOSITORY, SHA, lambda _: [],
                                                 pause=pauses.append, attempts=3))
        self.assertEqual(pauses, [gate.RETRY_SECONDS, gate.RETRY_SECONDS])

    def test_api_failure_is_fail_closed(self):
        def fetch(_url):
            raise OSError('GitHub unavailable')

        with self.assertRaises(OSError):
            gate.verify_owner_merge(REPOSITORY, SHA, fetch, attempts=1)


if __name__ == '__main__':
    unittest.main()
