#!/usr/bin/env python3
"""Read-only GitHub verification: a protected development push must be an Owner merge."""
import json
import os
import urllib.request
repository = os.environ['GITHUB_REPOSITORY']
sha = os.environ['GITHUB_SHA']
request = urllib.request.Request(
    f'https://api.github.com/repos/{repository}/commits/{sha}/pulls',
    headers={'Authorization': 'Bearer ' + os.environ['GH_TOKEN'], 'Accept': 'application/vnd.github+json',
             'X-GitHub-Api-Version': '2022-11-28'})
with urllib.request.urlopen(request, timeout=15) as response:
    pulls = json.load(response)
# The commit association endpoint may omit merged_by; fetch the PR itself.
authorized = False
for pull in pulls:
    if pull.get('merge_commit_sha') != sha or pull['base']['ref'] != 'development':
        continue
    detail = urllib.request.Request(pull['url'], headers=request.headers)
    with urllib.request.urlopen(detail, timeout=15) as response:
        info = json.load(response)
    if info.get('merged') and info.get('merged_by', {}).get('login') == repository.split('/')[0]:
        authorized = True
if not authorized:
    raise SystemExit('OWNER_MERGED_DEVELOPMENT_REQUIRED')
with open(os.environ['GITHUB_OUTPUT'], 'a') as output:
    output.write('authorized=true\n')
