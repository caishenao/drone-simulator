# -*- coding: utf-8 -*-
"""在当前 Blender 窗口构建「四旋翼无人机」（DJI Mini 3 Pro 级外形）。

设计目标：一次建模，直接给 Vue3(three.js) / Godot 4 做模拟飞行。
  * 真实米制，原点 = 整机重心；Blender +Y = 机头 → 导出 glTF 后 -Z = 机头
  * 每个旋翼 / 机臂 / 云台都是独立节点，枢轴就在自己的旋转轴上
  * 全 ASCII 节点名（Godot 节点路径安全），中文说明写进 glTF extras
  * 无动画烘焙：转速、俯仰、折叠全部交给引擎运行时驱动
"""
import json
import math
import os
import sys
import traceback

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import importlib

import bpy
from mathutils import Vector

# MCP 注入的是长期运行的 Blender 进程，模块会缓存；改过工具库必须按顺序重载
import door_lib, drone_geom, drone_render
for _m in (door_lib, drone_geom, drone_render):
    importlib.reload(_m)

from door_lib import reset_scene, ensure_collection
from drone_geom import (Geo, JOINT, blade, disc_ring, empty, loft,
                        make_materials, ring_xz, rod, sphere)
DR = drone_render

OUT = r'D:\work\self\无人机模型器'
os.makedirs(OUT, exist_ok=True)

# ---------------------------------------------------------------- 尺寸（米）
AXLE = 0.247                       # 对角电机轴距
MX = AXLE / (2.0 * math.sqrt(2))   # 0.0873
MY = MX
MZ = 0.0195                       # 电机座圆柱中心
PROP_Z = 0.0355                   # 桨盘平面
PROP_R = 0.073                    # 桨叶半径
SHOULDER = (0.034, 0.050, 0.004)  # 四臂折叠铰链（取绝对值）
GIMBAL_PIVOT = (0.0, 0.048, -0.024)

# sx = -1 左 / +1 右 ; sy = +1 前 / -1 后
QUADS = [
    ('FL', -1, +1, +1),   # 名称, X符号, Y符号, 旋翼转向
    ('FR', +1, +1, -1),
    ('RL', -1, -1, -1),
    ('RR', +1, -1, +1),
]

# 机身放样截面: (y, 半宽, 中面z, 上高, 下高)
BODY_SECTIONS = [
    (-0.088, 0.014, 0.002, 0.012, 0.010),
    (-0.078, 0.026, 0.003, 0.020, 0.015),
    (-0.060, 0.037, 0.003, 0.026, 0.019),
    (-0.035, 0.042, 0.003, 0.030, 0.022),
    (-0.005, 0.043, 0.003, 0.031, 0.023),
    (+0.028, 0.041, 0.003, 0.029, 0.022),
    (+0.055, 0.036, 0.002, 0.025, 0.020),
    (+0.075, 0.028, 0.001, 0.019, 0.017),
    (+0.086, 0.016, 0.000, 0.012, 0.012),
]

BLADE_SECTIONS = [
    # (展向r, 弦长, 后掠, 扭转角, 厚度)
    (0.008, 0.012, 0.000, 18.0, 0.0024),
    (0.017, 0.017, 0.001, 15.0, 0.0020),
    (0.033, 0.018, 0.003, 11.0, 0.0016),
    (0.051, 0.014, 0.006,  7.0, 0.0012),
    (0.066, 0.009, 0.009,  4.0, 0.0009),
    (0.073, 0.003, 0.011,  2.0, 0.0006),
]


def half_width_at(y):
    """机身侧面半宽的线性插值，用于贴合饰条 / 分缝。"""
    sec = BODY_SECTIONS
    for i in range(len(sec) - 1):
        if sec[i][0] <= y <= sec[i + 1][0]:
            t = (y - sec[i][0]) / (sec[i + 1][0] - sec[i][0])
            return sec[i][1] * (1 - t) + sec[i + 1][1] * t
    return sec[0][1] if y < sec[0][0] else sec[-1][1]


