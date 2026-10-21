# OrbStack Kubernetes 应用运行与回退

本部署适配器只迁移应用：API、文章／视频／投递 worker、模型执行器、renderer、CPU TTS 和可选草稿 companion。Supabase 的 PostgreSQL、REST、Auth、Storage、Kong、pgmq 和唯一 pg_cron 调度继续由原 Docker Compose 管理。业务代码、文章修订、assetId、objectKey、视频文件与 UI 路由无关。

## 边界

- `infra/k8s/base` 和 `overlays/orbstack` 是可评审模板，所有 Deployment 默认 **0 个副本**，不会直接启动 owner 工作区。运行配置生成到 ignored bind root 的 `config/kubernetes/<namespace>`，权限 0700／0600。模板没有凭证。
- 每个应用单副本、Recreate；模型共用原有单请求预算。多个 role Pod 在同一 OrbStack 节点共享 LocalFS RWO PV；PV 使用 Retain，不创建新业务数据库、队列引擎或 Kubernetes CronJob。
- API 和扩展 companion 使用 LoadBalancer；模型、renderer、TTS 和 bridge 管理接口使用 ClusterIP。OrbStack 默认只向 localhost 暴露 LoadBalancer；使用前确认其 Kubernetes 设置中未启用 LAN 暴露。ClusterIP 和 Pod IP 从 Mac 可访问，不能把它当成账号认证边界。
- 应用使用明确非 root UID/GID、去除 capabilities、不挂 ServiceAccount token、Docker socket 或 kubeconfig。静态 Supabase 凭证只进入 API／role worker；模型授权、可刷新 YouTube 凭证、journal 和配对状态使用单独私有卷，按服务限制挂载。
- renderer 与视频 worker 必须看到同一 `/data` 文件，文章和视频保留独立项目／任务。视频生成、渲染和发布审批仍是不同操作；YouTube 和 B站版本共享物理素材，平台格式与提交能力独立判断。

## 先预检，后切换

宿主仅需 OrbStack 提供的 Docker CLI、kubectl／orb 和 shell；配置生成及备份核验的 Node 在现有 Linux operations 镜像内运行。生命周期默认使用 `orbstack` Docker/Kubernetes context，仍支持显式传入其他源 Docker context 做迁移。`enable` 会恢复 OrbStack 启动前的 Kubernetes 当前 context。

同一 bind root 的配置、预检、启动、停止、备份和切换串行执行；第二个修改命令会说明当前操作及 PID，`status` 仍可读取状态。正常结束、失败和信号退出均释放自己的临时锁，备份不会包含该锁。强制终止或主机崩溃后若锁残留，先核对提示中的 PID、现有生命周期进程和 `$STUDIO_BIND_ROOT/.kubernetes-lifecycle-lock/owner.*`，确认没有操作仍在运行后再移除该锁目录；不要自动清除仍在使用的锁。

```sh
sh scripts/kubernetes.sh enable --root "$STUDIO_BIND_ROOT"
kubectl --context orbstack get nodes
```

先在 **原 Supabase 的 UUID fixture workspace** 和独立 fixture 文件目录验收，不复制 owner 内容。下面的路径和节点需替换成现场已核实的值；镜像必须在 OrbStack Docker 引擎中构建，Docker Desktop 中同名镜像不等于可用。

```sh
sh scripts/kubernetes.sh configure \
  --root "$STUDIO_BIND_ROOT" --namespace studio-k8s-fixture --context orbstack \
  --docker-context orbstack --mode fixture --workspace-id "$STUDIO_FIXTURE_WORKSPACE" \
  --mount-root "$STUDIO_FIXTURE_ROOT" --node "$STUDIO_K8S_NODE" \
  --node-root "$STUDIO_NODE_FIXTURE_ROOT" \
  --supabase-url http://host.orb.internal:56421 --image-tag "$STUDIO_BUILD_TAG"
sh scripts/kubernetes.sh render --root "$STUDIO_BIND_ROOT" --namespace studio-k8s-fixture
sh scripts/kubernetes.sh validate --root "$STUDIO_BIND_ROOT" --namespace studio-k8s-fixture
sh scripts/kubernetes.sh preflight --root "$STUDIO_BIND_ROOT" --namespace studio-k8s-fixture
sh scripts/kubernetes.sh start --root "$STUDIO_BIND_ROOT" --namespace studio-k8s-fixture
```

