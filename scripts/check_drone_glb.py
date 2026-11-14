# -*- coding: utf-8 -*-
"""本地解析 GLB（不依赖 Blender），对跨引擎可用性做硬性断言。"""
import json
import math
import os
import struct

GLB = r'D:\work\self\无人机模型器\drone_mini3pro.glb'

raw = open(GLB, 'rb').read()
magic, version, total = struct.unpack_from('<4sII', raw, 0)
assert magic == b'glTF' and version == 2 and total == len(raw), 'GLB 头不合法'

off, chunks = 12, {}
while off < len(raw):
    length, ctype = struct.unpack_from('<I4s', raw, off)
    chunks[ctype.strip(b'\x00').decode()] = raw[off + 8: off + 8 + length]
    off += 8 + length
js = json.loads(chunks['JSON'].decode('utf-8'))

nodes = js['nodes']
by_name = {n.get('name'): (i, n) for i, n in enumerate(nodes)}
parent = {}
for i, n in enumerate(nodes):
    for c in n.get('children', []):
        parent[c] = i


def world_translation(idx):
    """本模型无 rotation/scale，逐层累加 translation 即可。"""
    out = [0.0, 0.0, 0.0]
    while idx is not None:
        n = nodes[idx]
        assert 'matrix' not in n, '出现未预期的 matrix 节点'
        t = n.get('translation', [0, 0, 0])
        for k in range(3):
            out[k] += t[k]
        idx = parent.get(idx)
    return out


def close(a, b, tol=0.002):
    return all(abs(x - y) <= tol for x, y in zip(a, b))


checks = []


def ck(name, cond, detail=''):
    checks.append((name, bool(cond), detail))
    return cond


ck('GLB 头 / JSON chunk', magic == b'glTF' and 'BIN' in chunks,
   f'{len(raw):,} bytes, version={version}')
ck('节点总数 = 28', len(nodes) == 28, str(len(nodes)))
ck('节点名全 ASCII', all(n.get('name', '').isascii() for n in nodes), '')
ck('根节点 Drone_Root', 'Drone_Root' in by_name, '')
ck('根节点 extras 带坐标约定',
   '坐标约定' in by_name['Drone_Root'][1].get('extras', {}),
   str(list(by_name['Drone_Root'][1].get('extras', {}).keys())))
_phy = by_name['Drone_Root'][1].get('extras', {}).get('physics', {})
ck('根节点 extras 带完整物理参数',
   _phy.get('mass_kg') == 0.249
   and _phy.get('spin') == [1, -1, -1, 1]
   and _phy.get('rotor_axis_gltf') == 'Y'
   and len(_phy.get('inertia_kgm2', [])) == 3,
   'mass=%s inertia=%s spin=%s' % (_phy.get('mass_kg'),
                                   _phy.get('inertia_kgm2'), _phy.get('spin')))
ck('无烘焙动画', len(js.get('animations', [])) == 0,
   str(len(js.get('animations', []))))
ck('无相机 / 灯光节点', 'cameras' not in js and 'KHR_lights_punctual' not in js.get('extensionsUsed', []), '')
ck('材质数 = 14', len(js.get('materials', [])) == 14,
   str(len(js.get('materials', []))))
ck('mesh 数 = 26', len(js.get('meshes', [])) == 26,
   str(len(js.get('meshes', []))))

# 三角面数
tris = 0
for m in js['meshes']:
    for p in m['primitives']:
        tris += js['accessors'][p['indices']]['count'] // 3
ck('三角面数 = 6972', tris == 6972, str(tris))

# 四个旋翼：枢轴、层级、extras、转向
MX = 0.247 / (2 * math.sqrt(2))
expected_spin = {'FL': 1, 'FR': -1, 'RL': -1, 'RR': 1}
for tag, sx, sy in (('FL', -1, 1), ('FR', 1, 1), ('RL', -1, -1), ('RR', 1, -1)):
    name = 'Rotor_' + tag
    ok = name in by_name
    if ok:
        idx, n = by_name[name]
        w = world_translation(idx)
        ok &= close(w, [sx * MX, 0.0355, -sy * MX])
        ex = n.get('extras', {})
        ok &= ex.get('旋转轴_glTF_Godot') == 'Y'
        ok &= ex.get('转向') == expected_spin[tag]
        ok &= ex.get('部件') == '旋翼'
        pname = nodes[parent[idx]].get('name')
        ok &= pname == 'Arm_' + tag
        ck(name + ' 枢轴/父级/extras/转向', ok,
           f'world=[{w[0]:.4f},{w[1]:.4f},{w[2]:.4f}] parent={pname} spin={ex.get("转向")}')
    else:
        ck(name + ' 存在', False)

gp = by_name.get('Gimbal_Pivot')
ck('Gimbal_Pivot 独立节点 + 驱动说明',
   bool(gp) and '驱动' in gp[1].get('extras', {}),
   str(gp[1].get('translation')) if gp else 'missing')
ck('云台子节点挂到 Gimbal_Pivot',
   all(nodes[parent[by_name[k][0]]].get('name') == 'Gimbal_Pivot'
       for k in ('Gimbal_Camera', 'Gimbal_Lens')), '')

# 包围盒：直接取 accessor min/max + 节点全局 translation（不自己乘变换矩阵）
lo = [1e9] * 3
hi = [-1e9] * 3
for i, n in enumerate(nodes):
    if 'mesh' not in n:
        continue
    t = world_translation(i)
    for p in js['meshes'][n['mesh']]['primitives']:
        acc = js['accessors'][p['attributes']['POSITION']]
        if 'min' not in acc:
            continue
        for k in range(3):
            lo[k] = min(lo[k], acc['min'][k] + t[k])
            hi[k] = max(hi[k], acc['max'][k] + t[k])
ck('包围盒 X ±0.160 / Y -0.049~0.039 / Z ±0.105',
   close(lo, [-0.1603, -0.0489, -0.1054], 0.003)
   and close(hi, [0.1603, 0.0392, 0.1021], 0.003),
   f'min={[round(v,4) for v in lo]} max={[round(v,4) for v in hi]}')

print('=' * 74)
print('GLB 跨引擎自检:', GLB)
print('=' * 74)
for name, ok, detail in checks:
    print(('[PASS] ' if ok else '[FAIL] ') + name + (('  | ' + detail) if detail else ''))
failed = [c for c in checks if not c[1]]
print('-' * 74)
print(f'{len(checks) - len(failed)}/{len(checks)} 通过'
      + ('' if not failed else '  失败: ' + ', '.join(c[0] for c in failed)))

# 层级树摘要（给前端 / Godot 按名查找用）
print('-' * 74)
print('节点层级:')
for i, n in enumerate(nodes):
    if i not in parent:
        print('  ' + n.get('name'))
    elif parent[i] == by_name['Drone_Root'][0]:
        print('    +- ' + n.get('name'))
    else:
        print('       +- ' + n.get('name'))
