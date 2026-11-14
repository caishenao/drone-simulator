# -*- coding: utf-8 -*-
"""生成 x500_mini3pro / x500_mini3pro_base 两个 SDF 模型变体。

做法：完整保留 PX4 x500_base 的 collision / inertial / joint / link pose 与
x500 层的 4x MulticopterMotorModel 插件，只替换 <visual> 的网格为自建
Mini 3 Pro 外形导出 OBJ。物理仍是 x500（2.0 kg、0.348 m 对角电机距），
因此对视觉做 1.99313 倍缩放让机臂末端精确落在 rotor_N link 上。

产物写入 exports/，并复制进 normalized/models/ 供 GZ_SIM_RESOURCE_PATH 解析。
"""
import json
import shutil
import time
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(r'D:\work\self\无人机模型器\sim_px4')
NORM = ROOT / 'normalized' / 'models'
EXPORT = ROOT / 'exports'
BASE = NORM / 'x500_base'
X500 = NORM / 'x500'
SCALE = 1.99313          # 0.174 / 0.0873：使自建电机位与 x500 rotor link 重合
YAW = -1.5707963         # 把自建模型的 +Y 机头转到 Gazebo/PX4 的 +X 前方

NEW_BASE = 'x500_mini3pro_base'
NEW_TOP = 'x500_mini3pro'


def mesh_uri(parent, fname):
    m = parent.find('./geometry/mesh')
    if m is None:
        return False
    u = m.find('uri')
    if u is None:
        return False
    u.text = f'model://{NEW_BASE}/meshes/{fname}'
    s = m.find('scale')
    if s is None:
        s = ET.SubElement(m, 'scale')
    s.text = f'{SCALE} {SCALE} {SCALE}'
    return True


def set_pose(v, text):
    p = v.find('pose')
    if p is None:
        p = ET.Element('pose')
        v.insert(0, p)
    p.text = text


def write_xml(root, path):
    ET.indent(root, space='  ')
    ET.ElementTree(root).write(path, encoding='utf-8', xml_declaration=True)


def make_config(name, desc, path):
    r = ET.Element('model')
    ET.SubElement(r, 'name').text = name
    ET.SubElement(r, 'version').text = '1.0'
    s = ET.SubElement(r, 'sdf', {'version': '1.9'})
    s.text = 'model.sdf'
    a = ET.SubElement(r, 'author')
    ET.SubElement(a, 'name').text = 'Local derivative build'
    ET.SubElement(a, 'email').text = 'n/a'
    ET.SubElement(r, 'description').text = desc
    write_xml(r, path)


