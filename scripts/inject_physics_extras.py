# -*- coding: utf-8 -*-
"""把统一物理参数写进 GLB 的 Drone_Root extras，让物理数据随模型一起走。

只改 JSON chunk 内容，BIN chunk 原样保留（bufferView 偏移不受影响）。
JSON chunk 按 glTF 规范用空格补齐到 4 字节；可重复执行（幂等）。
"""
import hashlib
import json
import struct
from pathlib import Path

ROOT = Path(r'D:\work\self\无人机模型器')
GLB = ROOT / 'drone_mini3pro.glb'
PHYS = ROOT / 'physics' / 'physics.json'

ph = json.loads(PHYS.read_text(encoding='utf-8'))
compact = {
    'schema': ph['schema'],
    'source': 'physics/physics.json',
    'mass_kg': ph['body']['mass_kg'],
    'inertia_kgm2': ph['body']['inertia_kgm2'],
    'motor_x_m': ph['geometry']['motor_x_m'],
    'motor_z_m': ph['geometry']['motor_z_m'],
    'wheelbase_diag_m': ph['geometry']['diagonal_wheelbase_m'],
    'contact_radius_m': ph['geometry']['contact_radius_m'],
    'body_bottom_offset_m': ph['geometry']['body_bottom_offset_m'],
    'contact_clearance_m': ph['geometry']['contact_clearance_m'],
    'contact_points_local_m': ph['geometry']['contact_points_local_m'],
    'k_thrust': ph['rotor']['k_thrust_n_per_rad2s2'],
    'k_torque': ph['rotor']['k_torque_nm_per_rad2s2'],
    'torque_to_thrust_ratio_m': ph['rotor']['torque_to_thrust_ratio_m'],
    'max_thrust_total_n': ph['rotor']['max_thrust_total_n'],
    'hover_throttle': ph['control']['throttle_hover'],
    'rotor_order': ph['rotor']['order'],
    'spin': ph['rotor']['spin'],
    'rotor_axis_gltf': 'Y',
    'gimbal_axis_gltf': 'X',
    'gravity_mps2': ph['environment']['gravity_mps2'],
    'linear_drag_kg_per_s': ph['environment']['linear_drag_kg_per_s'],
    'angular_drag_nms': ph['environment']['angular_drag_nms'],
    'restitution': ph['environment']['restitution'],
    'friction': ph['environment']['friction'],
    'fixed_step_s': ph['integration']['fixed_step_s'],
    'note': 'inertia is estimated from mass distribution, not vendor-measured',
}

raw = GLB.read_bytes()
magic, version, total = struct.unpack_from('<4sII', raw, 0)
assert magic == b'glTF' and version == 2 and total == len(raw)
off, chunks = 12, []
while off < len(raw):
    length, ctype = struct.unpack_from('<I4s', raw, off)
    chunks.append((ctype, raw[off + 8: off + 8 + length]))
    off += 8 + length
assert len(chunks) == 2 and chunks[0][0] == b'JSON' and chunks[1][0] == b'BIN\x00'

js = json.loads(chunks[0][1].decode('utf-8'))
nodes = js['nodes']
target = next((n for n in nodes if n.get('name') == 'Drone_Root'), None)
assert target is not None, 'Drone_Root not found'
extras = dict(target.get('extras') or {})
# three.js 自动把 extras 映射到 userData，因此前端可直接读 userData.physics
extras['physics'] = compact
extras['物理参数'] = '见 physics 字段；参数源 physics/physics.json'
target['extras'] = extras

new_json = json.dumps(js, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
new_json += b' ' * ((4 - len(new_json) % 4) % 4)
bin_data = chunks[1][1]                       # 原样保留，含原有 padding
new_len = 12 + 8 + len(new_json) + 8 + len(bin_data)
out = (struct.pack('<4sII', b'glTF', 2, new_len)
       + struct.pack('<I4s', len(new_json), b'JSON') + new_json
       + struct.pack('<I4s', len(bin_data), b'BIN\x00') + bin_data)
assert struct.unpack_from('<I', out, 8)[0] == len(out)

GLB.write_bytes(out)

# 重新解析回读验证
chk = GLB.read_bytes()
j2 = json.loads(chk[20:20 + struct.unpack_from('<I', chk, 12)[0]].decode('utf-8'))
root2 = next(n for n in j2['nodes'] if n.get('name') == 'Drone_Root')
print('GLB           :', GLB)
print('bytes         :', len(raw), '->', len(chk))
print('sha256        :', hashlib.sha256(chk).hexdigest()[:20])
print('nodes/meshes  :', len(j2['nodes']), '/', len(j2['meshes']))
print('extras keys   :', sorted(root2['extras'].keys()))
print('physics.mass  :', root2['extras']['physics']['mass_kg'])
print('physics.spin  :', root2['extras']['physics']['spin'])
print('BIN unchanged :', chk[20 + struct.unpack_from('<I', chk, 12)[0] + 8:
                             20 + struct.unpack_from('<I', chk, 12)[0] + 8 + len(bin_data)] == bin_data)
