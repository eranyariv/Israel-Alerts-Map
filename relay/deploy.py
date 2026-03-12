"""
Relay deploy script — bumps version by 0.01, builds in ACR, deploys to Container App.
Usage: python relay/deploy.py
"""
import json
import re
import subprocess
import sys
from pathlib import Path

RELAY_DIR     = Path(__file__).parent
PKG_FILE      = RELAY_DIR / 'package.json'
YAML_FILE     = RELAY_DIR / 'containerapp.yaml'
ACR_NAME      = 'redalertrelay'
IMAGE         = 'redalert-relay:latest'
APP_NAME      = 'redalert-relay'
RESOURCE_GROUP = 'redalert-relay-rg'


def run(args, **kwargs):
    print(f'\n$ {" ".join(args)}')
    result = subprocess.run(
        ['powershell.exe', '-NoProfile', '-Command', ' '.join(f'"{a}"' if ' ' in a else a for a in args)],
        **kwargs
    )
    if result.returncode != 0:
        print(f'ERROR: command failed with exit code {result.returncode}')
        sys.exit(result.returncode)


def bump_version(current: str) -> str:
    try:
        val = round(float(current) + 0.01, 10)
        # Format as X.YY — preserving at least 2 decimal places
        major = int(val)
        frac  = round(val - major, 10)
        cents = round(frac * 100)
        return f'{major}.{cents:02d}'
    except ValueError:
        print(f'WARNING: could not parse version "{current}", starting at 1.00')
        return '1.00'


def main():
    # ── Bump version ──────────────────────────────────────────────────────
    pkg     = json.loads(PKG_FILE.read_text(encoding='utf-8'))
    old_ver = pkg['version']
    new_ver = bump_version(old_ver)
    pkg['version'] = new_ver
    PKG_FILE.write_text(json.dumps(pkg, indent=2) + '\n', encoding='utf-8')
    print(f'Version: {old_ver} -> {new_ver}')

    # ── Update revision suffix in containerapp.yaml ────────────────────────
    yaml_text = YAML_FILE.read_text(encoding='utf-8')
    suffix    = 'v' + new_ver.replace('.', '-')
    yaml_text = re.sub(r'revisionSuffix:.*', f'revisionSuffix: {suffix}', yaml_text)
    YAML_FILE.write_text(yaml_text, encoding='utf-8')
    print(f'Revision suffix: {suffix}')

    # ── Build image in ACR ────────────────────────────────────────────────
    run(['az', 'acr', 'build', '--registry', ACR_NAME, '--image', IMAGE, str(RELAY_DIR)])

    # ── Deploy to Container App ───────────────────────────────────────────
    run(['az', 'containerapp', 'update',
         '--name', APP_NAME,
         '--resource-group', RESOURCE_GROUP,
         '--yaml', str(YAML_FILE),
         '--query', '{revision:properties.latestRevisionName, state:properties.provisioningState}',
         '-o', 'json'])

    print(f'\nRelay v{new_ver} deployed.')


if __name__ == '__main__':
    main()
