# Content Studio Chrome 插件

## Content Studio 2.0.12

- 离线连接明确提示恢复入口；同一插件可空闲修复托管连接，不能借地址改动切换独立模式。
- 空闲更新保留所有待核对或损坏记录；活动执行和存储读取失败仍阻止更新。未知草稿结果全局阻止新写入，已完成且完整请求一致的回执可读取。
- 安装/更新幂等刷新 Content Studio 菜单，托管模式右键与悬浮入口均只打开任务助手。

当前产品入口为“采集 / 待处理 / 账号”。采集内容和同一保存命令在 `chrome.storage.session` 内恢复；草稿执行 journal 保留在 local storage，任何结果未知的写入均不会自动重放或清理。工作台模式与独立模式通过高级设置显式切换，执行中或待核对记录会阻止切换。

工作台通过已配对的 Companion `status.extensionRelease` 返回版本和同源下载路径。插件每次读取连接状态时展示版本变化，仅作为更新元数据，不加载或执行服务器代码。Chrome 安装包使用 `runtime.onUpdateAvailable` 提示，用户点击“检查更新”才调用 `requestUpdateCheck`，执行安全检查通过后可以应用更新。Chrome 本身的周期检查不由本插件重复触发。

通过“加载已解压的扩展程序”安装时，需要下载新版本并替换原安装目录的文件，再点击“已替换文件，重新加载”或在 `chrome://extensions` 重载现有条目。插件不能自动写入本地安装目录；不要删除插件或清空存储，配对和未知写入日志需保留。

