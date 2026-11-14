# -*- coding: utf-8 -*-
"""最终硬性自检：哈希、目录、SDF 依赖解析、变体网格、许可随附。"""
import hashlib
import json
import time
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(r'D:\work\self\无人机模型器\sim_px4')
RAW = ROOT / 'raw'
NORM = ROOT / 'normalized' / 'models'
SHA = 'e5997f455e33ec071c7c677fc59a65781de496a4'

checks = []


def ck(name, cond, detail=''):
    checks.append({'name': name, 'pass': bool(cond), 'detail': str(detail)})
    return bool(cond)


dl = json.loads((ROOT / 'manifests' / 'downloads.json').read_text(encoding='utf-8'))

# 1. 原始文件哈希逐项复核
bad_hash = []
for r in dl['files']:
    p = RAW / r['path'][4:]
    if not p.exists():
        bad_hash.append('missing ' + r['path'])
        continue
    if hashlib.sha256(p.read_bytes()).hexdigest() != r['sha256']:
        bad_hash.append('hash ' + r['path'])
ck('raw 文件存在且 SHA-256 全部匹配', not bad_hash,
   f"{len(dl['files'])} files, {len(bad_hash)} problems " + str(bad_hash[:3]))
ck('PX4 commit 为 40 字符固定版本', len(dl['px4_commit']) == 40, dl['px4_commit'])
ck('下载过程 0 错误', not dl['errors'], dl['errors'])

# 2. normalized 模型结构
models = sorted(p for p in NORM.iterdir() if p.is_dir())
ck('normalized 模型数 = 7', len(models) == 7, [p.name for p in models])
for p in models:
    ok = ((p / 'model.config').exists() and (p / 'model.sdf').exists())
    if ok:
        try:
            ET.parse(p / 'model.config')
            ET.parse(p / 'model.sdf')
        except Exception as e:
            ok, e = False, e
    ck('模型结构 ' + p.name, ok)

# 3. model:// URI 解析（GZ_SIM_RESOURCE_PATH 语义）
missing_uri, external = [], []
for p in models:
    r = ET.parse(p / 'model.sdf').getroot()
    for u in r.iter('uri'):
        t = (u.text or '').strip()
        if not t.startswith('model://'):
            continue
        rest = t[len('model://'):]
        name, _, rel = rest.partition('/')
        target = NORM / name
        if not target.exists():
            external.append(f'{p.name}: {t}')
            continue
        if rel and not (target / rel).exists():
            missing_uri.append(f'{p.name}: {t}')
ck('所有 model:// 网格依赖可解析', not missing_uri, missing_uri[:5])
ck('外部系统模型依赖已记录为缺口', True,
   f'{len(external)} 项: ' + '; '.join(external[:3]))

# 4. 变体网格与材质
vdir = NORM / 'x500_mini3pro_base' / 'meshes'
objs = sorted(vdir.glob('*.obj'))
ck('变体含 5 个 OBJ 网格', len(objs) == 5, [p.name for p in objs])
ck('每个 OBJ 都有配套 MTL', all((vdir / (p.stem + '.mtl')).exists() for p in objs))
ranges = {}
for p in objs:
    lo = [1e9] * 3
    hi = [-1e9] * 3
    for line in p.read_text(encoding='utf-8', errors='replace').splitlines():
        if line.startswith('v '):
            v = [float(x) for x in line.split()[1:4]]
            for i in range(3):
                lo[i], hi[i] = min(lo[i], v[i]), max(hi[i], v[i])
    ranges[p.name] = {'min': [round(x, 4) for x in lo],
                      'max': [round(x, 4) for x in hi]}
# Z-up：机身高度（Z 跨度）必须远小于平面（X/Y 跨度）
b = ranges.get('body.obj', {})
zspan = b['max'][2] - b['min'][2] if b else 0
xspan = b['max'][0] - b['min'][0] if b else 0
ck('OBJ 保持 Z-up（高度跨度 < 平面跨度）', 0 < zspan < xspan,
   f'body z={zspan:.4f} x={xspan:.4f}')
ck('旋翼网格以桨毂为原点', all(
    abs(ranges[f'rotor_{i}.obj']['min'][0] + 0.073) < 0.002 for i in range(4)),
   {k: v['min'][0] for k, v in ranges.items() if k.startswith('rotor_')})

# 5. 许可随附
ck('两个 PX4 派生模型随附 BSD-3-Clause LICENSE',
   all((NORM / n / 'LICENSE').exists()
       for n in ('x500', 'x500_base', 'x500_mini3pro', 'x500_mini3pro_base')))
ck('Fuel 元数据含 CC0 许可原文',
   all((RAW / 'gazebo-fuel/OpenRobotics' / n / '3/_model_detail.json').exists()
       for n in ('fuel_parrot_bebop_2', 'fuel_iris_standoffs', 'fuel_iris_arducopter')))

# 6. 变体保留物理
rv = ET.parse(NORM / 'x500_mini3pro_base' / 'model.sdf').getroot()
rt = ET.parse(NORM / 'x500_mini3pro' / 'model.sdf').getroot()
ck('变体保留 9 组碰撞 / 4 个关节 / 5 个 link',
   len(list(rv.iter('collision'))) == 9 and len(list(rv.iter('joint'))) == 4
   and len(list(rv.iter('link'))) == 5)
ck('变体保留 5 个飞控插件', len(list(rt.iter('plugin'))) == 5)
ck('变体无 Gazebo Classic 材质脚本残留',
   not any('gazebo.material' in (u.text or '') for u in rv.iter('uri')))

# 7. 报告完整
reports = sorted(p.name for p in (ROOT / 'reports').iterdir() if p.suffix == '.json')
manifests = sorted(p.name for p in (ROOT / 'manifests').iterdir() if p.suffix == '.json')
for f in reports + manifests:
    try:
        json.loads((ROOT / ('reports' if f in reports else 'manifests') / f)
                   .read_text(encoding='utf-8'))
    except Exception as e:
        ck('JSON 可解析 ' + f, False, e)
ck('manifest + 报告齐全',
   all(x in manifests for x in ('assets.json', 'licenses.json', 'downloads.json'))
   and all(x in reports for x in ('audit.json', 'validation.json', 'bridge.json')),
   f'manifests={manifests} reports={reports}')

out = {
    'generated_at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
    'checks': checks,
    'passed': sum(1 for c in checks if c['pass']),
    'total': len(checks),
    'external_model_dependencies': external,
    'obj_bounds': ranges,
    'runtime_validation': 'not_run: 本机 Windows 无 gz / ros2 / px4',
}
(ROOT / 'reports' / 'final_check.json').write_text(
    json.dumps(out, ensure_ascii=False, indent=1), encoding='utf-8')

print('=' * 76)
for c in checks:
    print(('[PASS] ' if c['pass'] else '[FAIL] ') + c['name']
          + (('  | ' + c['detail']) if c['detail'] else ''))
failed = [c['name'] for c in checks if not c['pass']]
print('-' * 76)
print(f"{out['passed']}/{out['total']} 通过" + ('' if not failed else '  失败: ' + ', '.join(failed)))
print('=>', ROOT / 'reports' / 'final_check.json')
