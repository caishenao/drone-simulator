# -*- coding: utf-8 -*-
"""木门资产 —— 公共工具：清场、材质、四边形网格构建。"""
import bpy
import bmesh
from mathutils import Vector, Matrix

# ---------------------------------------------------------------- 场景

def reset_scene():
    bpy.ops.wm.read_homefile(use_empty=True, use_factory_startup=True)
    for m in list(bpy.data.materials):
        bpy.data.materials.remove(m)
    sc = bpy.context.scene
    sc.unit_settings.system = 'METRIC'
    sc.unit_settings.scale_length = 1.0
    return sc


def link(ob, coll=None):
    (coll or bpy.context.scene.collection).objects.link(ob)
    return ob


def ensure_collection(name):
    c = bpy.data.collections.get(name)
    if c is None:
        c = bpy.data.collections.new(name)
        bpy.context.scene.collection.children.link(c)
    return c


def ctx_override(objs=None):
    """构造尽量完整的 context override —— MCP 沙箱里的 bpy.context 很残缺，
    直接调 bpy.ops 会因为缺 active_object / window 等成员报 AttributeError。"""
    c = bpy.context
    kw = {}
    win = getattr(c, 'window', None)
    if win is None:
        wms = getattr(bpy.data, 'window_managers', None)
        if wms and len(wms) and len(wms[0].windows):
            win = wms[0].windows[0]
    if win is not None:
        kw['window'] = win
        scr = getattr(win, 'screen', None)
        if scr is not None:
            kw['screen'] = scr
            for a in scr.areas:
                if a.type == 'VIEW_3D':
                    kw['area'] = a
                    rg = [r for r in a.regions if r.type == 'WINDOW']
                    if rg:
                        kw['region'] = rg[0]
                    if len(a.spaces):
                        kw['space_data'] = a.spaces.active
                    break
    for n in ('scene', 'view_layer', 'workspace'):
        v = getattr(c, n, None)
        if v is not None:
            kw[n] = v
    if objs:
        kw['active_object'] = objs[0]
        kw['object'] = objs[0]
        kw['selected_objects'] = list(objs)
        kw['selected_editable_objects'] = list(objs)
    return kw


def deselect_all():
    for o in bpy.context.scene.objects:
        o.select_set(False)


# ---------------------------------------------------------------- 材质

def make_mat(name, base, rough=0.4, metal=0.0, spec=0.5, alpha=1.0):
    m = bpy.data.materials.get(name)
    if m:
        bpy.data.materials.remove(m)
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    bsdf = None
    for n in nt.nodes:
        if n.type == 'BSDF_PRINCIPLED':
            bsdf = n
    def st(k, v):
        if k in bsdf.inputs:
            bsdf.inputs[k].default_value = v
    st('Base Color', (base[0], base[1], base[2], 1.0))
    st('Roughness', rough)
    st('Metallic', metal)
    for k in ('Specular IOR Level', 'Specular'):
        if k in bsdf.inputs:
            bsdf.inputs[k].default_value = spec
            break
    if alpha < 1.0:
        st('Alpha', alpha)
        for k in ('blend_method',):
            if hasattr(m, k):
                setattr(m, k, 'BLEND')
        if hasattr(m, 'surface_render_method'):
            m.surface_render_method = 'BLENDED'
    m['base_srgb'] = base
    return m


# ---------------------------------------------------------------- 网格

