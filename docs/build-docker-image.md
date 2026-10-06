# 构建 All-in-One Server 镜像

本文记录 `apps/server/Dockerfile`（镜像 `metacubexd-server`：dashboard + Control Agent + 内置 mihomo 内核）的本地构建方式。

CI 发布流程见 [`.github/workflows/release.yml`](../.github/workflows/release.yml) 的 `release-server-image`（`linux/amd64,linux/arm64` 双架构 → `ghcr.io/metacubex/metacubexd-server`）；本文只讲本地构建与验证。仅需 dashboard 的独立面板镜像请改用 `packages/ui/Dockerfile`。

## 前置条件

- Docker，且 `docker buildx` 可用（`docker buildx version`）。本机默认构建器即可，无需额外创建 builder。
- 能访问 Docker Hub、npm registry、GitHub Releases —— 通常需要一个本地代理，见下文的代理参数。
- 在仓库根目录执行（见「注意事项」里的构建上下文说明）。
- 本地磁盘需求：构建过程会拉取 `node:22-alpine`、执行 `pnpm install` 并产出 `~/.output`，预留数 GB 空间。

## 完整构建命令

```bash
docker buildx build --progress=plain \
  --network=host \
  --build-arg HTTP_PROXY=http://127.0.0.1:7890 \
  --build-arg HTTPS_PROXY=http://127.0.0.1:7890 \
  --build-arg http_proxy=http://127.0.0.1:7890 \
  --build-arg https_proxy=http://127.0.0.1:7890 \
  --build-arg NO_PROXY=localhost,127.0.0.1,::1 \
  --build-arg no_proxy=localhost,127.0.0.1,::1 \
  --provenance=false --sbom=false \
  -f apps/server/Dockerfile \
  -t metacubexd-server:local --load .
```

成功后得到本地镜像 `metacubexd-server:local`，并已载入本地镜像库（`--load`）。

## 参数说明

| 参数                                                        | 作用                                                                                                                                                                                                                  |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--progress=plain`                                          | 用纯文本输出构建日志（不折叠、不做动态刷新），便于排查或贴日志；不需要时去掉即可。                                                                                                                                    |
| `--network=host`                                            | 构建阶段直接用宿主机网络栈（仅 Linux）。**必需前提**：`127.0.0.1:7890` 这类代理地址只有走 host 网络才可达。                                                                                                           |
| `--build-arg HTTP_PROXY/HTTPS_PROXY/http_proxy/https_proxy` | 传给构建阶段的代理，构建期生效、写入构建缓存，**不进入最终镜像**（最终镜像不设置代理环境变量）。大小写各写一份是因为不同工具（curl / npm / pnpm / Node）读取的变量名不同。                                            |
| `--build-arg NO_PROXY/no_proxy`                             | 让 `localhost`、`127.0.0.1`、`::1` 绕过代理，避免构建阶段访问本地地址被代理拦截。                                                                                                                                     |
| `-f apps/server/Dockerfile`                                 | 指定 Dockerfile 路径。                                                                                                                                                                                                |
| `-t metacubexd-server:local`                                | 本地镜像标签。要与 `compose.yaml` 配合时可改成任意名字。                                                                                                                                                              |
| `--load`                                                    | 把构建结果载入本地 Docker 镜像库（`docker images` 可见）。buildx 默认只留在构建缓存中，**不加 `--load` 就没有本地镜像**。                                                                                             |
| `--provenance=false --sbom=false`                           | 关闭 BuildKit 默认附加的 provenance/SBOM attestation。不加的话，推送到不支持 OCI 1.1 attestation 的仓库（如阿里云 ACR）会在最后一步被拒，见[「推送到其它镜像仓库」](#推送到其它镜像仓库如阿里云-acr)。GHCR 不受影响。 |
| `.`                                                         | 构建上下文 = 仓库根目录，这是硬性要求（见下）。                                                                                                                                                                       |

代理地址按本机实际情况调整，例如本机代理监听其它端口，或使用 `http://host.docker.internal:7890`（`--network=host` 下用 `127.0.0.1` 即可）。

