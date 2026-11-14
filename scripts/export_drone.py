# -*- coding: utf-8 -*-
"""单独一次 MCP 调用导出 GLB。

build_drone.py 里 reset_scene() 调用过 read_homefile，那次调用中
bpy.context.window 为空，glTF 导出器 gather.py 会抛 AttributeError；
因此 build 与 export 必须分成两次 Blender 调用。
"""
import json
import os
import traceback

import bpy

OUT = r'D:\work\self\无人机模型器\drone_mini3pro.glb'

try:
    # 只选模型对象：灯光 / 相机 / 地台一律不进 GLB
    bpy.ops.object.select_all(action='DESELECT')
    model = [o for o in bpy.data.objects if o.type in ('MESH', 'EMPTY')]
    for o in model:
        o.select_set(True)
    root = bpy.data.objects.get('Drone_Root')
    if root:
        bpy.context.view_layer.objects.active = root

    props = set(bpy.ops.export_scene.gltf.get_rna_type().properties.keys())
    wanted = dict(
        filepath=OUT,
        export_format='GLB',
        use_selection=True,
        export_extras=True,           # 中文说明 / 旋翼转向必须显式开启
        export_yup=True,
        export_apply=False,
        export_cameras=False,
        export_lights=False,
        export_animations=False,
        export_materials='EXPORT',
        export_normals=True,
        export_tangents=False,
        export_skins=False,
        export_morph=False,
    )
    kw = {k: v for k, v in wanted.items() if k in props}
    dropped = sorted(set(wanted) - set(kw))
    bpy.ops.export_scene.gltf(**kw)
    res = {
        'ok': True,
        'path': OUT,
        'bytes': os.path.getsize(OUT),
        'selected': len(model),
        'params': sorted(kw),
        'unsupported_params': dropped,
    }
except Exception:
    res = {'ok': False, 'trace': traceback.format_exc()}

print('RESULT_JSON=' + json.dumps(res, ensure_ascii=False))