def arm_loft(g, path, widths, thicks, mat, n=12):
    """机臂：沿折线放样的圆角矩形扁杆。"""
    rings = []
    for i, p in enumerate(path):
        if i == 0:
            d = Vector(path[1]) - Vector(path[0])
        elif i == len(path) - 1:
            d = Vector(path[-1]) - Vector(path[-2])
        else:
            d = Vector(path[i + 1]) - Vector(path[i - 1])
        d.z = 0.0
        d.normalize()
        side = Vector((-d.y, d.x, 0.0))
        up = Vector((0.0, 0.0, 1.0))
        ring = []
        for k in range(n):
            t = 2.0 * math.pi * k / n
            cs, sn = math.cos(t), math.sin(t)
            u = math.copysign(abs(cs) ** 0.75, cs) * widths[i] * 0.5
            v = math.copysign(abs(sn) ** 0.75, sn) * thicks[i] * 0.5
            ring.append(tuple(Vector(p) + side * u + up * v))
        rings.append(ring)
    loft(g, rings, mat, caps=True)
    return g


def put(g, name, mats, pivot, parent, parent_pivot=(0, 0, 0),
        cn='', extra=None, smooth=False, coll=None):
    ex = {'中文名': cn} if cn else {}
    if extra:
        ex.update(extra)
    return g.finish(name, mats, pivot=pivot, parent=parent,
                    parent_pivot=parent_pivot, smooth=smooth,
                    extras=ex or None, collection=coll)


