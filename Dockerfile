# syntax=docker/dockerfile:1

# Two stages: build the client + server bundle, then run only the bundle.
FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json vite.config.ts vitest.config.ts index.html ./
COPY src ./src
COPY tests ./tests
COPY scripts ./scripts
RUN npm run build

# --- runtime ---------------------------------------------------------------
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production

# 中文字体：界面与截图全是中文，alpine 默认没有任何 CJK 字形，
# 不装的话浏览器会把每个汉字渲染成 tofu 方块，且回退字体的度量更宽，
# 顶栏与侧栏页签的布局断言会跟着失败（CI 的 Browser smoke 就是这么挂的）。
RUN apk add --no-cache font-noto-cjk

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist

# Persisted history lives here; mount a volume to keep it across restarts.
# 目录必须先建好并 chown 给 node 用户：镜像以 USER node 运行，
# 运行期再 mkdir -p /app/data 会因为 /app 属主是 root 而 EACCES，
# 容器会静默降级为不持久化（日志里只有一行 warn）。
RUN mkdir -p /app/data && chown -R node:node /app/data
VOLUME ["/app/data"]

USER node
ENV HOST=0.0.0.0
ENV PORT=5173
EXPOSE 5173

HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||5173)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/server/index.mjs"]
