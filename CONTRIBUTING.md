# 参与贡献

IDFRI 仍处于早期 Beta。开始较大改动前，请先创建 Issue 说明目标。

## 开发

```sh
bun install --frozen-lockfile
bun test
bun run typecheck
```

保持改动小而明确，并为行为变化增加测试。不要提交浏览器资料、Cookie、凭据、环境文件、诊断文件、私钥或构建出的二进制文件。

本项目只提供本地版。不要重新引入 AliasMode Cloud、远程 MCP、CloakBrowser 二进制文件或无法证明可再分发权利的字体。

## 发布说明

每个 GitHub Release 必须包含一到三条用户可见的重要变化，格式如下：

```md
## Highlights
- 第一项重要变化。
- 第二项重要变化。
```

应用内更新器只显示该部分最前面的三条纯文本项目。

安全问题请遵循 [SECURITY.md](SECURITY.md)。