## 构建上下文：必须是仓库根目录

Dockerfile 顶部明确写了这一点：

```dockerfile
# Build context MUST be the repo root: docker buildx build -f apps/server/Dockerfile .
```

因为构建阶段需要 `pnpm-workspace.yaml`、`pnpm-lock.yaml`、`tsconfig.base.json` 以及 `packages/`（`ui`、`agent`）和 `apps/server` 三个 workspace 包；上下文换成 `apps/server` 会因缺少根配置与 `packages/` 而失败。

根目录 `.dockerignore` 会排除 `**/node_modules`、`**/.output`、`**/.git`、`apps/desktop` 等，因此上下文很小、传输很快。`apps/server/.dockerignore` 在此构建路径下不生效（Docker 只读取上下文根目录的那一份）。

## Dockerfile 的四个阶段

| 阶段      | 基础镜像                             | 产出                                                     |
| --------- | ------------------------------------ | -------------------------------------------------------- |
| `ui`      | `node:22-alpine`（`$BUILDPLATFORM`） | `packages/ui/.output/public` 静态 dashboard              |
| `server`  | `node:22-alpine`（`$BUILDPLATFORM`） | `apps/server/.output`（Nitro node-server）               |
| `kernel`  | `alpine:3.20`（目标架构）            | 目标架构的 mihomo 二进制                                 |
| `runtime` | `node:22-alpine`                     | `/app` 下的 server + `ui-dist` + `/usr/local/bin/mihomo` |

要点：

- 前两个阶段用 `--platform=$BUILDPLATFORM`，即用构建机原生架构编译；只有 `kernel` 阶段取目标架构，因此交叉构建（如 `--platform=linux/arm64`）不会卡在 QEMU 模拟上，相对快很多。
- `kernel` 阶段按 `TARGETARCH` 下载对应二进制，当前只支持 `amd64`（`mihomo-linux-amd64-compatible-*`）与 `arm64`（`mihomo-linux-arm64-*`），其它架构会直接报 `unsupported arch` 退出。
- 内核版本由构建参数 `MIHOMO_VERSION` 控制，Dockerfile 默认 `v1.19.27`（与 CI 一致）。需要指定其它版本时追加：

```bash
docker buildx build ... --build-arg MIHOMO_VERSION=v1.19.30 ... -t metacubexd-server:local --load .
```

- 运行时以 `tini` 作为 PID 1，`docker-entrypoint.sh` 把 `CONTROL_PORT` 映射为 Nitro 的 `PORT` 后 `exec node /app/server/index.mjs`。

## 运行构建出的镜像

镜像环境变量默认值（Dockerfile `ENV` + `supervisor.ts` 读取）：

| 变量                  | 默认值                  | 说明                                                    |
| --------------------- | ----------------------- | ------------------------------------------------------- |
| `CONTROL_TOKEN`       | 空                      | Control API 访问令牌，`''` 表示不校验，仅限本机试用     |
| `CLASH_SECRET`        | 空                      | mihomo Clash API 的 `secret`                            |
| `GITHUB_TOKEN`        | 空                      | 可选，提升 GitHub Releases API 配额                     |
| `DEFAULT_BACKEND_URL` | 空                      | 可选，预填 connect 表单的后端地址                       |
| `CONTROL_PORT`        | `8080`                  | dashboard + `/api/control` 端口（同时作为健康检查端口） |
| `CLASH_API_PORT`      | `9090`                  | mihomo Clash API / WebSocket                            |
| `MIXED_PORT`          | `7890`                  | 混合 HTTP/SOCKS 代理端口                                |
| `DATA_DIR`            | `/data`                 | profiles、active.yaml、内核与缓存目录（卷）             |
| `MIHOMO_BIN`          | `/usr/local/bin/mihomo` | 内核路径                                                |
| `TZ`                  | 容器默认                | 时区，例如 `Asia/Shanghai`                              |

带上三个端口和 `/data` 卷运行：

