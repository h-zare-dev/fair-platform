#!/usr/bin/env python3
"""Fail-closed proof that a protected development push is a human Owner merge.

GitHub's commit-to-PR association can lag behind the push event. A bounded
retry handles that delay without weakening the required merge identity checks.
"""
import json
import os
import re
import time
import urllib.request


MAX_ATTEMPTS = 8
RETRY_SECONDS = 4


def verify_owner_merge(repository, sha, fetch, pause=time.sleep,
                       attempts=MAX_ATTEMPTS, branch='development'):
    if branch not in ('main', 'development'):
        raise ValueError('INVALID_RELEASE_BRANCH')
    if not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', repository):
        raise ValueError('INVALID_REPOSITORY')
    if not re.fullmatch(r'[0-9a-f]{40}', sha):
        raise ValueError('INVALID_COMMIT_SHA')

    association_url = f'https://api.github.com/repos/{repository}/commits/{sha}/pulls'
    for attempt in range(attempts):
        pulls = fetch(association_url)
        if not isinstance(pulls, list):
            raise ValueError('INVALID_PULL_ASSOCIATIONS')
        for pull in pulls:
            if not isinstance(pull, dict):
                raise ValueError('INVALID_PULL_ASSOCIATION')
            number = pull.get('number')
            if (pull.get('merge_commit_sha') != sha
                    or pull.get('base', {}).get('ref') != branch
                    or type(number) is not int or number < 1):
                continue

            # Never follow an API-returned URL; use only the verified repository
            # and numeric PR identifier to fetch the authoritative merge record.
            detail = fetch(f'https://api.github.com/repos/{repository}/pulls/{number}')
            if (detail.get('merged') is True
                    and detail.get('merge_commit_sha') == sha
                    and detail.get('base', {}).get('ref') == branch
                    and (detail.get('merged_by') or {}).get('login') == repository.split('/')[0]):
                return True
        if attempt + 1 < attempts:
            pause(RETRY_SECONDS)
    return False


def main():
    token = os.environ['GH_TOKEN']

    def fetch(url):
        request = urllib.request.Request(
            url,
            headers={'Authorization': 'Bearer ' + token,
                     'Accept': 'application/vnd.github+json',
                     'X-GitHub-Api-Version': '2022-11-28'},
        )
        with urllib.request.urlopen(request, timeout=15) as response:
            return json.load(response)

    if not verify_owner_merge(os.environ['GITHUB_REPOSITORY'],
                              os.environ['GITHUB_SHA'], fetch, branch=os.environ['GITHUB_REF_NAME']):
        raise SystemExit('OWNER_MERGED_DEVELOPMENT_REQUIRED')

    with open(os.environ['GITHUB_OUTPUT'], 'a') as output:
        output.write('authorized=true\n')


if __name__ == '__main__':
    main()
