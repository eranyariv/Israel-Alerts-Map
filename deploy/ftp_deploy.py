"""
FTP deploy script — uploads frontend/dist -> yariv.org/map/
and deploy/ -> yariv.org/ (root)
"""
import ftplib
import os
import mimetypes
from pathlib import Path

FTP_HOST = '50.6.34.78'
FTP_USER = 'wnuonimy'
FTP_PASS = 'sgFccK6WmIBtrGgT'
FTP_PORT = 21

FRONTEND_DIST = Path(__file__).parent.parent / 'frontend' / 'dist'
DEPLOY_DIR    = Path(__file__).parent

REMOTE_MAP_ROOT  = '/public_html/map'
REMOTE_SITE_ROOT = '/public_html'

DEPLOY_FILES = [
    ('index.html', '/public_html/index.html'),
]

def upload_file(ftp, local_path, remote_path):
    remote_dir = remote_path.rsplit('/', 1)[0]
    try:
        ftp.mkd(remote_dir)
    except ftplib.error_perm:
        pass
    with open(local_path, 'rb') as f:
        ftp.storbinary(f'STOR {remote_path}', f)
    print(f'  OK {remote_path}')

def upload_tree(ftp, local_root, remote_root):
    for local_file in sorted(local_root.rglob('*')):
        if not local_file.is_file():
            continue
        rel = local_file.relative_to(local_root)
        remote_path = remote_root + '/' + str(rel).replace('\\', '/')
        remote_dir  = remote_path.rsplit('/', 1)[0]
        # ensure all dirs exist
        parts = remote_dir.split('/')
        for i in range(2, len(parts) + 1):
            d = '/'.join(parts[:i])
            try:
                ftp.mkd(d)
            except ftplib.error_perm:
                pass
        with open(local_file, 'rb') as f:
            ftp.storbinary(f'STOR {remote_path}', f)
        print(f'  OK {remote_path}')

def main():
    print(f'Connecting to {FTP_HOST}...')
    with ftplib.FTP() as ftp:
        ftp.connect(FTP_HOST, FTP_PORT)
        ftp.login(FTP_USER, FTP_PASS)
        ftp.set_pasv(True)
        print('Connected.')

        print(f'\nUploading frontend/dist -> {REMOTE_MAP_ROOT}')
        upload_tree(ftp, FRONTEND_DIST, REMOTE_MAP_ROOT)

        print(f'\nUploading deploy files -> {REMOTE_SITE_ROOT}')
        for local_name, remote_path in DEPLOY_FILES:
            local_path = DEPLOY_DIR / local_name
            if local_path.exists():
                upload_file(ftp, local_path, remote_path)
            else:
                print(f'  SKIP skipped (not found): {local_path}')

    print('\nDeploy complete.')

if __name__ == '__main__':
    main()
