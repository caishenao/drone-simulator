# -*- coding: utf-8 -*-
"""无人机产品图渲染：EEVEE + Khronos PBR Neutral，纯渐变天空，无地台（飞行姿态）。

尺度只有 0.3 m，灯位贴近、能量按距离平方压低，避免整块白壳过曝。
灯光 / 相机归独立集合，导出 GLB 时用 use_selection 只勾模型对象。
"""
import math
import os

import bpy
from mathutils import Vector

COLL_LIGHT = '预览_灯光'
COLL_CAM = '预览_相机'
WORLD_NAME = '世界_天空渐变'
CAM_NAME = '预览相机'

LIGHTS = {
    'key':   ('灯光_主光',   (0.34,  0.42,  0.55),  7.5, 0.45),
    'fill':  ('灯光_补光',   (-0.42, 0.30,  0.20),  3.0, 0.55),
    'top':   ('灯光_顶光',   (-0.10, 0.05,  0.60),  2.5, 0.40),
    'rim':   ('灯光_轮廓光', (-0.38, -0.42, 0.38),  6.0, 0.35),
    'under': ('灯光_底部补光', (0.18, 0.34, -0.40),  3.0, 0.50),
    'back':  ('灯光_背光',   (0.05, -0.55,  0.22),  4.5, 0.50),
}


def _coll(name):
    c = bpy.data.collections.get(name)
    if c is None:
        c = bpy.data.collections.new(name)
        bpy.context.scene.collection.children.link(c)
    return c


def purge_preview():
    for cname in (COLL_LIGHT, COLL_CAM):
        coll = bpy.data.collections.get(cname)
        if coll:
            for o in list(coll.objects):
                bpy.data.objects.remove(o, do_unlink=True)
    for o in list(bpy.data.objects):
        if o.type in ('LIGHT', 'CAMERA'):
            bpy.data.objects.remove(o, do_unlink=True)


def _aim(ob, target=(0, 0, 0)):
    d = Vector(target) - Vector(ob.location)
    ob.rotation_euler = d.to_track_quat('-Z', 'Y').to_euler()
    return ob


def setup(res=(1100, 900), samples=64):
    sc = bpy.context.scene
    purge_preview()
    sc.render.engine = 'BLENDER_EEVEE'
    sc.render.resolution_x, sc.render.resolution_y = res
    sc.render.resolution_percentage = 100
    sc.render.film_transparent = False
    sc.render.image_settings.file_format = 'PNG'
    sc.render.image_settings.color_mode = 'RGBA'
    ev = sc.eevee
    for k, v in (('taa_render_samples', samples), ('use_shadows', True),
                 ('use_raytracing', True), ('use_gtao', True)):
        if hasattr(ev, k):
            setattr(ev, k, v)
    vs = sc.view_settings
    for tn in ('Khronos PBR Neutral', 'Standard', 'AgX'):
        try:
            vs.view_transform = tn
            break
        except TypeError:
            continue
    try:
        vs.look = 'None'
    except TypeError:
        pass
    vs.exposure = -0.28

    # 世界：上深蓝 → 下浅蓝白，接近参考图的天空
    w = bpy.data.worlds.get(WORLD_NAME) or bpy.data.worlds.new(WORLD_NAME)
    sc.world = w
    w.use_nodes = True
    nt = w.node_tree
    nt.nodes.clear()
    out = nt.nodes.new('ShaderNodeOutputWorld')
    bg = nt.nodes.new('ShaderNodeBackground')
    ramp = nt.nodes.new('ShaderNodeValToRGB')
    mr = nt.nodes.new('ShaderNodeMapRange')
    sep = nt.nodes.new('ShaderNodeSeparateXYZ')
    tc = nt.nodes.new('ShaderNodeTexCoord')
    mr.inputs['From Min'].default_value = -1.0
    mr.inputs['From Max'].default_value = 1.0
    ramp.color_ramp.elements[0].position = 0.0
    ramp.color_ramp.elements[0].color = (0.80, 0.86, 0.90, 1)
    ramp.color_ramp.elements[1].position = 1.0
    ramp.color_ramp.elements[1].color = (0.085, 0.20, 0.37, 1)
    nt.links.new(tc.outputs['Normal'], sep.inputs['Vector'])
    nt.links.new(sep.outputs['Z'], mr.inputs['Value'])
    nt.links.new(mr.outputs['Result'], ramp.inputs['Fac'])
    nt.links.new(ramp.outputs['Color'], bg.inputs['Color'])
    bg.inputs['Strength'].default_value = 0.55
    nt.links.new(bg.outputs['Background'], out.inputs['Surface'])

    for key, (name, loc, energy, size) in LIGHTS.items():
        d = bpy.data.lights.new(name, 'AREA')
        d.energy, d.size = energy, size
        ob = bpy.data.objects.new(name, d)
        ob.location = loc
        _coll(COLL_LIGHT).objects.link(ob)
        _aim(ob)

    cam_data = bpy.data.cameras.new(CAM_NAME)
    cam_data.lens = 55
    cam_data.clip_start = 0.005
    cam_data.clip_end = 50
    cam = bpy.data.objects.new(CAM_NAME, cam_data)
    _coll(COLL_CAM).objects.link(cam)
    sc.camera = cam
    return sc


def shot(name, direction, out_dir, target=(0, 0, 0.002), dist=0.62):
    sc = bpy.context.scene
    cam = bpy.data.objects.get(CAM_NAME)
    v = Vector(direction).normalized() * dist
    cam.location = Vector(target) + v
    _aim(cam, target)
    sc.render.filepath = os.path.join(out_dir, 'check_' + name + '.png')
    bpy.ops.render.render(write_still=True)
    return sc.render.filepath


SHOTS = {
    'hero':   (0.62, 0.86, 0.46),
    'front':  (0.02, 1.00, 0.22),
    'top':    (0.03, 0.10, 1.00),
    'side':   (1.00, 0.06, 0.24),
    'rear':   (-0.60, -0.82, 0.44),
    'gimbal': (0.30, 0.88, -0.42),
    'vent':   (0.24, 0.32, 1.00),
}
