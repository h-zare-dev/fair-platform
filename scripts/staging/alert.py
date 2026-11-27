#!/usr/bin/env python3
"""Operator-configured notification sink. Fixed payload, no diagnostic bodies or secrets."""
from pathlib import Path
import urllib.request
try:
    target = Path('/etc/fair-staging/alert-url').read_text().strip()
    if not target.startswith('https://'):
        raise ValueError('HTTPS_REQUIRED')
    request = urllib.request.Request(target, data=b'{"event":"FAIR_STAGING_OPERATION_FAILED"}',
                                     headers={'Content-Type':'application/json'},method='POST')
    with urllib.request.urlopen(request, timeout=15) as response:
        if response.status >= 300:
            raise ValueError('ALERT_FAILED')
    print('OPERATOR_ALERT_SENT')
except Exception:
    print('OPERATOR_ALERT_FAILED')
    raise SystemExit(1)
