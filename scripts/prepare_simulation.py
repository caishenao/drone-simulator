# -*- coding: utf-8 -*-
"""把 raw/ 中固定版本的模型整理成 Gazebo 可直接解析的 normalized/models/ 目录，
并生成启动脚本与验证报告。

关键点：SDF 的 model://<name> 要求目录名与模型名一致，
Fuel 下载目录是 fuel_xxx/3，不能直接被 GZ_SIM_RESOURCE_PATH 解析。
"""
import json
import shutil
import time
from pathlib import Path

ROOT = Path(r'D:\work\self\无人机模型器\sim_px4')
RAW = ROOT / 'raw'
NORM = ROOT / 'normalized' / 'models'
SHA = 'e5997f455e33ec071c7c677fc59a65781de496a4'
PX4 = RAW / 'px4-gazebo-models' / SHA / 'models'
FUEL = RAW / 'gazebo-fuel' / 'OpenRobotics'

# 规范目录名 -> (源目录, 说明, 目标运行时)
MAP = {
    'x500': (PX4 / 'x500', 'PX4 官方 SITL 四旋翼，含 4x MulticopterMotorModel 插件', 'Gazebo Sim (gz)'),
    'x500_base': (PX4 / 'x500_base', 'x500 的物理/视觉基础模型（被 x500 include merge）', 'Gazebo Sim (gz)'),
    'parrot_bebop_2': (FUEL / 'fuel_parrot_bebop_2' / '3',
                       'CC0 消费级四旋翼，含惯量/碰撞，但无电机插件', 'Gazebo Classic / Sim 视觉'),
    'iris_with_standoffs': (FUEL / 'fuel_iris_standoffs' / '3',
                            'CC0 3DR Iris，7 link / 5 collision / 无插件', 'Gazebo Classic'),
    'iris_demo': (FUEL / 'fuel_iris_arducopter' / '3',
                  'CC0 ArduCopter + LiftDrag + 云台插件演示（依赖 gimbal_small_2d）', 'Gazebo Classic (EOL)'),
}


def copy_model(src, dst):
    if dst.exists():
        return 'kept'
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(src, dst, ignore=shutil.ignore_patterns('_*.json'))
    return 'copied'


def main():
    NORM.mkdir(parents=True, exist_ok=True)
    result = {}
    for name, (src, desc, runtime) in MAP.items():
        if not src.exists():
            result[name] = {'ok': False, 'reason': 'source missing: ' + str(src)}
            continue
        state = copy_model(src, NORM / name)
        result[name] = {'ok': True, 'state': state, 'source': str(src.relative_to(RAW)),
                        'description': desc, 'runtime': runtime,
                        'has_config': (NORM / name / 'model.config').exists(),
                        'has_sdf': (NORM / name / 'model.sdf').exists()}

    # ROS2 / PX4 SITL 启动脚本（PX4 SITL 需 Linux 或 WSL2，Windows 原生不可跑）
    sh = ROOT / 'start_px4_sitl.sh'
    sh.write_text('''#!/usr/bin/env bash
# PX4 SITL + Gazebo Sim 启动（在 WSL2 / Ubuntu 中执行，Windows 原生不支持 PX4 SITL）
# 用法: ASSET_DIR=/mnt/d/work/self/无人机模型器/sim_px4 PX4_DIR=~/PX4-Autopilot bash start_px4_sitl.sh
# 换成自建外形: PX4_GZ_MODEL=x500_mini3pro bash start_px4_sitl.sh
set -euo pipefail
: "${ASSET_DIR:?请设置 ASSET_DIR 为本 sim_px4 目录的 WSL 路径}"
: "${PX4_DIR:?请设置 PX4_DIR 为 PX4-Autopilot 仓库路径}"

# model://x500 / model://x500_base 从这里解析
export GZ_SIM_RESOURCE_PATH="${ASSET_DIR}/normalized/models${GZ_SIM_RESOURCE_PATH:+:${GZ_SIM_RESOURCE_PATH}}"
export PX4_GZ_MODEL="${PX4_GZ_MODEL:-x500}"
export PX4_GZ_MODEL_POSE="${PX4_GZ_MODEL_POSE:-0,0,0.15,0,0,0}"

echo "GZ_SIM_RESOURCE_PATH=$GZ_SIM_RESOURCE_PATH"
echo "PX4_GZ_MODEL=$PX4_GZ_MODEL"

cd "$PX4_DIR"
make px4_sitl gz_x500
''', encoding='utf-8')

    sh2 = ROOT / 'start_ros2_bridge.sh'
    sh2.write_text('''#!/usr/bin/env bash
# 终端 2：uXRCE-DDS 桥接，让 ROS2 读到 PX4 的 uORB 话题
set -euo pipefail
MicroXRCEAgent udp4 -p 8888

# 终端 3（示例）：
#   source /opt/ros/$ROS_DISTRO/setup.bash
#   ros2 topic list | grep /fmu/out
#   ros2 topic echo /fmu/out/vehicle_odometry
#   ros2 topic pub  /fmu/in/offboard_control_mode ...
# 控制指令走 /fmu/in/vehicle_command 与 /fmu/in/trajectory_setpoint。
''', encoding='utf-8')

    dl = json.loads((ROOT / 'manifests' / 'downloads.json').read_text(encoding='utf-8'))
    audit = json.loads((ROOT / 'reports' / 'audit.json').read_text(encoding='utf-8'))
    validation = {
        'generated_at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
        'host_capability': audit['host_capability'],
        'static_checks': audit['checks'],
        'normalized_models': result,
        'runtime_validation': {
            'status': 'not_run',
            'reason': '本机 Windows 无 gz / ros2 / px4，无法启动最小 world 或检查插件加载',
            'required_on_target_host': [
                'gz sim 能解析 model://x500 与 model://x500_base',
                'gz-sim-multicopter-motor-model-system 插件可加载',
                'MotorFailurePlugin 有对应编译产物（PX4 构建提供）',
                'make px4_sitl gz_x500 能连上仿真、/fmu/out/vehicle_odometry 有数据',
            ],
        },
        'gaps': [
            'Iris + ArduCopter 演示版依赖 model://gimbal_small_2d，本地未下载；且属 Gazebo Classic / ArduPilot，与 PX4 SITL 不同栈',
            'Parrot Bebop 2 与 Iris with Standoffs 都没有电机插件，只能作为视觉或惯量模型',
            'PX4 x500 / x500_base 是 BSD-3-Clause（Rudis Laboratories 2022），分发时必须保留 LICENSE 与版权声明',
            'x500_base 物理质量为 2.0 kg、对角电机间距 0.348 m；与自建 Mini 3 Pro 外形（0.247 m 轴距）不一致，视觉替换需缩放并标注为 visual_only',
            '缩略图（thumbnails/*.png）按设计未下载，不影响仿真',
        ],
        'recommended_primary': 'normalized/models/x500 + x500_base @ ' + SHA,
        'total_downloaded_bytes': dl['total_bytes'] if 'total_bytes' in dl else sum(r['bytes'] for r in dl['files']),
    }
    (ROOT / 'reports' / 'validation.json').write_text(
        json.dumps(validation, ensure_ascii=False, indent=1), encoding='utf-8')

    print('normalized models:')
    for k, v in result.items():
        print(f"  {k:24s} {v.get('state', v.get('reason')):8s} "
              f"config={v.get('has_config')} sdf={v.get('has_sdf')}")
    print('scripts:', sh.name, sh2.name)
    print('report :', ROOT / 'reports' / 'validation.json')


if __name__ == '__main__':
    main()
