#!/usr/bin/env bash
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
