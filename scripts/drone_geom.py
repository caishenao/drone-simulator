# -*- coding: utf-8 -*-
"""四旋翼无人机资产 —— 几何 / 材质 / 层级工具（Blender 5.x，米制，Z-up）。

坐标约定（导出 glTF 后自动变成 Y-up，机头朝 -Z，正好是 Godot / three.js 的前方）：
    Blender:  +Y = 机头,  +X = 机身右侧,  +Z = 上
    glTF:     -Z = 机头,  +X = 机身右侧,  +Y = 上
所有几何先按「整机全局坐标」构造，再按各自的枢轴 recenter；
子对象的 location = 自身枢轴 - 父对象枢轴，避免父子变换叠加两次。
"""
import math

import bpy
import bmesh
from mathutils import Vector

from door_lib import MeshBuilder, reset_scene

JOINT = 0.0006          # 贴片压进母体的深度，避免共面 z-fighting

# ---------------------------------------------------------------- 材质表
# 基色是线性值；浅灰机壳 0.62 渲染出来才是照片里那种冷白灰。
PALETTE = {
    'Shell':      dict(base=(0.385, 0.402, 0.420), rough=0.54, metal=0.00, spec=0.28),
    'ShellLight': dict(base=(0.470, 0.485, 0.500), rough=0.54, metal=0.00, spec=0.28),
    'ShellShade': dict(base=(0.235, 0.248, 0.262), rough=0.56, metal=0.00, spec=0.26),
    'ShellDark':  dict(base=(0.065, 0.070, 0.080), rough=0.48, metal=0.04),
    'Motor':      dict(base=(0.105, 0.112, 0.122), rough=0.42, metal=0.30),
    'Metal':      dict(base=(0.330, 0.350, 0.370), rough=0.34, metal=0.50),
    'Prop':       dict(base=(0.018, 0.020, 0.024), rough=0.74, metal=0.00, spec=0.16),
    'Glass':      dict(base=(0.012, 0.075, 0.050), rough=0.07, metal=0.55),
    'LensBlack':  dict(base=(0.010, 0.012, 0.014), rough=0.22, metal=0.10),
    'Accent':     dict(base=(0.380, 0.055, 0.042), rough=0.48, metal=0.04),
    'Vent':       dict(base=(0.012, 0.014, 0.016), rough=0.68, metal=0.00, spec=0.18),
    'VentInner':  dict(base=(0.055, 0.018, 0.012), rough=0.88, metal=0.00, spec=0.10),
    'LED':        dict(base=(0.030, 0.500, 0.180), rough=0.30, metal=0.00, emit=2.4),
    'LEDRed':     dict(base=(0.520, 0.030, 0.026), rough=0.30, metal=0.00, emit=2.0),
}


def make_materials():
    """全量重建材质，避免重复执行时残留 .001 后缀被烘进 GLB。"""
    for m in list(bpy.data.materials):
        bpy.data.materials.remove(m)
    out = {}
    for name, cfg in PALETTE.items():
        m = bpy.data.materials.new(name)
        m.use_nodes = True
        bsdf = next((n for n in m.node_tree.nodes
                     if n.type == 'BSDF_PRINCIPLED'), None)
        if bsdf is None:
            continue
        st = bsdf.inputs
        st['Base Color'].default_value = (*cfg['base'], 1.0)
        st['Roughness'].default_value = cfg['rough']
        st['Metallic'].default_value = cfg['metal']
        if 'Specular IOR Level' in st:
            st['Specular IOR Level'].default_value = cfg.get('spec', 0.32)
        if cfg.get('emit'):
            for k in ('Emission Color', 'Emission'):
                if k in st:
                    st[k].default_value = (*cfg['base'], 1.0)
                    break
            if 'Emission Strength' in st:
                st['Emission Strength'].default_value = cfg['emit']
        out[name] = m
    return out