`render` 只写私有文件并打印资源数量，不输出 Secret；默认全为 ClusterIP，避免零副本的 LoadBalancer 抢占旧端口，只有通过门槛的 start/cutover 才开放 API 和 companion。`validate` 在 namespace 存在时使用服务端 dry-run，否则只做 schema 校验。`preflight` 要求应用已停止，创建一个短期普通网络 Pod，通过实际 Local PV/PVC 读取文件 hash、访问 Supabase runtime RPC／workspace，在唯一临时探针目录执行 fsync／rename，并由宿主回读证明是同一目录。只读原媒体，成功后删除探针。失败保留诊断 Pod，原 Compose 不停止。

`host.orb.internal` 是 **待现场验证的候选**。官方文档描述 machine→Mac 服务，官方 issue 有访问 Mac loopback 的实例，但没有保证普通 Pod 能穿过 Mac 到 Docker Desktop 的 loopback 转发。不能使用 Pod 的 `localhost` 指向 Mac；不能假定 Compose 的 `kong` DNS 跨引擎可见。预检失败则不切换，不自动暴露数据库到 LAN 或增加代理。

owner 的 `--node-root` 必须映射现有 Mac 权威 bind root。Local PV 路径由节点实际可见性决定，不假定 `/Users` 或 `/mnt/mac` 必然适用；不使用 DirectoryOrCreate 创建空 owner 目录，不静默拷贝到 OrbStack 内部卷。UID/GID 沿用原 Compose 设置，禁止递归改原目录所有权。

## 备份、采用与回退

迁移前必须有完成的隔离验收和新鲜完整备份。现有 format-3 AES-256-GCM、单独密钥、文件 hash、恢复暂停及未知提交保护保持不变。

```sh
sh scripts/kubernetes.sh stop --root "$STUDIO_BIND_ROOT" --namespace studio-k8s-fixture
sh scripts/kubernetes.sh backup --root "$STUDIO_BIND_ROOT" \
  --namespace studio-k8s-fixture --target "$STUDIO_BACKUP_DIRECTORY"
```

`backup` 停 K8s 应用后复用现有 Compose backup；它会停止原应用、暂停调度／发布、短暂停止 Supabase以冻结文件，然后只重启 Supabase，绝不自动启动旧应用或启用调度。该操作有停机窗口，应在测试和迁移门槛通过后执行。`stop` 从不删除 namespace/PVC/PV。

私有 `config/runtime-orchestrator.json` 记录当前编排所有者、是否仍有应用进程和已验收的四个镜像。K8s 在启动第一个 Pod 前先占有 runtime，全部应用 Pod 退出后才写 stopped。Docker 入口在 K8s 所有权下拒绝直接 start；K8s active 时也拒绝 stop／backup／migrate，避免跨编排备份遗漏写入者。部署回退先停止 K8s，再把 Compose 设为 stopped、用相同镜像启动，成功后记录 active。恢复到隔离目录会重写为 Compose stopped。fixture 的 marker 仅写入独立 fixture 根目录。

回退镜像必须取自已采用的 runtime marker，不能取自可被 `configure` 更新的候选配置。停止、回退和 Compose 启动不会把候选镜像写成已采用版本；只有新的门控 K8s 启动才更新发布组合。运行入口也先核对保存的 Kubernetes／源 Docker context，传错 context 时拒绝操作资源，不改变全局 context。见[复核说明](review-workflow-2026-10-15.zh-CN.md)。

