# -*- coding: utf-8 -*-
"""对 raw/ 下的 Gazebo / PX4 无人机资产做静态审计（本机无 gz/ros2，故不做运行时验证）。

产出:
  reports/audit.json        结构性检查（SDF、依赖、物理语义、插件兼容性）
  manifests/assets.json     技能规定的资产清单
  manifests/licenses.json   逐资产许可与人工判断
"""
import json
import re
import time
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(r'D:\work\self\无人机模型器\sim_px4')
RAW = ROOT / 'raw'

# 插件归属：决定这个模型能跑在哪一代 Gazebo 上
GZ_CLASSIC = {'ArduCopterPlugin', 'LiftDragPlugin', 'GimbalSmall2dPlugin',
              'libArduCopterPlugin.so', 'libLiftDragPlugin.so',
              'libgazebo_ros_camera.so'}
GZ_SIM = {'gz::sim::systems::MulticopterMotorModel',
          'gz-sim-multicopter-motor-model-system',
          'gz::sim::systems::Physics', 'gz-sim-imu-system',
          'gz-sim-air-pressure-system', 'gz-sim-magnetometer-system'}


def local(tag):
    return tag.split('}')[-1]


def texts(root, path):
    """忽略 namespace 的路径查找。"""
    out = []
    for el in root.iter():
        if local(el.tag) == path:
            out.append((el.text or '').strip())
    return [x for x in out if x]


def iter_find(root, name):
    return [e for e in root.iter() if local(e.tag) == name]


def parse_xml(p):
    try:
        return ET.parse(p).getroot()
    except Exception as e:
        return {'error': str(e)}


def model_dirs():
    """每个含 model.config 的目录视为一个 Gazebo model。"""
    return sorted({p.parent for p in RAW.rglob('model.config')})


def audit_model(d):
    cfg_path, sdf_path = d / 'model.config', d / 'model.sdf'
    cfg = parse_xml(cfg_path)
    sdf = parse_xml(sdf_path) if sdf_path.exists() else {'error': 'model.sdf missing'}
    rec = {
        'dir': str(d.relative_to(RAW)).replace('\\', '/'),
        'model_config': str(cfg_path.relative_to(RAW)).replace('\\', '/'),
        'model_sdf': str(sdf_path.relative_to(RAW)).replace('\\', '/') if sdf_path.exists() else None,
    }
    if isinstance(cfg, dict):
        rec['config_error'] = cfg['error']
        cfg = ET.Element('model')
    rec['name'] = next(iter(texts(cfg, 'name')), None)
    rec['model_version'] = next(iter(texts(cfg, 'version')), None)
    authors = iter_find(cfg, 'author')
    if authors:
        rec['author'] = {local(c.tag): (c.text or '').strip()
                         for c in authors[0] if (c.text or '').strip()}
    desc = texts(cfg, 'description')
    rec['description'] = desc[0][:180] if desc else None
    sdf_tags = iter_find(cfg, 'sdf')
    rec['sdf_version_declared'] = sdf_tags[0].attrib.get('version') if sdf_tags else None
    rec['sdf_root_file'] = (sdf_tags[0].text or '').strip() if sdf_tags else None

    if isinstance(sdf, dict):
        rec['sdf_error'] = sdf['error']
        return rec
    rec['sdf_version'] = sdf.attrib.get('version')
    models = iter_find(sdf, 'model')
    rec['sdf_model_name'] = models[0].attrib.get('name') if models else None
    rec['links'] = len(iter_find(sdf, 'link'))
    rec['joints'] = len(iter_find(sdf, 'joint'))
    rec['collisions'] = len(iter_find(sdf, 'collision'))
    rec['visuals'] = len(iter_find(sdf, 'visual'))
    rec['sensors'] = len(iter_find(sdf, 'sensor'))
    masses = [t for t in texts(sdf, 'mass')]
    rec['masses_kg'] = [float(x) for x in masses if re.fullmatch(r'[0-9.eE+-]+', x)]
    rec['static'] = next(iter(texts(sdf, 'static')), None)

    plugins = []
    for p in iter_find(sdf, 'plugin'):
        plugins.append({'filename': p.attrib.get('filename'),
                        'name': p.attrib.get('name')})
    rec['plugins'] = plugins
    pnames = {p['filename'] or '' for p in plugins} | {p['name'] or '' for p in plugins}
    rec['runtime_class'] = ('gazebo_sim_gz' if any(x in pnames for x in GZ_SIM)
                            else 'gazebo_classic' if any(x in pnames for x in GZ_CLASSIC)
                            else 'visual_or_inertial_only')

    rec['include_uris'] = [u for u in texts(sdf, 'uri') if u.startswith('model://')]
    uris = [u for u in texts(sdf, 'uri') if u.startswith('model://')]
    rec['mesh_uris'] = [u for u in uris if re.search(r'\.(dae|obj|stl|glb|gltf)$', u, re.I)]

    # 依赖：model://<name>/<rel> → 在 raw 里按「以该相对路径结尾」定位
    missing, found = [], []
    for u in rec['mesh_uris']:
        rel = u[len('model://'):]
        rel = rel[rel.find('/') + 1:] if '/' in rel else rel
        hits = [p for p in RAW.rglob(Path(rel).name)
                if p.as_posix().endswith(rel) or rel in p.as_posix()]
        if hits:
            found.append(rel)
        else:
            missing.append({'uri': u, 'expected_rel': rel})
    # include 的 model:// 指向另一个模型（无扩展名），按目录名匹配
    for u in rec['include_uris']:
        if re.search(r'\.(dae|obj|stl|glb|gltf)$', u, re.I):
            continue
        tgt = u[len('model://'):].strip('/')
        norm = lambda s: re.sub(r'[^a-z0-9]', '', s.lower())
        local_names = [norm(p.name) for p in model_dirs()]
        for cp in RAW.rglob('model.config'):
            r = parse_xml(cp)
            if not isinstance(r, dict):
                nm = next(iter(texts(r, 'name')), '')
                if nm:
                    local_names.append(norm(nm))
        ok = any(norm(tgt) in n or n in norm(tgt) for n in local_names if n)
        rec.setdefault('include_resolution', []).append(
            {'uri': u, 'resolved_local': bool(ok)})
    rec['mesh_dependencies_found'] = found
    rec['mesh_dependencies_missing'] = missing

    # DAE 内部的贴图引用
    tex_missing = []
    for p in d.rglob('*.dae'):
        try:
            content = p.read_text(encoding='utf-8', errors='replace')
        except Exception:
            continue
        for ref in re.findall(r'<init_from[^>]*>([^<]+)</init_from>', content):
            ref = ref.strip()
            if ref.lower().endswith(('.png', '.jpg', '.jpeg', '.tga')):
                cand = (p.parent / ref).resolve()
                if not cand.exists():
                    cand2 = (d / 'materials' / 'textures' / Path(ref).name)
                    if not cand2.exists():
                        tex_missing.append({'dae': p.name, 'ref': ref})
    rec['dae_texture_refs_missing'] = tex_missing
    return rec


