# 本机 OrbStack 引擎迁移记录（2026-10-18）

Docker Desktop 的全部项目依赖已迁移到 OrbStack；应用、虚拟机数据和 desktop-linux context 已移除。Docker/Compose/kubectl CLI 使用 OrbStack 提供的版本，默认 Docker context 为 orbstack。macOS 仍保留约 4 KiB 的受保护容器管理元数据，不包含引擎或业务数据。

## 实际运行

- Content Studio owner：原 `.docker-k-acceptance` 权威目录，6 个 Supabase Compose 服务、8 个既有 Kubernetes 应用全部在 OrbStack。入口 http://127.0.0.1:4310 。保持 5 篇稿件、6 项作业、暂停状态、cron 未启用；未应用 v2 数据库迁移。
- Content Studio v2 隔离实例：原 `.docker-evidence-acceptance` 权威目录，9 个 Compose 服务在 OrbStack，复用内部已授权模型服务。入口 http://127.0.0.1:15731 。保持 1 篇稿件、0 发布账号、0 作业、暂停状态。
- Appraisal：PostgreSQL、documents 服务与 auth-e2e 的 4 个 Supabase 服务迁移完成；documents 保持原先停止状态。私有生成配置在该项目 ignored 的 artifacts/local-auth/orbstack 下，认证配置没有写入源码。
- Qt：原 4 个 OrbStack 服务保持健康。保留当前 3 个可重建服务镜像，未把运行时凭证写入镜像。

## 已验证

4 个数据库合计 134 张 public/auth/storage 表逐表行数与行内容 hash 一致；Appraisal 两个冷迁移卷的 3,164 个文件 hash 一致；两个 Content Studio 媒体目录迁移前后 hash 一致。14 个迁移镜像根文件系统探针通过，owner 的实际数据库与 LocalFS/fsync 预检通过，8 个既有 Deployment 就绪。

两个网页 readiness 通过；v2 原稿质量报告仍为当前修订且通过，混合检索返回 7 个命中；内部模型实际调用通过；既有 MP4 完整解码通过。TypeScript 检查通过，508 项回归测试中 507 通过、1 项历史跳过、0 失败。

## 清理范围

删除 13 个旧或重复镜像标签、3 个闲置 Qt smoke 测试卷；构建缓存清理报告释放 2.15 GB，剩余构建缓存为 0。删除约 2.64 GB 的迁移备份、临时卷归档和旧私有容器捕获。当前业务数据库、媒体、授权文件、模型权重和各服务当前镜像保留；owner 与隔离实例是独立在用版本，分别保留运行所需镜像。清理后磁盘可用空间约 110 GiB。

系统的 Developer Documentation（1.73 GB）位于受 SIP 保护的 Apple Developer Documentation MobileAsset。Xcode Components 仅提供详情，没有删除控件；当前支持的组件 CLI 不识别该文档组件，因此尚未删除。未删除 Command Line Tools、SDK 或关闭 SIP。

## 后续验收

旧 v2 稳定性窗口已中断，不累计。新窗口于 2026-10-17T16:40:25.797Z（新加坡 10 月 18 日 00:40:25）开始，目标连续 48 小时，观测间隔超过 3 分钟或重启均不能通过。后台跟进改用 orbstack，状态不变保持安静。检索留出集 70%、500 条人工事实核验、盲评与 7 天隔离试产门槛仍未完成；迁移成功不等于 v2 正式生产验收。

详细私有比对与运行记录位于 ignored 的 `.docker-orbstack-migration`，仅保留验证记录，旧密钥捕获与数据归档已删除。没有提交任何平台内容。