```bash
docker run -d --name metacubexd-local \
  -e CONTROL_TOKEN=change-me-control \
  -e CLASH_SECRET=change-me-clash \
  -p 127.0.0.1:8080:8080 -p 127.0.0.1:9090:9090 -p 127.0.0.1:7890:7890 \
  -v metacubexd-data:/data \
  metacubexd-server:local
```

`127.0.0.1:端口:端口` 只绑定本机回环，避免把控制面板暴露到局域网/公网；需要跨机访问时请配合防火墙与 TLS 反向代理，并务必设置 `CONTROL_TOKEN`、`CLASH_SECRET`。

要用 Compose 跑同一份配置，可基于 [`docs/docker-compose.yml`](./docker-compose.yml)（或 [`apps/server/compose.yaml`](../apps/server/compose.yaml)）把 `image:` 换成 `metacubexd-server:local`；后者的 `.env` 在首次 `up` 前需备好 `CONTROL_TOKEN`、`CLASH_SECRET`。

## 验证构建

```bash
# 1) 本地镜像存在
docker images metacubexd-server:local

# 2) 架构正确（本机构建应为宿主架构；交叉构建会显示目标架构）
docker image inspect -f '{{.Architecture}} {{.Os}}' metacubexd-server:local

# 3) 容器可正常启动并自检
docker logs --tail 50 metacubexd-local
curl -fsS http://127.0.0.1:8080/api/control/health

# 4) 内核版本（与 MIHOMO_VERSION 对应）
docker exec metacubexd-local mihomo -v

# 5) 清理
docker rm -f metacubexd-local
```

`docker run` 之后 `docker ps` 显示 `healthy` 即说明 HEALTHCHECK（`wget http://127.0.0.1:8080/api/control/health`）通过。

## 多架构构建

```bash
docker buildx build --platform=linux/arm64 -f apps/server/Dockerfile \
  -t metacubexd-server:arm64 --load .
```

- 单架构 + `--load` 可用；也可以把结果导出为文件：`--output=type=docker,dest=metacubexd-server.tar`。
- 想同时产出多架构并直接推送，需要支持多平台输出的 builder 与镜像仓库登录：

```bash
docker buildx build --platform=linux/amd64,linux/arm64 \
  -f apps/server/Dockerfile \
  -t ghcr.io/<owner>/metacubexd-server:local-test --push .
```

注意多平台构建不能配合 `--load`（本地镜像库只能存单一平台），必须用 `--push` 或 `--output`。

## 推送到其它镜像仓库（如阿里云 ACR）

buildx ≥ 0.11 默认给镜像附加 provenance/SBOM attestation；Docker 开启 containerd image store 时，`--load` 到本地再 `docker push` 同样会带上。attestation 子 manifest 引用 OCI 1.1 的空层 `application/vnd.oci.empty.v1+json`，而部分仓库（阿里云 ACR 等）不支持 OCI 1.1，表现为所有层都推送成功、最后提交 manifest 时报错：

```text
error from registry: unknown manifest class for application/vnd.oci.empty.v1+json
```

解决方法就是构建时加 `--provenance=false --sbom=false`（本文的完整命令与速查均已包含）。层缓存都在，为补参数重跑一次很快。GHCR 不受影响，CI 推送无需处理。

```bash
docker buildx build ... --provenance=false --sbom=false \
  -f apps/server/Dockerfile \
  -t <registry>/<namespace>/metacubexd-server:latest --push .
```

推送后验证：`docker buildx imagetools inspect <registry>/<namespace>/metacubexd-server:latest`，正常应只有一条 image manifest（`application/vnd.oci.image.manifest.v1+json` 或 docker v2），没有 attestation 条目。注意：报错的那次推送只上传了层、远端 tag 未更新，成功推送后才会指向新版本。

## 缓存与提速

- 层缓存：`pnpm install --frozen-lockfile` 只在 `pnpm-lock.yaml` / `pnpm-workspace.yaml` 变化时重新执行，其余层命中缓存，重复构建会明显更快；需要干净重建时加 `--no-cache`。
- 本机内核若已在运行，构建期间同样会占用代理带宽（`pnpm install` + `mihomo` 二进制下载），必要时错开。
- CI 使用 `cache-from/cache-to: type=gha`；本地想复用 registry 缓存，可注册带缓存导出的 builder，例如：