owner 配置使用 `--mode owner --mount-root "$STUDIO_BIND_ROOT"`，workspace 自动取原配置；`start` 拒绝直接启动 owner。`cutover` 要求一小时内通过的 owner Pod 预检、24 小时内同 root／context／workspace 的验收记录和实际完整备份 hash。记录同时绑定完整候选配置 fingerprint 和应用镜像组合，不能把另一版本的通过结果用于当前版本；预检及验收时间不能在未来，`--backup` 必须与记录里的目录一致。`settingsFingerprint` 使用 `scripts/kubernetes.mjs` 导出的同名函数计算，`images` 从同一候选 settings 读取。验收文件是操作者对真实结果的记录，不能用单元测试或手写 true 冒充执行证据：

```json
{
  "sourceRoot": "/verified/private/root",
  "context": "orbstack",
  "workspaceId": "original-workspace-uuid",
  "settingsFingerprint": "sha256-of-the-exact-candidate-settings",
  "images": {
    "application": "content-studio:verified-build",
    "model": "content-studio-model:verified-build",
    "renderer": "content-studio-renderer:verified-build",
    "tts": "content-studio-tts:verified-build"
  },
  "checkedAt": "2026-10-15T00:00:00.000Z",
  "backupDirectory": "/verified/private/backup",
  "checks": {
    "typecheck": true,
    "tests": true,
    "fixtureFlow": true,
    "videoDecode": true,
    "restartRecovery": true,
    "noDuplicateDelivery": true
  }
}
```

```sh
sh scripts/kubernetes.sh cutover --root "$STUDIO_BIND_ROOT" --namespace content-studio-k8s \
  --evidence "$STUDIO_ACCEPTANCE_FILE" --backup "$STUDIO_BACKUP_DIRECTORY"
sh scripts/kubernetes.sh status --root "$STUDIO_BIND_ROOT" --namespace content-studio-k8s
sh scripts/kubernetes.sh rollback --root "$STUDIO_BIND_ROOT" --namespace content-studio-k8s
```

cutover 只在旧 Compose 应用全部停止后启动 K8s；已暂停开关保持暂停。rollback 先确认 Desktop 存在同一验收 release 的四个镜像，再停 K8s 并以这些镜像启 Compose，二者使用同一数据库和文件，没有双份数据回写。**这是部署方式回退，不是代码版本回退**；旧代码无法解析新增 targets／article_export 等状态，不能直接启动旧 local tag 读取新状态。代码回退需从迁移前加密备份恢复到隔离目录并单独核验。应用暂停或回退不删除媒体；无法通过网络或文件预检时维持原实例。

## 验收

需要实测：文章发现→生成→修订→草稿；同一独立视频项目的 YouTube／B站版本；真实 CPU TTS／MP4 完整解码与下载 hash；Pod 删除后的 tus／渲染 checkpoint 恢复；SIGTERM 停止认领并保持 lease fencing；未知提交不重复发送；原目录和历史 hash 不变。模型容器授权、平台账号、草稿回读、公开作品回执是独立门槛。凭证失效应降低 readiness，不通过 liveness 重启循环解决。

