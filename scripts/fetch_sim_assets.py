# -*- coding: utf-8 -*-
"""按 digital-twin-open-3d-assets 流程，固定版本下载仿真原生无人机资产。

来源（全部官方接口，不用爬虫猜 URL）：
  1. Gazebo Fuel REST API v1.0，固定 model version=3
  2. PX4/PX4-gazebo-models GitHub，固定 40 字符 commit SHA

原始文件写入 raw/ 且只读；每个文件记录 URL、bytes、SHA-256、抓取时间。
用法: python scripts/fetch_sim_assets.py
"""
import hashlib
import json
import os
import time
import urllib.parse
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(r'D:\work\self\无人机模型器\sim_px4')
RAW = ROOT / 'raw'
META = ROOT / 'manifests'
FUEL = 'https://fuel.gazebosim.org/1.0'
PX4_SHA = 'e5997f455e33ec071c7c677fc59a65781de496a4'   # 2026-10-04, 完整 40 字符 commit
PX4_REPO = 'PX4/PX4-gazebo-models'
UA = {'User-Agent': 'DigitalTwinAssetSkill/1.0 (local audit)'}
ALLOWED_EXT = {'.sdf', '.config', '.dae', '.obj', '.mtl', '.stl', '.png',
               '.jpg', '.jpeg', '.txt', '.xml', '.glb', '.gltf', '.license',
               '.json', '.md', ''}
MAX_FILE = 30 * 1024 * 1024

FUEL_MODELS = [
    ('fuel_parrot_bebop_2', 'OpenRobotics', 'Parrot Bebop 2', 3),
    ('fuel_iris_standoffs', 'OpenRobotics', 'Iris with Standoffs', 3),
    ('fuel_iris_arducopter', 'OpenRobotics',
     'Iris with Standoffs and Camera LiftDrag ArduCopter Plugins', 3),
]
PX4_PREFIXES = ('models/x500/', 'models/x500_base/')

records = []
errors = []


def get(url, timeout=45):
    last = None
    for attempt in range(3):
        try:
            req = urllib.request.Request(url, headers=UA)
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read()
        except Exception as e:
            last = e
            time.sleep(0.8 * (attempt + 1))
    raise last


def get_json(url):
    return json.loads(get(url).decode('utf-8'))


def safe_rel(path):
    p = path.replace('\\', '/').lstrip('/')
    parts = [x for x in p.split('/') if x not in ('', '.')]
    if any(x == '..' for x in parts):
        raise ValueError('path traversal: ' + path)
    return '/'.join(parts)


def save(rel, data, source_url, extra=None):
    rel = safe_rel(rel)
    ext = Path(rel).suffix.lower()
    if ext not in ALLOWED_EXT:
        raise ValueError('unexpected file type: ' + rel)
    if len(data) > MAX_FILE:
        raise ValueError('file too large: ' + rel)
    dst = RAW / rel
    dst.parent.mkdir(parents=True, exist_ok=True)
    # raw/ 只读：重跑时内容一致就不重写，避免覆盖已固定的原始文件
    if dst.exists():
        if dst.read_bytes() != data:
            raise ValueError('raw file changed upstream, abort: ' + rel)
    else:
        dst.write_bytes(data)
    rec = {
        'path': 'raw/' + rel,
        'source_url': source_url,
        'bytes': len(data),
        'sha256': hashlib.sha256(data).hexdigest(),
        'retrieved_at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
    }
    if extra:
        rec.update(extra)
    records.append(rec)
    return dst


def walk_tree(items, prefix=''):
    for it in items:
        path = it.get('path', '')
        if 'children' in it:
            yield from walk_tree(it['children'], prefix)
        else:
            yield path.lstrip('/')