```bash
docker buildx build \
  --cache-to=type=registry,ref=<registry>/metacubexd-server:cache,mode=max \
  --cache-from=type=registry,ref=<registry>/metacubexd-server:cache \
  -f apps/server/Dockerfile -t metacubexd-server:local --load .
```

（`--cache-to` 需要支持导出缓存的 builder 与已登录的 registry；`--cache-to=type=local,dest=./cache` 可落盘到本地目录。）

## 注意事项与常见问题

- **必须用 buildx，不要用 `docker build`**：Dockerfile 依赖 `$BUILDPLATFORM` 与 buildx 提供的 `TARGETARCH`。
- **构建上下文必须是仓库根目录**：`-f apps/server/Dockerfile` 与结尾的 `.` 缺一不可，否则会因缺少根配置/`packages/` 而失败。
- **代理只在构建期生效**：`--build-arg` 里的代理不会进入运行中的容器；容器内需要代理请自行设置运行时环境变量。
- **代理不可达会表现为拉取/下载失败**：确认宿主机代理监听 `127.0.0.1:7890`（命令里四个代理变量都用该端口），并确认使用了 `--network=host`，否则 `127.0.0.1` 指向的是容器而不是宿主机的代理。
- **推送报 `unknown manifest class for application/vnd.oci.empty.v1+json`**：默认 attestation 不被阿里云 ACR 等仓库支持，构建时加 `--provenance=false --sbom=false`，详见[「推送到其它镜像仓库」](#推送到其它镜像仓库如阿里云-acr)。
- **HEALTHCHECK 端口写死在镜像里**：健康检查命令在构建时展开 `CONTROL_PORT`（默认 8080）。运行时改 `CONTROL_PORT` 并不会改健康检查地址，容器会显示 unhealthy；这种情况请用 `--health-cmd` 覆盖。
- **交叉构建产物不能直接在本机跑**：`--platform=linux/arm64` 的镜像在 amd64 宿主上需 QEMU：`docker run --platform=linux/arm64 ...`。
- **架构不受支持**：`TARGETARCH` 非 `amd64`/`arm64` 时 `kernel` 阶段以 `unsupported arch` 失败，需扩展 Dockerfile。
- **磁盘空间**：`pnpm install` 安装 1500+ 个包，加上 Nitro 构建产物与内核下载，构建缓存会持续占用数 GB，注意清理（`docker buildx prune`）。

## 速查

```bash
# 标准本地构建（代理按需）
docker buildx build --progress=plain --network=host \
  --build-arg HTTP_PROXY=http://127.0.0.1:7890 \
  --build-arg HTTPS_PROXY=http://127.0.0.1:7890 \
  --build-arg http_proxy=http://127.0.0.1:7890 \
  --build-arg https_proxy=http://127.0.0.1:7890 \
  --build-arg NO_PROXY=localhost,127.0.0.1,::1 \
  --build-arg no_proxy=localhost,127.0.0.1,::1 \
  --provenance=false --sbom=false \
  -f apps/server/Dockerfile -t metacubexd-server:local --load .

# 指定内核版本
#   --build-arg MIHOMO_VERSION=v1.19.30

# 单架构 arm64 构建
#   --platform=linux/arm64

# 推送到 GHCR 以外的仓库（如阿里云 ACR）时务必保留 --provenance=false --sbom=false
#   -t <registry>/<namespace>/metacubexd-server:latest --push

# 运行并自检
docker run -d --name metacubexd-local \
  -e CONTROL_TOKEN=change-me-control -e CLASH_SECRET=change-me-clash \
  -p 127.0.0.1:8080:8080 -p 127.0.0.1:9090:9090 -p 127.0.0.1:7890:7890 \
  -v metacubexd-data:/data metacubexd-server:local
curl -fsS http://127.0.0.1:8080/api/control/health
```
