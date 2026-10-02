# IDFRI

IDFRI 是一个面向 Windows 与 Linux 的开源、本地优先指纹浏览器与多资料管理器，目标是提供 AdsPower、CloakBrowser 等产品的可审计替代方案。

> 当前状态：Beta。项目只提供本地版，不需要账号，也不会连接任何云服务。

## 功能

- 资料、Cookie、代理、扩展、脚本和浏览器会话均保存在本机
- Windows Chromium 资料使用随安装包提供的自构建开源 IDFRI Browser 153 内核
- Linux x64 预览版内置固定校验的 ungoogled Chromium 153 与 AliasMode Firefox 152
- 保留 `AliasMode Firefox` 引擎及其 Firefox 指纹能力
- 兼容常用 AdsPower Local API 路由
- 提供受保护的 Firefox 自动化网关和本地 MCP/Playwright 自动化
- 支持批量导入、导出、代理检测、分组和回收站
- Windows 安装包、更新包支持 Authenticode 与 Tauri 更新签名

IDFRI 不包含 CloakBrowser 二进制文件，也不提供 Cloud 同步、远程 MCP 或团队账号功能。

## 下载与安装

Windows x64 安装包会发布在本仓库的 [GitHub Releases](https://github.com/16188/idfri/releases)。

- `IDFRI_<版本>_x64-offline-setup.exe`：完整离线安装包
- `IDFRI_<版本>_x64-setup.exe`：应用内更新包
- `SHA256SUMS.txt`：发布文件校验值

Linux x64 预览版同时提供：

- `IDFRI_<版本>_linux_x86_64.AppImage`：免安装便携版；系统需提供 `libsecret-tools`
- `IDFRI_<版本>_linux_x86_64.deb`：Ubuntu/Debian 安装包，自动声明桌面运行依赖
- `SHA256SUMS-linux.txt`：Linux 发布文件校验值

正式发布包必须同时通过 Authenticode 签名和更新签名验证。不要从非本仓库来源下载安装包。

## 本地安全

- Local API 只监听 `127.0.0.1`。
- 每次启动生成随机 256 位 Bearer Token，并校验 `Host` 与 `Origin`。
- Token 会写入受限的本地运行时描述文件；源码启动时也会输出到本地日志。不要记录或分享 Token。
- 密码、代理认证、Cookie、会话等敏感资料使用 AES-256-GCM 加密。
- 主密钥在 Windows 上由 Credential Manager/DPAPI 保存，在 Linux 上由桌面 Secret Service 密钥环保存。

调用 Local API 时需要携带：

```http
Authorization: Bearer <本次启动生成的 Token>
```

默认兼容接口位于 `http://127.0.0.1:50400/api/v1/`。Firefox 自动化网关位于 `/api/firefox/v1/tools` 与 `/api/firefox/v1/tools/call`，使用相同的 Token、Host 和 Origin 校验。

## MCP 自动化

Windows 安装包包含 `idfri-mcp.exe`，Linux 安装包包含 `idfri-mcp`。安装后可配置已安装的 Claude Code、Codex、OpenClaw 或 Hermes：

```powershell
& "$env:LOCALAPPDATA\IDFRI\idfri-mcp.exe" setup --client auto --yes --json
```

MCP 工具沿用 `aliasmode_*` 名称，以兼容已有客户端配置；产品与可执行文件品牌均为 IDFRI。

## 浏览器与字体

Windows 开发预览版使用 [IDFRI Browser 153](https://github.com/16188/idfri-browser/releases/tag/browser-v153.0.8010.52-idfri.2)。版本固定为 `153.0.8010.52`，源码固定到独立仓库初始提交 `c7b0c258a280c4ae6dc5c9256f4f08a837bf5f13`；下载时校验发布归档 SHA-256，打包和每次启动时继续校验 `chrome.exe` 的 SHA-256。它无需账号，指纹参数由 IDFRI 资料确定，产品名、开发者信息、项目链接和默认界面均使用 IDFRI 中文配置。

Linux x64 首个预览版使用同版本的 ungoogled Chromium Portable Linux 构建，并校验归档与 `chrome` 可执行文件；Firefox 资料使用已验证的原生 Linux x64 AliasMode Firefox。Linux Chromium 暂不包含 Windows 专用的 IDFRI Chromium 源码补丁，因此高一致性资料优先选择 Firefox；后续独立 Linux Chromium 构建完成后可直接替换固定运行时。

`AliasMode Firefox` 基于 Camoufox/Firefox，代码采用 MPL-2.0。上游构建曾捆绑 Windows 和 macOS 专有字体；IDFRI 在源码安装和 Windows 打包阶段都会剔除整个 `fonts` 目录，改用用户操作系统已经安装的字体。因此不会随 IDFRI 安装包再分发这些字体，但不同系统版本的字体指纹可能存在差异。

Firefox 资料不支持 Chrome 扩展或 CDP；自动化通过 IDFRI 的 Firefox 网关完成。

## 从源码运行

需要 Windows 或 Linux x64、Bun 1.2.21 和 Node.js 22。安装依赖并验证：

```powershell
bun install --frozen-lockfile
bun test
bun run typecheck
bun cli.ts start
```

打开控制台输出的本地地址即可使用。

## 构建 Windows EXE

本机还需 Rust 1.89、Tauri 的 Windows 构建依赖和 NSIS：

```powershell
bun run desktop:build:nsis
```

发布工作流需要以下 GitHub Actions Secrets：

- `TAURI_SIGNING_PRIVATE_KEY`
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`
- `WINDOWS_CERTIFICATE_BASE64`
- `WINDOWS_CERTIFICATE_PASSWORD`

私钥和 PFX 证书不得提交到仓库。CI 先生成并验收候选安装包，再对 EXE 做 Authenticode 时间戳签名、生成 Tauri 更新签名，最后发布 GitHub Release。

## 构建 Linux AppImage/DEB

在 Ubuntu 24.04 安装 Tauri、WebKitGTK、`libsecret-tools` 与 Rust 1.89 所需依赖后运行：

```bash
bun run desktop:build:linux
```

仓库的 `Linux x64 preview` 工作流会固定并校验两个浏览器运行时，完成 Chromium/Firefox 启动验收，再发布 AppImage、DEB 与 SHA-256 校验文件。Linux 预览版暂不启用应用内自动更新。

## 许可证

桌面主程序继续遵守 [Apache-2.0](LICENSE)，`AliasMode Firefox` 继续遵守 MPL-2.0，IDFRI Browser 的构建配置与指纹补丁遵守 BSD-3-Clause；Chromium 和第三方组件继续遵守各自许可证，版权与许可证信息见 [NOTICE](NOTICE)，该 NOTICE 也随 Windows 与 Linux 安装包分发。Fork 和换品牌不会取消上游作者及第三方权利人的许可证要求。

安全问题请通过仓库的 [GitHub Security Advisory](https://github.com/16188/idfri/security/advisories/new) 私下报告；一般问题请使用 [GitHub Issues](https://github.com/16188/idfri/issues)。
