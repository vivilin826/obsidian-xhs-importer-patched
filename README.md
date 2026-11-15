# Xiaohongshu Importer (Patched)

把小红书笔记**正文、图片、视频**一起存进 Obsidian 的插件。

这是 [bnchiang96/xiaohongshu-importer](https://github.com/bnchiang96/xiaohongshu-importer) 的补丁版本（MIT 协议，原作者署名见 `LICENSE`）。原版在 2026 年小红书改版后失效：正文还能进来，图片和视频全部丢失，本仓库针对这一点做了修复。

## 为什么原版会失效

2026 年小红书改了分享页的访问策略和页面结构：

- 桌面 UA 请求笔记链接会被 **302 跳转到登录页**（`/login?redirectPath=...`），页面里根本没有笔记数据；
- 数据字段从 `noteDetailMap` 改成 `noteData.data.noteData`；
- 图片地址从 `urlDefault` 改成 `infoList`（`H5_DTL` 是 1080 大图）；
- 视频地址在 `video.media.stream.h264[0].masterUrl`，并且下载需要 `Referer`。

原版按老结构解析，就读不到任何媒体。

## 这个版本改了什么

| 项 | 做法 |
| --- | --- |
| 抓取入口 | 统一改写成 `discovery/item/<id>?xsec_token=...&xsec_source=app_share`，使用 **iPhone UA** 访问移动端分享页，不跳登录、不需要 Cookie |
| 解析 | 主路径 `noteData.data.noteData`，保留 `noteDetailMap` 和 `og/meta` 两层兜底 |
| 图片 | 取 `infoList` 里的 `H5_DTL`（1080 大图），`http` 自动升 `https` |
| 视频 | `h264 → h265 → av1 → originVideoKey` 逐级兜底，下载带 `Referer`，以 `<video controls>` 嵌进笔记 |
| 下载通道 | 优先 https + Obsidian `requestUrl`；失败自动切 Node 原生 `https.get` 流式下载 |
| 失效判断 | 链接过期（跳到 `/404/`）、被删除、风控页时给出明确提示，不再生成空笔记 |
| 文件命名 | 媒体统一用 `笔记ID-00.jpg` / `笔记ID-video.mp4`，重名笔记自动加序号不覆盖 |
| 正文 | 去掉 `#话题[话题]#` 尾巴，标签单独写进 frontmatter 的 `tags` |

## 安装

### 方式一：BRAT（推荐，可自动更新）

1. 在 Obsidian 插件市场安装 **BRAT**（Beta Reviewers Auto-update Tester）并启用；
2. 打开 BRAT 设置 → `Add Beta plugin` → 填入：

   ```
   vivilin826/obsidian-xhs-importer-patched
   ```

3. 确认安装，然后在「第三方插件」里启用 **Xiaohongshu Importer (Patched)**。

### 方式二：手动安装

1. 从 [Releases](https://github.com/vivilin826/obsidian-xhs-importer-patched/releases) 下载 `main.js`、`manifest.json`、`styles.css`；
2. 放进 `<你的库>/.obsidian/plugins/xiaohongshu-importer-patched/`；
3. 重启 Obsidian，在「第三方插件」里启用。

## 使用

1. 命令面板执行 `Import Xiaohongshu note`，或点左侧书签图标；
2. 粘贴小红书分享文字（或链接）；
3. 选分类、勾上「Download media locally」，点 Import。

## 设置项

| 设置 | 说明 |
| --- | --- |
| 默认文件夹 | 笔记按分类落到 `<文件夹>/<分类>/`，媒体统一放 `<文件夹>/media/` |
| 默认下载媒体 | 导入弹窗里那个勾的默认值 |
| 下载视频文件 | 关闭后视频只保留链接，笔记更轻 |
| 小红书 Cookie | 一般留空。**不需要登录**，只在个别受限笔记时备用 |
| 调试日志 | 在开发者控制台打印抓取状态，排查用 |

下载失败的原因会写进 `<文件夹>/media/_xhs-download-errors.log`。

## 已知限制

- **链接有时效**：`xsec_token` 过期后会跳到 `/404/`，报"链接已过期"，重新从 App 复制一条新的即可；
- **仅桌面端**：视频下载用了 Node 的 `https` 作为备用通道，所以 `isDesktopOnly: true`；
- 小红书随时可能再次改结构，届时需要更新解析路径。

## 来源与致谢

- 原版：bnchiang96 / [xiaohongshu-importer](https://github.com/bnchiang96/xiaohongshu-importer)（MIT）
- 本补丁：vivilin826，2026-11

MIT 协议要求保留原作者版权声明，`LICENSE` 中同时列明了原作者与本补丁作者。

## 免责声明

本项目仅用于个人学习与内容归档。使用前请自行确认符合小红书用户协议；请勿用于批量采集、二次分发他人内容等用途。