官方依据：[Runtime 更新 API](https://developer.chrome.com/docs/extensions/reference/api/runtime)、[management.getSelf 安装类型与权限](https://developer.chrome.com/docs/extensions/reference/api/management)、[MV3 禁止远程托管代码](https://developer.chrome.com/docs/extensions/develop/migrate/improve-security)。

根据提供的 `wechatsync-2.0.9.zip` 恢复的独立 Chrome Manifest V3 工程，位于 Content Studio 的 `extension/`。此目录独立安装、构建，不加入主应用入口，不启动现有应用服务。

公开模块采用上游与 2.0.9 对应的 TypeScript 提交 `c148882`；上游公开仓库缺失的 10 个适配器及内容转换器，从提供的发行包中拆解恢复。来源、输入校验值见 [recovery.json](recovery.json)。这是可维护的源码恢复，不是原始变量名、注释、类型或字节一致构建的保证。

## 目录

```text
extension/
├── src/
│   ├── background/             后台消息分发、同步服务
│   ├── content/                网页、微信文章、微信编辑器采集
│   ├── injected/api.ts         页面 $poster / $syncer 兼容接口
│   ├── runtime/               Chrome API 运行时
│   ├── adapters/cms/          WordPress / Typecho / MetaWeblog
│   ├── editor/                文章预览编辑
│   ├── popup/                 平台列表、账户设置、历史
│   ├── sync-dialog/           内嵌同步对话框
│   ├── components/            共用 React 组件
│   ├── mcp/                   可选 WebSocket 桥接客户端
│   └── types/                 页面协议、平台环境、飞书及库类型
├── core/src/
│   ├── adapters/platforms/    19 个公开适配器，含 ZIP 导出
│   ├── adapters/recovered/    10 个从发行包还原的适配器及转换器
│   ├── runtime/              共用运行时契约
│   └── lib/                  Markdown、图片、签名及日志
├── public/lib/                原样保留的第三方阅读脚本
├── tests/                     离线适配器、转换、源码边界测试
├── scripts/                   构建验证、打包及取证辅助工具
├── manifest.json
├── package.json
├── package-lock.json
├── Dockerfile
├── LICENSE
└── RESTORATION.md              还原方法、已知差异和验证边界
```

业务逻辑使用严格 TypeScript，没有显式 `any` 和 `@ts-ignore` / `@ts-nocheck`。两个外部阅读库保留发行包中的 JavaScript 和版权头，避免把第三方编译代码伪装为原始 TypeScript。

## 安装与构建

使用项目已选择的 Node 24 和 npm。仓库根目录可执行：

```sh
dev-project content-studio npm --prefix extension ci --ignore-scripts
dev-project content-studio npm --prefix extension run verify
dev-project content-studio npm --prefix extension run package
```

需要持续编辑时运行 `dev-project content-studio npm --prefix extension run dev`，会以可读代码和 source map 持续构建 `dist/`；修改后在 Chrome 扩展页重新加载。该命令不启动 Web 服务或主应用。

在其他机器，可进入 `extension/`，使用 Node 24 执行 `npm ci --ignore-scripts`、`npm run verify` 和 `npm run package`。锁文件为此独立工程生成，不改变主应用锁文件。

产物为 `extension/dist/`；ZIP 在 `extension/artifacts/wechatsync-2.0.9-restored.zip`。`dist/` 包含 source map，可定位恢复后的 TypeScript。构建不读取原始 ZIP、临时目录或私有子模块。

Chrome 的“加载已解压的扩展程序”目标是 `extension/dist/`。安装并运行后仍可能获取公告与版本信息；平台登录检查改为显式操作，不再在唤醒时扫描全部平台。离线构建验证与真实浏览器运行是不同步骤。

## Docker 构建

沿用当前 Docker context，不启动主应用、Supabase 或发布队列：

```sh
docker build --target build -t content-studio-extension-recovery:2.0.9 extension
docker build --target artifact --output type=local,dest=extension/artifacts/docker extension
```

Docker 构建会执行离线测试、严格类型检查、扩展打包及资源验证。`.dockerignore` 排除本地认证配置、原始包与输出文件。Docker 中的扩展构建无需宿主 Node 作为最终运行时。

## 本地客户端配置

原包内嵌的 CSDN 客户端常量和 X 网页 Bearer 常量已移出源码，通过三个 `VITE_*` 设置在构建时注入。它们不是拥有者的浏览器 Cookie 或 OAuth 登录态。没有配置时仍可构建，对应平台运行能力需要单独验证。

可从同一份已校验发行包恢复到忽略的 `.env.local`，工具只报告设置名称/状态，不输出值：

```sh
dev-project content-studio npm --prefix extension run restore:client-config -- /path/to/wechatsync-2.0.9.zip
dev-project content-studio npm --prefix extension run build
```

工具校验 ZIP 的 SHA-256，拒绝其他输入。`.env.local` 以 `0600` 写入，不进入 Git、Docker 上下文或工程说明；编译后的扩展会包含注入值，与原包作为浏览器客户端的行为一致。MCP 配对 Token、平台 Cookie 和 CMS 密码仍由扩展运行时管理，未从个人浏览器导入。

## 功能与验证边界

保留 28 个在线平台、Markdown 图片 ZIP 导出、3 类 CMS、采集/编辑/草稿同步、进度和历史、本地 MCP 桥。默认同步为草稿；小红书保存到创作者站点的本地 IndexedDB，不代表服务端草稿或公开发布。

目前验证的是工程与离线契约。未安装到拥有者 Chrome，未检查真实平台登录，未上传图片或投递草稿，未作任何正式发布。上游网页接口是否仍可用，不由构建通过证明。

公开源码许可证原文保留在 `LICENSE`，第三方脚本保留自己的版权头。恢复来源及需要后续单独处理的原有风险，见 `RESTORATION.md`。

## Content Studio 草稿执行端

本工程已增加 Studio 草稿协议 v1，首轮仅接微信公众号、知乎、B站专栏。构建后从 Chrome 加载 `dist/`，在设置中启用 CLI / MCP 连接，将扩展 ID 与 Token 填入 Studio，再粘贴 Studio 生成的本机私密连接地址。需配套更新服务端；官方原版不含此协议。

Studio 地址会启用单目标草稿任务、写前账号复核、持久防重记录和严格图片校验，并暂停独立同步/旧网页写入入口。`src/studio/` 保存独立协议与执行器；Chrome 120+ alarm 只恢复连接，不重放任务。

详细架构、修改文件、安装、对账和测试见 [文章草稿执行端](../docs/extension-draft-executor.zh-CN.md)。`npm run test:integration` 从仓库根目录读取跨工程网关测试；独立发布包的 `npm run verify` 不依赖父工程。