参考：[OrbStack Kubernetes](https://docs.orbstack.dev/kubernetes/)、[Mac 网络](https://docs.orbstack.dev/machines/network)、[loopback 实例](https://github.com/orbstack/orbstack/issues/2413)、[Kubernetes Local PV](https://kubernetes.io/docs/concepts/storage/volumes/#local)。

## 2026-10-15 已执行的隔离检查点

- OrbStack 2.2.4 / Kubernetes 1.36.5+orb1 / arm64 节点实际启动。保留 Docker 当前 context `desktop-linux` 和原本没有 Kubernetes current-context 的状态；仅新增显式 `orbstack` Docker context。
- fixture 和 owner 原目录均通过普通 Pod→`host.orb.internal:56421`→Docker Desktop Compose Supabase 的实际健康／workspace 查询。7 个静态 Local PV/PVC Bound，原目录代表性文件 hash 及临时 fsync／rename 宿主回读通过；没有复制业务文件。
- 独立 workspace `079684ef-e6d6-4836-9d9d-50b88b6a02db`、namespace `studio-k8s-fixture` 使用真实应用 API、pgmq role worker、CPU Kokoro 和 MPT renderer。API Pod 重建后，643 字节 Tus 半传位置保留并完成相同 SHA-256 的 PNG；fixture 显式暂停发布，未启全局 cron。
- 原创蓝图视频项目 `0ed600e8-d84f-41fc-8865-89ec6fd71465` 产生横屏 320×180 MP4（`3dc81be4791e47a670ede29a378a51b18fae498d606c7c804ae4dcb8b27f550b`）和竖屏 180×320 MP4（`436a9a9af47f22ab43d49d2f5e6e604f2d4fb274c8c6f6614cd66295f4349715`）。两者实际下载 hash 与 FFmpeg 完整解码通过。
- 同项目 YouTube／B站手动版本各产生一条 `awaiting_operator` job，重复请求返回相同 job。video-worker／renderer Pod 重建后再次请求原渲染，保持两条原 render ID、同字节 hash 和相同 job 数；投递 attempt 为零、外部作品为零。
- v4 另验证真实执行中断：在 MPT 子进程已经开始 render 后暂停它，从 OrbStack Docker 向 renderer HTTP 主进程发 STOP（同 PID namespace 内向 PID 1 发 STOP 不能作为可靠暂停证据），恢复 MPT 子进程并对 video-worker 发正常 Pod 删除。旧业务 attempt 取消且 output 为 null，随后旧上游状态实际 succeeded、HTTP 恢复后的迟到结果仍未提升业务结果。未手工修改数据库时间／lease；等实际 120 秒队列可见性到期后，同一 operation/render ID 由新 owner 取得，attempt 1→2，复用 9 个真实阶段。960×540 MP4 SHA-256 为 `37455bce908dd049b67a255f3a5bf9e7d84844262bf83d3bf7232701b396a4c4`，完整下载与 FFmpeg 解码通过，没有新增投递或外部作品。
- fixture API `14410` 和 companion `19529` 的 macOS 实际监听均核实为 `127.0.0.1`。7 个应用 Ready，fixture 模型因未授权保持真实 `0/1`；此次手工原创脚本的真实渲染不证明模型生成或平台登录。
- API 首个 fixture 写入前 workspace 不存在，会令上传最终登记外键失败；通过显式 fixture 初始化写入后重新执行完整半传／重启／续传通过。脚本已把初始化与暂停设为显式准备步骤。上游 TTS 的 PORT 必须明确为 8880，避免公共配置中的 API PORT 覆盖。
- fixture UI 和最终测试门槛通过后，owner 已用 `20261015-workflow-v4` 完成门控切换：8 个 Deployment Ready（含原 model-auth 授权）、`/readyz` 200、原 5 篇文章／6 条投递记录且 paused=true；Desktop 仅保留 6 个 Supabase 服务。4310／19527 实际仅监听 Mac 127.0.0.1，fixture 所有应用 Pod 已停止，文件和 PV 保留。浏览器 companion 配置存在，但切换后首次连接状态为 false，不能把 bridge 进程 Ready 当成扩展已经连接。
- 生命周期往返验收使用 `20261015-workflow-v5`，已完成 K8s→同版本 Compose→K8s 的实际往返：三个检查点均为 5 篇文章、6 条投递记录、2 个独立视频项目，文章内容／完整视频项目／投递状态的规范化 SHA-256 分别逐项一致；paused=true、schedulerEnabled=false，未执行平台提交。Compose 启动前等待全部 K8s 应用 Pod 消失，K8s 再启动前停止全部 Compose 应用。往返结束后 8 个 K8s Deployment Ready，Desktop 只有 Supabase 服务，监听仍仅为 127.0.0.1。
- 往返首次尝试暴露 `Compose up` 自动协调依赖的问题：Postgres／REST 容器被重建（沿用原持久目录），Kong 缓存旧 REST 地址导致 HTTP 502。停止应用后仅重启 Kong 刷新连接，回退改为 `up --no-deps --wait` 并显式传递与 Docker wrapper 一致的 root／project 环境；修正后实际重跑的 Compose 回退及最终 K8s 切换均保持六个 Supabase 容器 ID 不变，内容哈希一致。未向 owner 恢复备份或复制数据库。此故障没有计作成功验收。
- Compose 健康检查现配置为 API `/readyz` 与三个 worker 的进程内 `8911/readyz`，避免只看存活进程或瞬时 running 状态。Compose 配置校验及同命令的四个实际进程检查通过；最终运行在 K8s，没有为健康检查配置再重复切换。`tests/kubernetes-lifecycle.test.ts` 用真实 shell＋隔离 CLI 替身验证停止顺序、固定镜像、`--no-deps` 以及 root／project 环境，`tests/kubernetes-roundtrip-probe.mjs` 在两种运行环境内只读核对内容、开关和哈希。
- v5 往返后的 K8s 重启，在已核实的 owner Chrome profile 唤醒原有文章同步助手 popup，未修改 token／URL／权限，未点击任何平台同步。被动 bridge 检查 configured=true、connected=true；这只证明连接恢复，不等同于某平台原生草稿或发布验收。
- 最终采用 `20261015-workflow-v8`，应用镜像在 Desktop／OrbStack 核实为相同 `sha256:885caba324d159332cf27fdaf33a66bc01b1d586caa08ffa19188227bc1a4252`。先正常停止全部 v5 应用，受支持迁移应用 SQL024 后，v8 原目录与数据库普通 Pod 预检、服务端 dry-run 和门控切换均通过。最终 8/8 Ready、`/readyz` 200；仍为 5 篇文章／6 条投递记录／2 个视频项目，文章／视频／投递哈希与 v5 三阶段基线逐项一致，发布暂停、调度关闭。六个 Supabase 容器 ID 与 v5 修正后的往返保持一致；没有重启／重建 Supabase，也没有从备份覆盖 owner 数据。新私有 runtime marker 为 Kubernetes active，四个组件均指向 v8 发布别名；部署回退应使用同一 v8 bundle。此次仅升级业务代码／SQL，未重复或冒充 v8 完整生命周期往返。
- v8 最后一次应用重启后，再核实原 owner Chrome profile，只唤醒原有文章同步助手 popup 一次。被动检查 configured=true、connected=true；没有修改配置、凭证、权限或执行平台动作。

可重放的容器内验收脚本为 `tests/kubernetes-video-smoke.mjs`，prepare／render／verify 三阶段之间分别重建 API 和视频服务；interrupt-start／interrupt-snapshot／interrupt-aborted／interrupt-late／interrupt-verify 分阶段断言执行中断、旧上游成功但未提升及租约后恢复。每一阶段要求显式 fixture UUID 与容器工作区相同。该记录是隔离检查点，最终 owner 采用、部署方式回退、账户授权和备份恢复以最新 acceptance 记录为准。

## 2026-10-15 后续复核

最终运行版本为 `20261015-review-v9`（应用镜像 `sha256:d5c00bbd399f4570098a6b1fbdae83e3975ff98f54b8f3ada036a739b3c3fbc9`），8/8 Ready。实际把候选配置中的应用镜像改为从未采用、且引擎中不存在的下一版 tag 后，回退仍使用 marker 中的 v9 四镜像，并通过 Compose readiness；恢复已验证配置后，再次门控切换回 K8s。三阶段业务 hash 一致，原 6 个 Supabase 容器 ID 和 868 个权威业务文件 hash 不变，发布／调度保持暂停。错误 context 的实际入口也在调用资源前被拒绝。详细界面与兼容回归见[复核说明](review-workflow-2026-10-15.zh-CN.md)及[最新验收](acceptance.md)。