# ---------------------------------------------------------------- 网格构建
class Geo:
    """按材质名分配槽位；finish 时统一 recenter / 挂父级 / 写 extras。"""

    def __init__(self, name):
        self.mb = MeshBuilder(name)
        self.slots = []

    def mi(self, mat):
        if mat not in self.slots:
            self.slots.append(mat)
        return self.slots.index(mat)

    def quad(self, a, b, c, d, mat):
        self.mb.quad(a, b, c, d, self.mi(mat))

    def poly(self, pts, mat):
        f = self.mb.bm.faces.new([self.mb.v(p) for p in pts])
        f.material_index = self.mi(mat)

    def box(self, x0, x1, y0, y1, z0, z1, mat):
        self.mb.box(x0, x1, y0, y1, z0, z1, self.mi(mat))

    def cyl(self, center, axis, r, h, seg, mat, caps=True):
        self.mb.cyl(center, axis, r, h, seg, self.mi(mat), caps)

    def finish(self, name, mats, pivot=(0, 0, 0), parent=None,
               parent_pivot=(0, 0, 0), smooth=False, extras=None,
               collection=None):
        ob = self.mb.finish(
            mat=[mats[n] for n in self.slots],
            smooth=smooth, recenter=tuple(pivot), collection=collection)
        # parent 的变换是纯平移（无旋转），相对坐标直接相减即可
        ob.location = Vector(pivot) - Vector(parent_pivot)
        if parent is not None:
            ob.parent = parent
        if extras:
            for k, v in extras.items():
                ob[k] = v
        return ob


def ring_xz(y, half_w, z_mid, top_h, bot_h, n=28, p=2.6):
    """法线沿 Y 的超椭圆环：上顶平、下腹圆，用于机身放样。"""
    pts = []
    for k in range(n):
        t = 2.0 * math.pi * k / n
        ct, st = math.cos(t), math.sin(t)
        cx = math.copysign(abs(ct) ** (2.0 / p), ct) * half_w
        cz = math.copysign(abs(st) ** (2.0 / p), st)
        z = z_mid + cz * (top_h if cz >= 0 else bot_h)
        pts.append((cx, y, z))
    return pts


def loft(g, rings, mat, caps=True, smooth=True):
    """顺序连接若干同点数顶点环；caps 用 n 边形封口。"""
    n = len(rings[0])
    for i in range(len(rings) - 1):
        a, b = rings[i], rings[i + 1]
        for k in range(n):
            j = (k + 1) % n
            g.quad(a[k], a[j], b[j], b[k], mat)
    if caps:
        g.poly(list(reversed(rings[0])), mat)
        g.poly(list(rings[-1]), mat)
    return g


def rod(g, a, c, half_w, half_t, mat, up_hint=(0, 0, 1), round_n=0):
    """沿任意方向的扁杆（矩形或圆角矩形截面），用于机臂 / 支腿 / 饰条。"""
    a, c = Vector(a), Vector(c)
    d = (c - a).normalized()
    n = Vector(up_hint) - d * d.dot(Vector(up_hint))
    if n.length < 0.05:
        n = Vector((0, 1, 0)) - d * d.y
    n.normalize()
    w = d.cross(n).normalized()

    def section(center):
        if round_n <= 0:
            pts = [(-half_w, -half_t), (half_w, -half_t),
                   (half_w, half_t), (-half_w, half_t)]
        else:
            pts = []
            for k in range(round_n):
                t = 2.0 * math.pi * k / round_n
                ct, st = math.cos(t), math.sin(t)
                pts.append((math.copysign(abs(ct) ** 0.78, ct) * half_w,
                            math.copysign(abs(st) ** 0.78, st) * half_t))
        return [tuple(center + n * u + w * v) for u, v in pts]

    loft(g, [section(a), section(c)], mat, caps=True)
    return g