def build():
    reset_scene()
    mats = make_materials()
    coll = ensure_collection('无人机_模型')
    ren = ensure_collection('预览_灯光')
    camcoll = ensure_collection('预览_相机')

    root = empty('Drone_Root', (0, 0, 0), collection=coll, extras={
        '中文名': '四旋翼无人机',
        '机型': 'DJI Mini 3 Pro 级（按参考图重塑，非官方精确数模）',
        '单位': '米；1 Blender 单位 = 1 m',
        '坐标约定': 'Blender +Y=机头/+Z=上；导出 glTF 后 -Z=机头/+Y=上',
        '对角轴距_m': AXLE,
        '旋翼驱动': 'Rotor_FL/FR/RL/RR 各自绕局部 Z（glTF/Godot 内为 Y）旋转；FL/RR 正向、FR/RL 反向',
        '云台驱动': 'Gimbal_Pivot 绕局部 X 俯仰',
        '机臂折叠': 'Arm_FL/FR/RL/RR 绕各自局部 Z 旋转即可折叠',
        '动画': 'GLB 不含烘焙动画，转速/姿态完全由运行时驱动',
    })

    # ------------------------------------------------------------ 机身
    g = Geo('Body_Shell')
    rings = [ring_xz(y, hw, zm, th, bh, n=28)
             for (y, hw, zm, th, bh) in BODY_SECTIONS]
    # 上壳浅灰 / 下壳深灰：参考图里机身侧面那条折线是真机的分色，
    # 只靠灯光打不出这个层次，必须按环点位置分材质。
    n = len(rings[0])
    for i in range(len(rings) - 1):
        a, b = rings[i], rings[i + 1]
        for k in range(n):
            j = (k + 1) % n
            g.quad(a[k], a[j], b[j], b[k],
                   'ShellShade' if n // 2 < k < n else 'Shell')
    g.poly(list(reversed(rings[0])), 'Shell')
    g.poly(list(rings[-1]), 'Shell')
    put(g, 'Body_Shell', mats, (0, 0, 0), root,
        cn='机身外壳', smooth=True, coll=coll,
        extra={'部件': '机身', '材质': '浅灰哑光聚合物'})

    # 细节：顶部脊线 / 侧面棱线 / 分缝 / 电池盖 / 进气口 / 尾部
    g = Geo('Body_Details')
    # 顶部纵向脊线（浅色高光，模拟机背折面）
    for s in (-1, 1):
        pts = []
        for y, hw, zm, th, bh in BODY_SECTIONS[1:-1]:
            pts.append((s * hw * 0.42, y, zm + th + 0.0004))
        for i in range(len(pts) - 1):
            rod(g, pts[i], pts[i + 1], 0.0006, 0.0009, 'ShellLight')
    # 侧面分缝线
    for s in (-1, 1):
        for y0, y1 in ((-0.062, -0.020), (-0.020, 0.030), (0.030, 0.068)):
            x0 = s * (half_width_at(y0) + 0.0003)
            x1 = s * (half_width_at(y1) + 0.0003)
            rod(g, (x0, y0, -0.009), (x1, y1, -0.009),
                0.00055, 0.0005, 'ShellDark')
    # 机腹纵向分缝：悬空平板会像一块脱壳的电池盖，改成紧贴弧底的细线
    rod(g, (0, -0.055, -0.0203), (0, 0.050, -0.0203),
        0.0004, 0.0016, 'ShellDark')
    # 尾部深色功能块
    g.box(-0.020, 0.020, -0.085, -0.076, -0.010, 0.014, 'ShellDark')
    g.box(-0.014, 0.014, -0.086, -0.084, -0.006, 0.008, 'LensBlack')
    put(g, 'Body_Details', mats, (0, 0, 0), root,
        cn='机身细节', coll=coll,
        extra={'部件': '机身', '说明': '棱线/分缝/尾部接口'})

    # 进气口独立成节点：混在机身细节 mesh 里时深色底面会被弧面机背吃掉。
    # 做成有厚度、明确高于机背的黑框 + 红棕内腔 + 两道格栅。
    g = Geo('Body_Vent')
    g.box(-0.0185, 0.0185, -0.0595, -0.0265, 0.0345, 0.0370, 'Vent')
    g.box(-0.0140, 0.0140, -0.0560, -0.0300, 0.0371, 0.0374, 'VentInner')
    for y in (-0.049, -0.038):
        rod(g, (-0.016, y, 0.0377), (0.016, y, 0.0377),
            0.0007, 0.0011, 'ShellDark')
    put(g, 'Body_Vent', mats, (0, 0, 0), root,
        cn='机背进气口', coll=coll, extra={'部件': '散热进气口'})

    # 侧面红色饰条（DJI Mini 系列的视觉签名）
    g = Geo('Body_Accent')
    for s in (-1, 1):
        for y0, y1 in ((-0.052, -0.018), (-0.018, 0.024), (0.024, 0.060)):
            x0 = s * (half_width_at(y0) + 0.0006)
            x1 = s * (half_width_at(y1) + 0.0006)
            rod(g, (x0, y0, 0.0072), (x1, y1, 0.0072),
                0.0011, 0.0006, 'Accent')
    put(g, 'Body_Accent', mats, (0, 0, 0), root,
        cn='机身红色饰条', coll=coll)

    # ------------------------------------------------------------ 传感器
    def lens_stack(g, x, y, z, axis, radii, mats_seq, h_total=0.005):
        """沿 axis 叠同心圆柱，做出镜头/传感器窗口的层次。"""
        step = h_total / len(radii)
        for i, (r, mn) in enumerate(zip(radii, mats_seq)):
            c = [x, y, z]
            c['XYZ'.index(axis)] += i * step * 0.85
            g.cyl(tuple(c), axis, r, step * 1.35, 18, mn)

    g = Geo('Sensors_Front')
    for s in (-1, 1):
        lens_stack(g, s * 0.0295, 0.0695, 0.0085, 'Y',
                   (0.0080, 0.0064, 0.0046, 0.0018),
                   ('Metal', 'LensBlack', 'Glass', 'LensBlack'))
        lens_stack(g, s * 0.0125, 0.0865, 0.0010, 'Y',
                   (0.0042, 0.0032, 0.0020),
                   ('Metal', 'LensBlack', 'LensBlack'), h_total=0.003)
    put(g, 'Sensors_Front', mats, (0, 0, 0), root,
        cn='前视双目传感器', coll=coll,
        extra={'部件': '避障传感器', '朝向': '机头 +Y'})

    g = Geo('Sensors_Rear')
    for s in (-1, 1):
        lens_stack(g, s * 0.0240, -0.0795, 0.0060, 'Y',
                   (0.0060, 0.0048, 0.0032),
                   ('Metal', 'LensBlack', 'Glass'), h_total=0.004)
    put(g, 'Sensors_Rear', mats, (0, 0, 0), root,
        cn='后视传感器', coll=coll)

    g = Geo('Sensors_Down')
    for s in (-1, 1):
        lens_stack(g, s * 0.0130, 0.0260, -0.0215, 'Z',
                   (0.0055, 0.0043, 0.0030),
                   ('Metal', 'LensBlack', 'Glass'), h_total=0.003)
    put(g, 'Sensors_Down', mats, (0, 0, 0), root,
        cn='下视传感器', coll=coll)

    g = Geo('LED')
    g.cyl((0.0, 0.0700, -0.0175), 'Z', 0.0026, 0.0012, 12, 'LED')
    g.cyl((0.0, -0.0700, -0.0145), 'Z', 0.0026, 0.0012, 12, 'LEDRed')
    put(g, 'LED', mats, (0, 0, 0), root, cn='航行灯', coll=coll)

    # ------------------------------------------------------------ 四臂
    for tag, sx, sy, spin in QUADS:
        sp = (sx * SHOULDER[0], sy * SHOULDER[1], SHOULDER[2])
        mx, my = sx * MX, sy * MY

        # 机臂本体 + 肩部折叠铰链罩
        g = Geo('Arm_' + tag)
        path = [(sx * 0.030, sy * 0.046, 0.0070),
                (sx * 0.057, sy * 0.066, 0.0110),
                (sx * 0.083, sy * 0.086, 0.0150)]
        arm_loft(g, path, (0.0195, 0.0175, 0.0150),
                 (0.0105, 0.0095, 0.0085), 'Shell')
        g.cyl((sp[0], sp[1], 0.006), 'Z', 0.0115, 0.015, 20, 'ShellLight')
        arm_ob = put(g, 'Arm_' + tag, mats, sp, root, cn=tag + ' 机臂',
            smooth=True, coll=coll,
            extra={'部件': '机臂', '折叠轴': '局部 Z（glTF 内为 Y）',
                   '位置': ('前' if sy > 0 else '后') + ('左' if sx < 0 else '右')})

        # 电机座
        g = Geo('Motor_' + tag)
        g.cyl((mx, my, MZ), 'Z', 0.0145, 0.0190, 24, 'Motor')
        g.cyl((mx, my, 0.0298), 'Z', 0.0132, 0.0020, 24, 'LensBlack')
        disc_ring(g, (mx, my), 0.0148, 0.0124, 0.0278, 0.0296, 24, 'Metal')
        g.cyl((mx, my, 0.0325), 'Z', 0.0032, 0.0070, 16, 'Metal')
        put(g, 'Motor_' + tag, mats, (mx, my, MZ), arm_ob,
            parent_pivot=sp, cn=tag + ' 无刷电机', smooth=True, coll=coll,
            extra={'部件': '电机'})

        # 旋翼：独立节点，枢轴 = 桨毂中心；引擎里绕自身竖轴转即可
        g = Geo('Rotor_' + tag)
        g.cyl((mx, my, PROP_Z), 'Z', 0.0076, 0.0050, 20, 'Prop')
        g.cyl((mx, my, PROP_Z + 0.0028), 'Z', 0.0034, 0.0016, 16, 'Metal')
        blade(g, BLADE_SECTIONS, 'Prop', flip=False, origin=(mx, my, PROP_Z))
        blade(g, BLADE_SECTIONS, 'Prop', flip=True, origin=(mx, my, PROP_Z))
        put(g, 'Rotor_' + tag, mats, (mx, my, PROP_Z), arm_ob,
            parent_pivot=sp, cn=tag + ' 旋翼', smooth=True, coll=coll,
            extra={'部件': '旋翼', '旋转轴_Blender': 'Z',
                   '旋转轴_glTF_Godot': 'Y', '转向': spin,
                   '半径_m': PROP_R, '桨叶数': 2,
                   '驱动': '绕自身局部竖轴按 spin * RPM 旋转'})

        # 起落架：前臂是带三角镂空的弯折脚架，后臂是短支脚
        g = Geo('Leg_' + tag)
        if sy > 0:
            p0 = (sx * 0.096, sy * 0.090, 0.0120)
            p1 = (sx * 0.108, sy * 0.100, -0.0430)
            p2 = (sx * 0.090, sy * 0.092, -0.0430)
            p3 = (sx * 0.086, sy * 0.087, 0.0060)
            for a, c in ((p0, p1), (p1, p2), (p2, p3)):
                rod(g, a, c, 0.0040, 0.0038, 'Shell')
            g.box(p1[0] - 0.005, p1[0] + 0.005,
                  p1[1] - 0.004, p1[1] + 0.004,
                  p1[2] - 0.002, p1[2] + 0.002, 'Accent')
        else:
            a = (sx * 0.087, sy * 0.087, 0.0100)
            c = (sx * 0.094, sy * 0.094, -0.0230)
            rod(g, a, c, 0.0040, 0.0040, 'Shell')
            g.box(c[0] - 0.0045, c[0] + 0.0045,
                  c[1] - 0.0045, c[1] + 0.0045,
                  c[2] - 0.002, c[2] + 0.002, 'Accent')
        put(g, 'Leg_' + tag, mats, sp, arm_ob, parent_pivot=sp,
            cn=tag + ' 起落架', coll=coll, extra={'部件': '起落架'})

    # ------------------------------------------------------------ 云台相机
    gp = empty('Gimbal_Pivot', GIMBAL_PIVOT, parent=root,
               collection=coll, extras={
                   '中文名': '云台俯仰轴', '部件': '云台',
                   '驱动': '绕局部 X 轴俯仰（-90° 朝下 ~ +30° 朝上）',
               })
    g = Geo('Gimbal_Camera')
    sphere(g, (0.0, 0.058, -0.030), 0.0205, 18, 10, 'LensBlack',
           squash=(1.0, 0.88, 0.92))
    # 云台两侧支架
    for s in (-1, 1):
        g.cyl((s * 0.0205, 0.050, -0.027), 'X', 0.0050, 0.005, 14, 'Shell')
    # 前方面板（方中带圆）
    g.box(-0.0155, 0.0155, 0.0745, 0.0765, -0.0435, -0.0175, 'ShellDark')
    # 镜头筒
    g.cyl((0.0, 0.0795, -0.0305), 'Y', 0.0118, 0.0070, 24, 'LensBlack')
    put(g, 'Gimbal_Camera', mats, GIMBAL_PIVOT, gp,
        parent_pivot=GIMBAL_PIVOT, cn='云台相机主体',
        smooth=True, coll=coll, extra={'部件': '云台'})

    g = Geo('Gimbal_Lens')
    g.cyl((0.0, 0.0830, -0.0305), 'Y', 0.0108, 0.0020, 24, 'Metal')
    g.cyl((0.0, 0.0842, -0.0305), 'Y', 0.0090, 0.0020, 24, 'LensBlack')
    g.cyl((0.0, 0.0854, -0.0305), 'Y', 0.0074, 0.0016, 24, 'Glass')
    g.cyl((0.0, 0.0863, -0.0305), 'Y', 0.0030, 0.0012, 20, 'LensBlack')
    put(g, 'Gimbal_Lens', mats, GIMBAL_PIVOT, gp,
        parent_pivot=GIMBAL_PIVOT, cn='相机镜头玻璃', smooth=True, coll=coll,
        extra={'部件': '镜头', '镀膜': '绿色增透膜'})

    # ------------------------------------------------------------ 统计
    bpy.context.view_layer.update()
    model = [o for o in bpy.data.objects
             if o.type == 'MESH' and o.name != '预览地台']
    tris = sum(sum(len(p.vertices) - 2 for p in o.data.polygons) for o in model)
    lo = Vector((1e9, 1e9, 1e9))
    hi = Vector((-1e9, -1e9, -1e9))
    for o in model:
        for v in o.data.vertices:
            w = o.matrix_world @ v.co
            for i in range(3):
                lo[i], hi[i] = min(lo[i], w[i]), max(hi[i], w[i])

    # ------------------------------------------------------------ 渲染
    DR.setup(res=(1100, 900), samples=64)
    shots = {}
    for name, direction in DR.SHOTS.items():
        shots[name] = DR.shot(name, direction, OUT,
                              dist=0.40 if name == 'vent' else 0.62)

    # ------------------------------------------------------------ 保存 .blend
    blend_path = os.path.join(OUT, 'DroneMini3Pro.blend')
    bpy.ops.wm.save_as_mainfile(filepath=blend_path)

    return {
        'ok': True,
        'blend': blend_path,
        'objects': len(model),
        'triangles': tris,
        'materials': len(mats),
        'bbox_min': [round(v, 5) for v in lo],
        'bbox_max': [round(v, 5) for v in hi],
        'shots': shots,
        'names': sorted(o.name for o in bpy.data.objects if o.type in ('MESH', 'EMPTY')),
    }


try:
    result = build()
except Exception:
    result = {'ok': False, 'trace': traceback.format_exc()}
print('RESULT_JSON=' + json.dumps(result, ensure_ascii=False))
