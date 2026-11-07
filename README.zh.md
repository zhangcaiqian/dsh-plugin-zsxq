# dsh-plugin-zsxq

中文 | [English](README.md)

**把你订阅的知识星球，变成一份可检索的本地 Markdown 知识库 —— 直接在 DeepSeek Harness 里完成。**

同步帖子与附件、抽取 `docx` / `PDF` 正文和图片、重建索引、检索内容——全部用纯 JavaScript 实现。
不需要 Python，不依赖外部服务，不上传任何数据。

```
同步帖子 ──▶ 下载附件 ──▶ 抽取 docx/PDF 正文与图片 ──▶ Markdown
                                                        │
        向 agent 提问 ◀── 检索 ◀── 建索引 ◀── 补分类/摘要/金句（skill）
```

## 为什么做它

知识星球的内容很难沉淀：帖子在 App 里，真正有价值的部分往往是附件（`docx`、`PDF`、音频），
而你自己的历史内容既不能全文搜索，也不方便交给 agent 处理。想在电脑上读、想让 AI 帮你总结，
基本只能手工导出。

这个插件把「你自己订阅的内容」变成可查询的本地资产：

- 📥 **一句话同步** —— 今天 / 指定日期 / 整月 / 最近 N 条 / 按标签
- 📄 **附件变成正文** —— `docx` 段落与内嵌图片、`PDF` 文本与页面图片，全部写进帖子旁的 Markdown
- 🔎 **只搜你订阅的内容** —— 关键词 / 标签 / 频道 / 分类 / 日期，基于本地索引，毫秒级
- 🧠 **对 agent 友好** —— 7 个强类型工具；配合 `dsh-skill-zsxq` 获得完整的富化规范（分类、摘要、金句）
- 🔒 **本地优先** —— 所有内容写在你指定的目录；Cookie 只存在 `config.json`
- 🐍 **彻底告别 Python** —— 这是 Python 版 skill 的完整 JS 重写，并做过逐字节验证

## 安装

```sh
# 已发布 npm 时
dsh plugin --profile web add dsh-plugin-zsxq

# 现在可以直接从 GitHub 安装
dsh plugin --profile web add github:zhangcaiqian/dsh-plugin-zsxq

# 本地开发
dsh plugin --profile web add link:/path/to/dsh-plugin-zsxq
```

安装后**重启 DSH**（插件模块不会热重载）。

> **DSH Desktop 用户**：优先在 **设置 → 插件** 里安装；如果用命令行，务必把 `DSH_HOME` 指向桌面端的
> harness 目录，否则会装进另一个无关的 profile。

### 可选：配套 skill

插件负责「执行」，skill 负责「怎么富化」（主题分类、≤50 字摘要、金句提取、完整工作流）。
想要完整体验就一起装：

```sh
dsh plugin --profile web add github:zhangcaiqian/zsxq-skill
```

不装也能用——工具描述里已包含基本流程，只是没有完整手册。

## 快速开始

1. **初始化数据目录**

   对 agent 说：*「初始化知识星球知识库」* → `zsxq_init` 会创建
   `$DSH_HOME/zsxq-kb/{channels,assets,data,index}` 和 `config.json` 模板
   （默认目录；配置了 `dataDir` 时以配置为准）。

2. **填 Cookie**

   1. 浏览器打开 <https://wx.zsxq.com> 扫码登录，确认能正常刷出星球帖子；
   2. `F12` → **Network** → 过滤 `api.zsxq.com` → 刷新页面 → 点任意一条请求；
   3. **Headers → Request Headers → `Cookie`**，复制冒号后的**整串**（通常形如
      `zsxq_access_token=…; abtest_env=product`，不止一项是正常的）；
   4. 写入数据目录下的 `config.json`：默认 `$DSH_HOME/zsxq-kb/config.json`，
      配置了 `dataDir` 就是 `<dataDir>/config.json`：

   ```json
   { "zsxq_cookie": "zsxq_access_token=…; abtest_env=product", "channels": {}, "tag_to_category": {} }
   ```

   - Cookie 就是账号凭据：**不要**提交 Git，也**不要**贴到聊天、截图或 issue 里；
   - 实测有效期约 **1 个月**；失效表现为 **HTTP 401**（工具会返回 `ZSXQ_COOKIE_EXPIRED`），
     重新复制一份覆盖即可；
   - 改完用 `zsxq_doctor` 验证：它会真实调用一次 API，只报告 Cookie 是否有效，**不回显** Cookie 内容。

