#!/usr/bin/env bash
# 终端 2：uXRCE-DDS 桥接，让 ROS2 读到 PX4 的 uORB 话题
set -euo pipefail
MicroXRCEAgent udp4 -p 8888

# 终端 3（示例）：
#   source /opt/ros/$ROS_DISTRO/setup.bash
#   ros2 topic list | grep /fmu/out
#   ros2 topic echo /fmu/out/vehicle_odometry
#   ros2 topic pub  /fmu/in/offboard_control_mode ...
# 控制指令走 /fmu/in/vehicle_command 与 /fmu/in/trajectory_setpoint。
