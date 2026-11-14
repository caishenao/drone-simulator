# -*- coding: utf-8 -*-
"""在当前 Blender 窗口把自建 drone 导出为 Gazebo SDF 可引用的 OBJ（Z-up，米制）。

输出 5 个网格：
  body.obj       机身 + 机臂 + 电机座 + 脚架 + 云台（世界坐标，机头 +Y）
  rotor_0..3.obj 四个旋翼，各自以桨毂中心为原点（可直接挂到 rotor_N link）

与 x500_base 的 rotor link 位姿对应关系（坐标已核对）：
  rotor_0 (+0.174,-0.174) <- Rotor_RR   (ccw)
  rotor_1 (-0.174,+0.174) <- Rotor_FL   (ccw)
  rotor_2 (+0.174,+0.174) <- Rotor_FR   (cw)
  rotor_3 (-0.174,-0.174) <- Rotor_RL   (cw)
"""
import json
import os
import traceback
from pathlib import Path

import bpy

OUT = Path(r'D:\work\self\无人机模型器\sim_px4\exports\x500_mini3pro_base\meshes')
OUT.mkdir(parents=True, exist_ok=True)

ROTOR_MAP = {
    'rotor_0': 'Rotor_RR',
    'rotor_1': 'Rotor_FL',
    'rotor_2': 'Rotor_FR',
    'rotor_3': 'Rotor_RL',
}
ROTOR_NAMES = set(ROTOR_MAP.values())


def obj_bounds(path):
    lo = [1e9] * 3
    hi = [-1e9] * 3
    with open(path, 'r', encoding='utf-8', errors='replace') as f:
        for line in f:
            if line.startswith('v '):
                p = [float(x) for x in line.split()[1:4]]
                for i in range(3):
                    lo[i], hi[i] = min(lo[i], p[i]), max(hi[i], p[i])
    return [round(x, 5) for x in lo], [round(x, 5) for x in hi]


def export(path, objs):
    for o in bpy.data.objects:
        o.select_set(False)
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.wm.obj_export(
        filepath=str(path),
        export_selected_objects=True,
        forward_axis='Y', up_axis='Z',   # 保持 Blender 的 Z-up，不做轴转换
        global_scale=1.0,
        apply_modifiers=True,
        export_materials=True,
        export_uv=True,
        export_normals=True,
        export_triangulated_mesh=False,
        path_mode='AUTO',
    )
    lo, hi = obj_bounds(path)
    return {'file': path.name, 'bytes': path.stat().st_size,
            'min': lo, 'max': hi, 'objects': len(objs)}


def export_rotor(tag, src_name):
    src = bpy.data.objects.get(src_name)
    if src is None:
        raise RuntimeError('missing ' + src_name)
    dup = src.copy()
    dup.data = src.data.copy()
    bpy.context.scene.collection.objects.link(dup)
    dup.name = 'TMP_' + tag
    dup.parent = None                 # 顶点原本已相对自身枢轴，去掉父级后正好在原点
    dup.location = (0, 0, 0)
    dup.rotation_euler = (0, 0, 0)
    dup.scale = (1, 1, 1)
    try:
        return export(OUT / (tag + '.obj'), [dup])
    finally:
        bpy.data.objects.remove(dup, do_unlink=True)


try:
    bpy.context.view_layer.update()
    meshes = [o for o in bpy.data.objects if o.type == 'MESH']
    body = [o for o in meshes if o.name not in ROTOR_NAMES]
    files = [export(OUT / 'body.obj', body)]
    for tag, src in ROTOR_MAP.items():
        files.append(export_rotor(tag, src))
    for o in bpy.data.objects:
        o.select_set(False)
    res = {'ok': True, 'out': str(OUT), 'files': files,
           'scale_to_x500': round(0.174 / 0.0873, 5)}
except Exception:
    res = {'ok': False, 'trace': traceback.format_exc()}

print('RESULT_JSON=' + json.dumps(res, ensure_ascii=False))