def main():
    # ---------------- base 变体 ----------------
    tree = ET.parse(BASE / 'model.sdf')
    root = tree.getroot()
    model = root.find('model')
    model.set('name', NEW_BASE)
    changes = []

    drop = {'5010_motor_base_0', '5010_motor_base_1', '5010_motor_base_2',
            '5010_motor_base_3', 'NXP_FMUK66_FRONT', 'NXP_FMUK66_TOP',
            'RDDRONE_FMUK66_TOP'}
    for link in model.findall('link'):
        for v in list(link.findall('visual')):
            nm = v.attrib.get('name', '')
            if nm == 'base_link_visual':
                mesh_uri(v, 'body.obj')
                set_pose(v, f'0 0 0.025 0 0 {YAW}')
                changes.append('base_link_visual -> body.obj (scale + yaw -90deg)')
            elif nm.startswith('rotor_') and nm.endswith('_visual'):
                idx = nm.split('_')[1]
                mesh_uri(v, f'rotor_{idx}.obj')
                set_pose(v, '0 0 0 0 0 0')
                # 原 STL 用 Gazebo Classic 的 gazebo.material 脚本着色；
                # 换成自带 MTL 的 OBJ 后必须移除，否则 gz-sim 解析不到该 URI
                for mat in list(v.findall('material')):
                    v.remove(mat)
                changes.append(f'{nm} -> rotor_{idx}.obj (hub at origin, classic material removed)')
            elif nm in drop or nm.endswith('_motor_bell') or nm.endswith('_motor_top'):
                link.remove(v)
                changes.append('removed ' + nm)
    # 保留所有 collision / inertial / joint / link pose，不做任何物理改动

    dst = EXPORT / NEW_BASE
    (dst / 'meshes').mkdir(parents=True, exist_ok=True)
    write_xml(root, dst / 'model.sdf')
    make_config(NEW_BASE,
                'x500_base derivative: PX4 x500 physics kept, visual mesh replaced '
                'by locally built Mini 3 Pro style body/rotors. visual_only replacement.',
                dst / 'model.config')
    shutil.copy2(BASE / 'LICENSE', dst / 'LICENSE')   # BSD-3-Clause 必须随附

    # ---------------- 顶层变体 ----------------
    top = ET.parse(X500 / 'model.sdf')
    troot = top.getroot()
    tmodel = troot.find('model')
    tmodel.set('name', NEW_TOP)
    for inc in tmodel.findall('include'):
        u = inc.find('uri')
        if u is not None and u.text.strip() == 'model://x500_base':
            u.text = f'model://{NEW_BASE}'
            changes.append('top include -> ' + NEW_BASE)
    dst2 = EXPORT / NEW_TOP
    dst2.mkdir(parents=True, exist_ok=True)
    write_xml(troot, dst2 / 'model.sdf')
    make_config(NEW_TOP,
                'PX4 SITL quadcopter: x500 plugins (4x MulticopterMotorModel + '
                'MotorFailurePlugin) with x500_mini3pro_base visual.',
                dst2 / 'model.config')
    shutil.copy2(X500 / 'LICENSE', dst2 / 'LICENSE')

    # ---------------- 注册进 normalized ----------------
    for src, name in ((dst, NEW_BASE), (dst2, NEW_TOP)):
        target = NORM / name
        if target.exists():
            shutil.rmtree(target)
        shutil.copytree(src, target)

    # ---------------- 报告 ----------------
    meshes = sorted(p.name for p in (dst / 'meshes').glob('*'))
    report = {
        'generated_at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
        'status': 'visual_only_replacement',
        'kept_physics': {
            'source': 'PX4/PX4-gazebo-models x500_base @ e5997f455e33ec071c7c677fc59a65781de496a4',
            'base_mass_kg': 2.0,
            'motor_positions_m': [[0.174, -0.174], [-0.174, 0.174],
                                  [0.174, 0.174], [-0.174, -0.174]],
            'plugins': ['gz-sim-multicopter-motor-model-system x4', 'MotorFailurePlugin'],
        },
        'visual': {
            'source_glb': 'drone_mini3pro.glb',
            'exported_meshes': meshes,
            'scale': SCALE,
            'yaw_rad': YAW,
            'rotor_map': {'rotor_0': 'Rotor_RR', 'rotor_1': 'Rotor_FL',
                          'rotor_2': 'Rotor_FR', 'rotor_3': 'Rotor_RL'},
        },
        'changes': changes,
        'license_note': 'BSD-3-Clause (Rudis Laboratories 2022) 原文已随两个模型目录复制；'
                        '分发时必须保留版权声明与免责声明。',
        'limitations': [
            '物理参数仍是 x500（2.0 kg / 0.348 m 对角电机距），外形是 1.993x 放大的 Mini 3 Pro，属于视觉替换而非物理重建',
            'OBJ/MTL 材质在 gz-rendering 中不等价于 glTF PBR，颜色可能有偏差',
            '本机无 gz/ros2/px4，YAW 偏移与缩放需在目标主机用最小 world 目视核对',
        ],
        'run': 'PX4_GZ_MODEL=x500_mini3pro bash start_px4_sitl.sh',
    }
    (ROOT / 'reports' / 'bridge.json').write_text(
        json.dumps(report, ensure_ascii=False, indent=1), encoding='utf-8')

    print('changes:', len(changes))
    for c in changes:
        print('  ', c)
    print('meshes:', meshes)
    print('models:', NEW_BASE, NEW_TOP, '-> normalized/models/')
    print('report:', ROOT / 'reports' / 'bridge.json')


if __name__ == '__main__':
    main()