def fetch_fuel(asset_id, owner, name, version):
    base = f'{FUEL}/{owner}/models/{urllib.parse.quote(name)}'
    detail = get_json(base)
    tree = get_json(base + f'/{version}/files')
    assert detail.get('version') == version, (name, detail.get('version'))
    save(f'gazebo-fuel/{owner}/{asset_id}/{version}/_model_detail.json',
         json.dumps(detail, ensure_ascii=False, indent=1).encode('utf-8'),
         base, {'kind': 'metadata'})
    save(f'gazebo-fuel/{owner}/{asset_id}/{version}/_file_tree.json',
         json.dumps(tree, ensure_ascii=False, indent=1).encode('utf-8'),
         base + f'/{version}/files', {'kind': 'metadata'})
    paths = list(walk_tree(tree.get('file_tree', [])))
    for p in paths:
        if p.startswith('thumbnails/'):
            continue                      # 缩略图不进仿真资产，保留体积记录即可
        url = f'{base}/{version}/files/{urllib.parse.quote(p)}'
        try:
            save(f'gazebo-fuel/{owner}/{asset_id}/{version}/{p}',
                 get(url), url,
                 {'asset_id': asset_id, 'revision_or_version': str(version)})
        except Exception as e:
            errors.append(f'{asset_id}:{p}: {e}')
    print(f'[Fuel] {asset_id} v{version}: {len(paths)} entries, '
          f'license={detail.get("license_name")}')


def fetch_px4():
    tree_url = (f'https://api.github.com/repos/{PX4_REPO}/git/trees/'
                f'{PX4_SHA}?recursive=1')
    tree = get_json(tree_url)
    if tree.get('truncated'):
        errors.append('PX4 git tree truncated -> need per-directory contents API')
    picked = [x for x in tree['tree']
              if x['type'] == 'blob' and x['path'].startswith(PX4_PREFIXES)]
    save(f'px4-gazebo-models/{PX4_SHA}/_git_tree.json',
         json.dumps({'sha': PX4_SHA, 'picked': [x['path'] for x in picked]},
                    ensure_ascii=False, indent=1).encode('utf-8'),
         tree_url, {'kind': 'metadata'})
    for x in picked:
        p = x['path']
        # 只排除缩略图；materials/textures 与 meshes/*.png 是 DAE 的贴图依赖，必须保留
        if '/thumbnails/' in p:
            continue
        url = (f'https://raw.githubusercontent.com/{PX4_REPO}/{PX4_SHA}/'
               + urllib.parse.quote(p))
        try:
            data = get(url)
            save(f'px4-gazebo-models/{PX4_SHA}/{p}', data, url,
                 {'asset_id': 'px4_x500', 'revision_or_version': PX4_SHA,
                  'git_blob_sha': x.get('sha')})
        except Exception as e:
            errors.append(f'px4:{p}: {e}')
    keep = [x for x in picked if '/thumbnails/' not in x['path']]
    print(f'[PX4] commit {PX4_SHA[:12]}: {len(picked)} blobs in tree, '
          f'{len(keep)} dependency files downloaded')


def main():
    for d in ('raw', 'manifests', 'reports', 'normalized', 'exports'):
        (ROOT / d).mkdir(parents=True, exist_ok=True)
    for a in FUEL_MODELS:
        try:
            fetch_fuel(*a)
        except Exception as e:
            errors.append(f'{a[0]}: {e}')
    try:
        fetch_px4()
    except Exception as e:
        errors.append(f'px4: {e}')

    META.mkdir(parents=True, exist_ok=True)
    out = {
        'generated_at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
        'sources': {
            'gazebo-fuel': FUEL,
            'px4-gazebo-models': f'https://github.com/{PX4_REPO}/tree/{PX4_SHA}',
        },
        'px4_commit': PX4_SHA,
        'files': records,
        'errors': errors,
    }
    (META / 'downloads.json').write_text(
        json.dumps(out, ensure_ascii=False, indent=1), encoding='utf-8')
    print('-' * 70)
    print(f'downloaded files : {len(records)}')
    print(f'total bytes      : {sum(r["bytes"] for r in records):,}')
    print(f'errors           : {len(errors)}')
    for e in errors[:10]:
        print('  !', e)
    print('manifest         :', META / 'downloads.json')


if __name__ == '__main__':
    main()
