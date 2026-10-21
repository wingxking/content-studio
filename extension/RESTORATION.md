# 还原记录

日期：2026-10-15，Asia/Singapore。

## 输入与来源

- 输入：拥有者提供的 `wechatsync-2.0.9.zip`，Manifest V3，版本 2.0.9。
- SHA-256：`dfb191decd63a45063c4f6d8f7687745e5ecebe34363792dd6781b657d69fd29`。
- 公开源码：[wechatsync/Wechatsync](https://github.com/wechatsync/Wechatsync/tree/c148882)，完整提交见 `recovery.json`。
- 采用 2026-03-24 的版本提交，未混入上游 4 月、5 月之后的业务修改。
- 上游公开工程声明了私有适配器子模块；本次没有访问或复制该私有仓库。

## 恢复方式

1. 从版本匹配的上游恢复公开核心包、扩展 TypeScript/TSX、HTML、CSS、图标和许可证。
2. 将两包收拢为独立的 npm/Vite 工程，保持 `@wechatsync/core` 源码别名。
3. 静态解析发行包后台模块，按语义依赖拆出缺失适配器及共享转换代码，未执行提取输入。
4. 恢复类字段、方法签名、平台响应结构、Markdown AST、ProseMirror、Draft.js、页面全局对象和消息类型。
5. 将可识别的共享函数命名为 `parseMarkdownDocument`、`markdownToXhsDocument`、`convertBlock` 等；不能确定的局部变量保留压缩名，不声称它们是原始源码名。
6. 将注入页面的兼容 API 恢复为 `src/injected/api.ts`，构建时生成独立 IIFE。
7. 保留第三方阅读库 JavaScript 原件与版权头；源码不依赖发行包作为运行时兜底。

从发行包恢复的模块：

| 文件 | 对应能力 |
|---|---|
| `core/src/adapters/recovered/dayu.ts` | 大鱼号 |
| `core/src/adapters/recovered/douyin.ts` | 抖音图文 |
| `core/src/adapters/recovered/jianshu.ts` | 简书 |
| `core/src/adapters/recovered/netease.ts` | 网易号 |
| `core/src/adapters/recovered/smzdm.ts` | 什么值得买 |
| `core/src/adapters/recovered/sohufocus.ts` | 搜狐焦点 |
| `core/src/adapters/recovered/toutiao.ts` | 头条 |
| `core/src/adapters/recovered/x.ts` | X Articles |
| `core/src/adapters/recovered/xiaohongshu.ts` | 小红书长文 |
| `core/src/adapters/recovered/yidian.ts` | 一点号 |
| `core/src/adapters/recovered/support.ts` | 共享转换、平台格式能力及常量 |

`scripts/recover-private.mjs` 只用于静态取证，输出到忽略的 `.recovery/extracted/`，不会覆盖已审阅和补充类型的工程源码。它的输出仍需人工恢复类型，不属于正式构建步骤。

## 明确差异

- 上游使用多包工程；本次使用隔离的 `extension/` 包、npm 锁文件和显式平台导入。
- 直接依赖尽量采用上游该提交锁文件中的版本；重新生成 npm 传递依赖锁，不承诺与原 pnpm 构建字节一致。
- 开启严格 TypeScript，清理显式 `any`、类型检查屏蔽及隐式参数，业务模块使用命名导出。
- 将包内嵌的三个网页客户端认证设置改为本地配置注入，源码、记录和日志不保存这些值。
- 提供的发行包中 Analytics 网络发送函数为空。本次显式保留为空，不恢复上游可配置的 GA 网络上报。
- 页面消息恢复了结构类型；公众号临时文章提取的缺失摘要/封面规范化为 `undefined`。
- 增加 source map、构建引用校验、离线回归和 Docker 构建，不引入新的产品操作或数据库。

## 保留的原有边界

本次目标是恢复工程，没有把下列原始行为改造成 Content Studio 的生产发布能力：

- 全站 Content Script 注入及较广的扩展权限。
- 网页桥接的 `getAccounts`、`addTask`、`magicCall` 没有统一校验来源；动态方法分发也未设固定白名单。
- CMS 密码、MCP 配对 Token 保存在扩展本地存储，没有应用层加密。
- 多个平台依赖网页内部接口、页面全局对象和私有编辑器格式。
- 图片失败后部分路径继续保存，取消主要阻止后续批次，单个活动状态不是持久化队列。
- 小红书成功结果表示页面 IndexedDB 写入成功；草稿同步结果不能作为正式发布凭证。

公开部分保留上游 GPLv3 许可证原文。缺失模块按拥有者提供的发行物恢复；本记录不推定原私有子模块具有额外的公开授权。

## 验证内容

`npm run verify` 执行：

- 原有 Markdown 图片解析与 HTML → Markdown 回归。
- 29 个适配目标注册完整性，不读取账户或访问网络。
- 简书创建并更新同一草稿、抖音页面环境草稿请求、头条草稿表单契约。
- 小红书 ProseMirror 转换、表格降级、图片引用及本地 IndexedDB 草稿写入。
- X Articles 的 Draft.js 内容转换。
- 严格 TypeScript 编译、Vite 构建、Manifest/页面/脚本引用完整性及恢复模块 source map 覆盖。

上述测试使用内存运行时和模拟响应，无法代替拥有者 Chrome 中的真实平台验收。构建可以保留原版本的大型共用代码块警告；真实平台兼容性仍须单独验证。

## 后续 Studio 适配差异

上述“保留的原有边界”描述最初恢复阶段。后续 Studio 草稿协议 v1 在配置 Studio 私密地址时阻止独立同步与旧网页写入入口，移除启动时全平台登录预热，使用扩展自身页面进行正文预处理，增加最终写前账号复核、持久防重及三平台严格图片模式。普通 MCP/独立模式仍保留恢复的上游功能。说明与验证边界见 `../docs/extension-draft-executor.zh-CN.md`；这不是对原发行物字节一致的恢复。