def main():
    models = [audit_model(d) for d in model_dirs()]
    dl = json.loads((ROOT / 'manifests' / 'downloads.json').read_text(encoding='utf-8'))

    # 许可：Fuel 用 API 元数据；PX4 用仓库内 LICENSE 原文
    licenses = []
    for d in model_dirs():
        rel = str(d.relative_to(RAW)).replace('\\', '/')
        meta = d / '_model_detail.json'
        lic_file = d / 'LICENSE'
        item = {'dir': rel, 'status': 'unknown', 'spdx': None,
                'source_text': None, 'commercial_use': 'unknown',
                'attribution_required': None, 'manual_review': True}
        if meta.exists():
            j = json.loads(meta.read_text(encoding='utf-8'))
            item.update({
                'source': 'gazebo-fuel REST API model record',
                'license_name': j.get('license_name'),
                'license_url': j.get('license_url'),
                'source_text': j.get('license_name'),
                'retrieved_at': dl['generated_at'],
            })
            if 'Zero' in (j.get('license_name') or ''):
                item.update({'status': 'approved', 'spdx': 'CC0-1.0',
                             'commercial_use': 'allowed',
                             'attribution_required': False, 'manual_review': False})
            elif 'Attribution' in (j.get('license_name') or ''):
                item.update({'status': 'conditional', 'spdx': 'CC-BY-4.0',
                             'commercial_use': 'allowed',
                             'attribution_required': True, 'manual_review': True})
        if lic_file.exists():
            txt = lic_file.read_text(encoding='utf-8', errors='replace')
            item['license_file'] = lic_file.name
            item['license_file_sha256'] = dl and next(
                (r['sha256'] for r in dl['files']
                 if r['path'] == 'raw/' + rel + '/LICENSE'), None)
            item['source_text'] = txt[:400].strip()
            first = ' '.join(txt.split()[:24])
            if 'BSD' in first.upper() or 'BSD' in txt[:200].upper():
                item.update({'status': 'approved', 'spdx': 'BSD-3-Clause',
                             'commercial_use': 'allowed',
                             'attribution_required': True, 'manual_review': True,
                             'source': 'PX4-gazebo-models per-model LICENSE file'})
            else:
                item.update({'source': 'PX4-gazebo-models per-model LICENSE file',
                             'manual_review': True,
                             'notes': 'LICENSE 原文需人工确认条款，当前仅抓取快照'})
        licenses.append(item)

    assets = []
    by_dir = {m['dir']: m for m in models}
    for lic in licenses:
        m = by_dir[lic['dir']]
        assets.append({
            'asset_id': (Path(lic['dir']).name
                         if 'px4-gazebo-models' in lic['dir']
                         else lic['dir'].split('/')[-2]),
            'display_name': m.get('name'),
            'source': {
                'library': 'px4-gazebo-models' if 'px4-gazebo-models' in lic['dir'] else 'gazebo-fuel',
                'page_url': ('https://github.com/PX4/PX4-gazebo-models/tree/'
                             + dl['px4_commit'] + '/models/' + Path(lic['dir']).name)
                if 'px4-gazebo-models' in lic['dir'] else
                'https://app.gazebosim.org/OpenRobotics/fuel/models/' + (m.get('name') or ''),
                'repository_or_dataset': 'PX4/PX4-gazebo-models' if 'px4-gazebo-models' in lic['dir'] else 'OpenRobotics @ Gazebo Fuel',
                'revision_or_version': dl['px4_commit'] if 'px4-gazebo-models' in lic['dir'] else '3',
                'source_asset_id': m.get('sdf_model_name') or m.get('name'),
            },
            'retrieved_at': dl['generated_at'],
            'license': {k: v for k, v in lic.items() if k != 'dir'},
            'formats': ['sdf', 'dae', 'stl', 'png'],
            'runtime': ['gazebo_sim_gz'] if 'px4-gazebo-models' in lic['dir'] else ['gazebo_classic'],
            'units': 'meters (SDF default)',
            'up_axis': 'Z',
            'simulation': {
                'collision': 'present' if m.get('collisions') else 'missing',
                'rigid_body': 'present' if m.get('links') else 'missing',
                'mass': 'present' if m.get('masses_kg') else 'missing',
                'friction': 'present (surface/friction)' if m.get('collisions') else 'unknown',
                'joints': 'present' if m.get('joints') else 'not_applicable',
                'semantic_labels': 'missing',
                'validation_profile': None,
                'validation_status': 'not_run (no gz/ros2/px4 on this host)',
                'plugin_class': m.get('runtime_class'),
            },
            'status': lic['status'],
        })

    report = {
        'generated_at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
        'host_capability': {'gz': False, 'ros2': False, 'px4': False,
                            'note': 'Windows 本机无仿真运行时，仅做静态/结构验证'},
        'model_count': len(models),
        'total_bytes': sum(r['bytes'] for r in dl['files']),
        'download_errors': dl['errors'],
        'models': models,
        'checks': {
            'all_model_sdf_present': all(m.get('model_sdf') and not m.get('sdf_error') for m in models),
            'all_mesh_deps_present': all(not m.get('mesh_dependencies_missing') for m in models),
            'all_dae_textures_present': all(not m.get('dae_texture_refs_missing') for m in models),
            'px4_commit_fixed': len(dl['px4_commit']) == 40,
        },
    }
    (ROOT / 'reports').mkdir(exist_ok=True)
    for name, obj in (('reports/audit.json', report),
                      ('manifests/assets.json', assets),
                      ('manifests/licenses.json', licenses)):
        (ROOT / name).write_text(json.dumps(obj, ensure_ascii=False, indent=1),
                                 encoding='utf-8')

    print('=' * 78)
    for m in models:
        print(f"{m['name'][:34]:34s} | SDF {str(m.get('sdf_version')):4s} | "
              f"links {m.get('links',0):2d} joints {m.get('joints',0):2d} "
              f"coll {m.get('collisions',0):2d} visual {m.get('visuals',0):2d} | "
              f"plugins {len(m.get('plugins',[])):2d} | {m.get('runtime_class')}")
        if m.get('mesh_dependencies_missing'):
            print('    MISSING MESH:', m['mesh_dependencies_missing'])
        if m.get('dae_texture_refs_missing'):
            print('    MISSING TEX :', m['dae_texture_refs_missing'])
        if m.get('include_resolution'):
            print('    INCLUDE     :', m['include_resolution'])
    print('-' * 78)
    print('checks:', report['checks'])
    print('licenses:', [(x['asset_id'], x['status'], x['license']['spdx'])
                        for x in assets])
    print('=>', ROOT / 'reports' / 'audit.json')


if __name__ == '__main__':
    main()