class MeshBuilder:
    """按精确坐标建四边形，自动焊接重合顶点，保证闭合流形。"""

    def __init__(self, name):
        self.name = name
        self.bm = bmesh.new()
        self._cache = {}
        self.nquad = 0

    def v(self, p):
        key = (round(p[0], 6), round(p[1], 6), round(p[2], 6))
        got = self._cache.get(key)
        if got is None:
            got = self.bm.verts.new((key[0], key[1], key[2]))
            self._cache[key] = got
        return got

    def quad(self, a, b, c, d, mat=0):
        f = self.bm.faces.new([self.v(a), self.v(b), self.v(c), self.v(d)])
        f.material_index = mat
        self.nquad += 1
        return f

    # -- 常用面片：给出矩形范围与朝向，自动生成正确绕序
    # 注意：mat 必须逐层透传，否则 box() 的多材质参数会被静默丢弃（全落槽位 0）
    def rect_y(self, x0, x1, z0, z1, y, front=True, mat=0):
        """平面朝向 ±Y 的矩形（front=True → 法线 +Y）。"""
        if front:
            self.quad((x0, y, z0), (x0, y, z1), (x1, y, z1), (x1, y, z0), mat)
        else:
            self.quad((x0, y, z0), (x1, y, z0), (x1, y, z1), (x0, y, z1), mat)

    def rect_z(self, x0, x1, y0, y1, z, up=True, mat=0):
        """平面朝向 ±Z 的矩形（up=True → 法线 +Z）。"""
        if up:
            self.quad((x0, y0, z), (x1, y0, z), (x1, y1, z), (x0, y1, z), mat)
        else:
            self.quad((x0, y0, z), (x0, y1, z), (x1, y1, z), (x1, y0, z), mat)

    def rect_x(self, y0, y1, z0, z1, x, right=True, mat=0):
        """平面朝向 ±X 的矩形（right=True → 法线 +X）。"""
        if right:
            self.quad((x, y0, z0), (x, y1, z0), (x, y1, z1), (x, y0, z1), mat)
        else:
            self.quad((x, y0, z0), (x, y0, z1), (x, y1, z1), (x, y1, z0), mat)

    def box(self, x0, x1, y0, y1, z0, z1, mat=0):
        self.rect_y(x0, x1, z0, z1, y1, True, mat)
        self.rect_y(x0, x1, z0, z1, y0, False, mat)
        self.rect_z(x0, x1, y0, y1, z1, True, mat)
        self.rect_z(x0, x1, y0, y1, z0, False, mat)
        self.rect_x(y0, y1, z0, z1, x1, True, mat)
        self.rect_x(y0, y1, z0, z1, x0, False, mat)
        b = self.bm
        return b

    def cyl(self, center, axis, r, h, seg=20, mat=0, caps=True):
        """沿 axis('X'/'Y'/'Z') 的圆柱，center 为几何中心。"""
        import math
        c = Vector(center)
        half = Vector((0, 0, 0))
        idx = 'XYZ'.index(axis)
        half[idx] = h * 0.5
        a = c - half
        b = c + half
        ring_a, ring_b = [], []
        for i in range(seg):
            t = 2.0 * math.pi * i / seg
            u, w = math.cos(t) * r, math.sin(t) * r
            pa = a.copy()
            pb = b.copy()
            j = [k for k in range(3) if k != idx]
            pa[j[0]] += u
            pa[j[1]] += w
            pb[j[0]] += u
            pb[j[1]] += w
            ring_a.append(tuple(pa))
            ring_b.append(tuple(pb))
        for i in range(seg):
            j = (i + 1) % seg
            if axis == 'Y':
                self.quad(ring_a[i], ring_b[i], ring_b[j], ring_a[j], mat)
            elif axis == 'Z':
                self.quad(ring_a[i], ring_a[j], ring_b[j], ring_b[i], mat)
            else:
                self.quad(ring_a[i], ring_a[j], ring_b[j], ring_b[i], mat)
        if caps:
            fa = self.bm.faces.new([self.v(p) for p in ring_a])
            fb = self.bm.faces.new([self.v(p) for p in reversed(ring_b)])
            fa.material_index = mat
            fb.material_index = mat
        return self

    def finish(self, mat=None, smooth=False, recenter=None, xmap=None,
               parent=None, collection=None):
        bm = self.bm
        if xmap is not None:
            for v in bm.verts:
                v.co.x = xmap(v.co.x)
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
        if recenter is not None:
            off = Vector(recenter)
            for v in bm.verts:
                v.co -= off
        me = bpy.data.meshes.new(self.name)
        bm.to_mesh(me)
        bm.free()
        # 材质必须在本行之前追加：me.validate() 会把超出槽位范围的
        # material_index 全部截断为 0（静默失效）。mat 允许传列表。
        if mat is not None:
            for m in (mat if isinstance(mat, (list, tuple)) else [mat]):
                me.materials.append(m)
        me.validate(verbose=False)
        ob = bpy.data.objects.new(self.name, me)
        (collection or bpy.context.scene.collection).objects.link(ob)
        if smooth:
            for p in me.polygons:
                p.use_smooth = True
        if recenter is not None:
            ob.location = Vector(recenter)
        if parent is not None:
            ob.parent = parent
            ob.matrix_parent_inverse = Matrix.Identity(4)
        return ob


def volume_signed(ob):
    bm = bmesh.new()
    bm.from_mesh(ob.data)
    v = bm.calc_volume(signed=True)
    bm.free()
    return v