3. **选星球**

   说：*「检查一下知识星球配置」* → `zsxq_doctor` 会真实调用一次 API，验证 Cookie 并告诉你
   账号能访问哪些星球。把要同步的填进 `config.json`：

   ```json
   {
     "channels": {
       "my-channel": {
         "name": "我的星球",
         "group_id": "123456789012",
         "default_scope": "digests"
       }
     }
   }
   ```

   > `default_scope` 常用 `digests`（精华）；星主问答、晚课、非精华讨论要 `all` 才拉得到。

4. **同步**

   说：*「同步今天的内容」* → `zsxq_sync`（`mode=today`）。

5. **富化 → 建索引 → 检索**

   让 agent 按 skill 补 `topic_category` / `keywords` / `summary` 并写 `.quotes.md`，
   然后说 *「重建索引」*（`zsxq_rebuild_index`），最后 *「搜一下流动性」*（`zsxq_search`）。

## 工具

| 工具 | 作用 | 是否写盘 |
|---|---|---|
| `zsxq_init` | 创建数据目录与 `config.json` 模板 | 首次 |
| `zsxq_doctor` | 验证 Cookie、列出可访问星球、检查索引健康 | 否 |
| `zsxq_list_channels` | 列出已配置频道 | 否 |
| `zsxq_status` | 文章/金句数量、索引是否落后、同步状态 | 否 |
| `zsxq_search` | 关键词/标签/频道/分类/日期检索 | 否 |
| `zsxq_sync` | 同步帖子 + 附件 + 抽取正文，按 topic id 去重 | **channels/ assets/ data/raw/ .synced_ids** |
| `zsxq_rebuild_index` | 重建 `INDEX.md`、`index.json`、各类分片索引 | **index/ INDEX.md** |

内置安全护栏：

- `count` 上限 **30** —— 知识星球接口对更大分页直接返回 `code=14001`
- `refresh`（整月重拉）必须显式确认 `confirmDestructive`，且只允许单频道 —— 它会删除该月本地文件（含你的富化内容）
- 同步按 `.synced_ids` 幂等，重复运行不会产生重复文章

## 能抽取什么

| 附件 | 抽取结果 |
|---|---|
| `.docx` | 段落正文（对齐 python-docx 语义）+ `word/media/*` 内嵌图片 |
| `.pdf` | 页面文本（含中文，内置 CMap）+ 页面图片（转 PNG） |
| `.mp3` / 音频 | 只下载（不做转写） |
| 帖子图片 | 保留远程签名 URL 写进 Markdown |
| 文章贴（`inline_article_url`） | HTML 正文 → 纯文本 |

附件里抽出的图片会以 `embedded-<附件序>-<图序>.<ext>` 落在 md 同目录，并在 `## 🖼️ …` 段落中引用。

## 数据目录结构

```
<dataDir>/
├── config.json            # Cookie + 频道（不要提交 Git）
├── .synced_ids            # 去重状态
├── channels/<频道>/<年>/<月>/<日>/<标题>.md
│                                        └── <标题>.quotes.md      # 金句（agent 生成）
├── assets/<频道>/<年>/<月>/<日>/…                              # docx / pdf / mp3 / *_images/
├── data/raw/<频道>/<年>/<月>/<日>/<topic_id>.json              # API 原始数据
├── index/index.json        # 检索的数据源
├── index/by-{date,tag,topic,channel}/… , quotes-index.md
└── INDEX.md
```

## 配置项

在 profile 的 `cordis.patch.yml`（行 id `zsxq-tools`）里改，或通过 **设置 → 插件** 改 volatile 字段：