def disc_ring(g, center, r_out, r_in, z0, z1, seg, mat):
    """圆环柱（外侧面 + 内侧面 + 上下环面），用于镜头圈 / 传感器圈。"""
    c = Vector(center)
    ro, ri = [], []
    for k in range(seg):
        t = 2.0 * math.pi * k / seg
        ro.append((c.x + r_out * math.cos(t), c.y + r_out * math.sin(t)))
        ri.append((c.x + r_in * math.cos(t), c.y + r_in * math.sin(t)))
    for k in range(seg):
        j = (k + 1) % seg
        o0, o1 = ro[k], ro[j]
        i0, i1 = ri[k], ri[j]
        g.quad((o0[0], o0[1], z0), (o1[0], o1[1], z0),
               (o1[0], o1[1], z1), (o0[0], o0[1], z1), mat)          # 外侧
        g.quad((i1[0], i1[1], z0), (i0[0], i0[1], z0),
               (i0[0], i0[1], z1), (i1[0], i1[1], z1), mat)          # 内侧
        g.quad((i0[0], i0[1], z1), (i1[0], i1[1], z1),
               (o1[0], o1[1], z1), (o0[0], o0[1], z1), mat)          # 顶环
        g.quad((o0[0], o0[1], z0), (o1[0], o1[1], z0),
               (i1[0], i1[1], z0), (i0[0], i0[1], z0), mat)          # 底环
    return g


def sphere(g, center, r, n_lon, n_lat, mat, squash=(1, 1, 1)):
    """低模 UV 球；squash 按轴缩放，用于云台球体。"""
    c = Vector(center)
    rings = []
    for j in range(1, n_lat):
        ph = math.pi * j / n_lat
        rr = r * math.sin(ph)
        zz = r * math.cos(ph) * squash[2]
        rings.append([tuple(c + Vector((rr * math.cos(2 * math.pi * k / n_lon) * squash[0],
                                        rr * math.sin(2 * math.pi * k / n_lon) * squash[1],
                                        zz))) for k in range(n_lon)])
    top = tuple(c + Vector((0, 0, r * squash[2])))
    bot = tuple(c - Vector((0, 0, r * squash[2])))
    for k in range(n_lon):
        j = (k + 1) % n_lon
        g.poly([top, rings[0][k], rings[0][j]], mat)
        g.poly([bot, rings[-1][j], rings[-1][k]], mat)
    for i in range(len(rings) - 1):
        for k in range(n_lon):
            j = (k + 1) % n_lon
            g.quad(rings[i][k], rings[i][j], rings[i + 1][j], rings[i + 1][k], mat)
    return g


def blade(g, sections, mat, flip=False, origin=(0, 0, 0)):
    """单片桨叶：沿 +X 展开，弦向 Y，带后掠、根宽尖窄、气动扭转、厚度。
    flip=True 时绕 Z 旋转 180° 得到对侧桨叶；origin 为整机全局坐标下的桨毂中心。
    """
    rings = []
    for r, chord, sweep, twist_deg, thick in sections:
        th = math.radians(twist_deg)
        s, c = math.sin(th), math.cos(th)
        yc = sweep
        # 四点截面：前缘上 / 后缘上 / 后缘下 / 前缘下
        spec = [(-0.38 * chord, +thick * 0.5),
                (+0.62 * chord, +thick * 0.5),
                (+0.62 * chord, -thick * 0.5),
                (-0.38 * chord, -thick * 0.5)]
        pts = []
        for yy, zz in spec:
            y = yc + yy * c - zz * s
            z = yy * s + zz * c
            x = r
            if flip:
                x, y = -x, -y
            pts.append((x + origin[0], y + origin[1], z + origin[2]))
        rings.append(pts)
    # (x, y) -> (-x, -y) 是绕 Z 的 180° 旋转，行列式为正，面绕序保持不变
    for i in range(len(rings) - 1):
        a, b = rings[i], rings[i + 1]
        for k in range(4):
            j = (k + 1) % 4
            g.quad(a[k], a[j], b[j], b[k], mat)
    g.poly(list(reversed(rings[0])), mat)
    g.poly(list(rings[-1]), mat)
    return g


def empty(name, pivot, parent=None, parent_pivot=(0, 0, 0), extras=None,
          collection=None):
    ob = bpy.data.objects.new(name, None)
    ob.empty_display_type = 'PLAIN_AXES'
    ob.empty_display_size = 0.012
    (collection or bpy.context.scene.collection).objects.link(ob)
    ob.location = Vector(pivot) - Vector(parent_pivot)
    if parent is not None:
        ob.parent = parent
    if extras:
        for k, v in extras.items():
            ob[k] = v
    return ob
