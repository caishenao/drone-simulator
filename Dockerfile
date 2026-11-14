# 无人机模拟器生产镜像：前端静态产物 + Socket.IO 全球空域服务器，单端口同源。
# 构建：docker build -t drone-simulator .
# 运行：docker run -d --name drone-simulator -p 8080:8080 --restart unless-stopped drone-simulator
#   页面      http://<host>:8080/
#   健康检查  http://<host>:8080/  （返回 {ok:true, players, origin}）

# —— 阶段一：构建前端（vite 产物已含 Cesium UMD 与机体 GLB，来自 npm run assets）——
FROM node:22-alpine AS webbuild
WORKDIR /app
# 先装依赖再拷源码：package 未变时命中 Docker 层缓存
COPY web/package.json web/package-lock.json ./web/
RUN cd web && npm ci --no-audit --no-fund
COPY web/ ./web/
# 机体模型在仓库根目录，prepare-assets.mjs 从上级取
COPY drone_mini3pro.glb ./
RUN cd web && npm run build

# —— 阶段二：运行时（仅 server 运行时依赖 + 静态产物）——
FROM node:22-alpine
WORKDIR /app
COPY server/package.json server/package-lock.json ./server/
RUN cd server && npm ci --omit=dev --no-audit --no-fund
COPY server/ ./server/
COPY --from=webbuild /app/web/dist ./dist

# MP_HOST=0.0.0.0：容器必须绑全部网卡才能映射出去
# MP_ORIGINS=*：页面与 Socket.IO 同源时 CORS 不再是约束，通配即可
# MP_ORIGIN_LON/LAT/NAME：空域起飞点，运行时可用 -e 覆盖
ENV NODE_ENV=production \
    MP_HOST=0.0.0.0 \
    MP_PORT=8080 \
    MP_STATIC_DIR=/app/dist \
    MP_ORIGINS=*
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:8080/healthz >/dev/null 2>&1 || exit 1
CMD ["node", "server/index.mjs"]