| 字段 | 默认 | 说明 |
|---|---|---|
| `dataDir` | `$DSH_HOME/zsxq-kb` | 知识库目录；环境变量 `ZSXQ_BASE_DIR` 优先级更高 |
| `requestIntervalMs` | `1500` | API 请求间隔 |
| `syncTimeoutMs` | `900000` | 单频道同步超时 |
| `indexTimeoutMs` | `120000` | 索引重建超时 |

```yaml
- id: zsxq-tools
  config:
    dataDir: /Users/you/knowledge-base
```

## 技术说明：为什么这个 JS 版可信

这是对成熟 Python skill 的**完整重写**，而且在写工具层之前先做了逐字节验证：

| 验证项 | 结果 |
|---|---|
| `docx` 文本 vs python-docx（41 个真实文件） | **41/41 逐字一致**（284,679 字符） |
| `docx` 内嵌图片 | **41/41 一致**（文件名/大小/SHA-256） |
| Markdown 渲染 vs Python 渲染器（133 篇真实帖子） | **133/133 逐字一致** |
| 富文本 `<e>` / hashtag / 文件名 | **63/63、63/63、133/133** |
| `PDF` 中文文本 vs PyMuPDF | 一致（依赖内置 CMap） |
| docx 抽取速度 | 比 Python 版**快约 3.4 倍** |
| 安装体积 | 约 **8MB** 纯 JS + CMap（Python 版含 PyMuPDF 与运行时约 **52MB**） |

两个容易被忽略的坑，已经处理：

- **18 位 topic_id**：超过 `Number.MAX_SAFE_INTEGER`，`JSON.parse` 会静默丢精度
  （`…514` 变成 `…510`）。插件用 `json-bigint` 解析，并用 `JSON.rawJSON` 把 id 原样写回数字字面量。
- **中文 PDF 需要 pdf.js 的 CMap**：插件内置 `assets/pdf/cmaps`（2.4MB，Apache-2.0）并传本地路径，
  因此**不需要**安装 36MB 的 `pdfjs-dist`，也用不到 29MB 的可选原生包 `@napi-rs/canvas`。

## 隐私与安全

- 所有内容只写在你指定的 `dataDir`，插件不会上传任何数据；
- Cookie 从磁盘上的 `config.json` 读取，只发送给 `api.zsxq.com` 与签名附件地址；
- 没有统计、没有遥测、没有后台请求；所有网络请求都由你触发的工具产生；
- 破坏性操作必须显式确认；同步是幂等的。

## 限制

- **不做语音转写**：音频只下载，Markdown 里留占位提示（ASR 是后续计划）
- **不做金句海报生图**
- **扫描版 PDF** 没有文字层 → 抽不到文本（OCR 不在范围内）
- **docx 表格 / 页眉页脚** 不抽取（与 Python 版行为一致）
- 文章贴正文抽取是尽力而为：付费墙或纯 JS 渲染的页面可能拿不到全文
- 需要有效的订阅 Cookie，只能访问你本来就是成员的星球

## 常见问题

| 现象 | 原因 / 处理 |
|---|---|
| `ZSXQ_COOKIE_EXPIRED` / HTTP 401 | Cookie 过期，重新复制一份到 `config.json` |
| `code=14001` | `count` 超过 30（接口上限） |
| `ZSXQ_CONFIG_MISSING` | 没有 `config.json` 或没有 `zsxq_cookie`，先跑 `zsxq_init` |
| 搜不到刚同步的文章 | 索引过期，富化后要跑 `zsxq_rebuild_index` |
| md 只有标题没有正文 | 附件抽取失败，检查 `assets/…` 与 `## 📄` 段落 |
| 插件装好了但没工具 | 确认 profile 组合配置里有 `zsxq-tools` 行（`dsh --profile web --dump-config`） |

## 路线图

- 可插拔 ASR，支持语音转写
- 超大型库的增量索引
- 可选 Python 后端开关（给已经在用原 skill 的用户）

## 许可与致谢

MIT。`assets/pdf/` 下的 PDF CMap 与字体来自 [Mozilla PDF.js](https://github.com/mozilla/pdf.js)（Apache-2.0，见 `assets/pdf/NOTICE.md`）。

本项目与知识星球（zsxq.com）无关，仅用于整理你有权访问的内容。
