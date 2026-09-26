# Exa Search for HanaAgent

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![HanaAgent](https://img.shields.io/badge/HanaAgent-%E2%89%A50.1050.9-blue)](https://github.com/liliMozi/openhanako)
[![Version](https://img.shields.io/badge/version-v2.0.0-brightgreen)](https://github.com/139zbc/HanaAgent-plugins-exa-search/releases)
[![API](https://img.shields.io/badge/Exa%20API-neural%20search-purple)](https://exa.ai)

> 给 HanaAgent 的 Agent 加一把**语义搜索**：用 [Exa](https://exa.ai) 的神经检索按意思找，而不只是按关键词。

---

## 它解决什么

HanaAgent 内置的 `web_search` 走的是**关键词匹配**（Tavily / Brave / Serper / AnySearch）。这类检索要求你的用词和网页上的字面接近：

| 你想要的 | 关键词搜索怎么做 | 语义搜索怎么做 |
|---|---|---|
| 「找讨论某某思路的文章」 | 只匹配字面含那些词的文章 | 找**说的是一件事但换了说法**的文章 |
| 「跟某游戏风格相似的作品」 | 必须字面出现那个游戏名 | 找**玩法或风格相近**的作品 |
| 「某方向上的相关研究」 | 限于字面命中 | 跨到相邻领域（对齐、可解释性、越狱等） |

本 App 用 Exa 的神经检索补上这一块。**它不与内置搜索争夺入口，而是并存**：两个工具同时摆在模型面前，由模型按场景自己选。

| 走 `web_search`（内置） | 走 `exa_search`（本 App） |
|---|---|
| 精确事实、具体数字 | 说不准该用什么词 |
| 当日动态、最新消息 | 按意思捞回相关内容 |
| 找一个具体页面 | 探索性调研、看有哪些不同观点 |

> 为什么是「并存」而不是「替换」：两者擅长的问题类型不同，替换掉任何一个都会让另一类问题变难做。

---

## 快速开始

**要求：HanaAgent ≥ 0.1050.9。**

不用手动解压、不用找安装目录——在扩展页把 zip 拖进去就行。

```
1. 下载 app-exa-search-2.0.0.zip（不用解压）

2. 打开 设置 → 扩展 → 本地安装
   把 zip 拖进「拖入包文件，或点击选择」那块区域（也可以点击选择文件）

3. 在弹出的「确认安装」里核对权限，点「安装」
   应看到：应用能力 app/tools.expose-to-model，网络主机 api.exa.ai、danny0838.github.io

4. 在 设置 → 安全 → 应用能力 打开 Exa Search 开关

5. 在 设置 → 应用 → Exa Search 填 Exa API Key
   （Key 在 dashboard.exa.ai 的 API Keys 页创建）
```

「本地安装」那个入口同时接受应用包与旧版插件包，会自动识别类型，所以不用先告诉它这是哪一种。

**两个容易漏的地方：**

- **第 4 步**：第 3 步的「确认安装」只代表装上了。要让模型能主动调用 `exa_search`，还必须打开「应用能力」里那个开关。它默认关闭，而且宿主每次调用前都重查一遍——关掉立即生效。
- **第 5 步**：Exa 的 REST API **没有匿名额度**，必须自备 Key。

---

## 设置

设置页是自定义页面（用宿主原生控件渲染）。改完点右下角保存。

| 字段 | 作用 |
|---|---|
| `apiKey` | Exa API Key。**必填** |
| `defaultNumResults` | 模型没指定条数时用几，默认 5 |
| `defaultSearchType` | neural 纯语义 / keyword 纯关键词 / auto，默认 auto |
| `includeTextByDefault` | 是否每次都抓网页正文，默认关（开着更贵也更长） |
| `defaultMaxCharacters` | 抓正文时每条保留多少字符，默认 2000 |
| `highlightsMaxCharacters` | 每条结果的高亮字符上限，默认 1000。填 0 表示不设限 |

---

## 内容农场屏蔽

这是本 App 相对 v1 新增的主要能力。设置页里有独立一节，可以订阅 [uBlock Origin 格式](https://github.com/gorhill/uBlock/wiki/Static-filter-syntax)的屏蔽名单。

**订阅**：填订阅链接 → 点「更新名单」→ 抓取并解析后存在本机，之后每次检索自动生效。默认预填的是 [Content Farm Terminator](https://danny0838.github.io/content-farm-terminator/) 的名单。

**解析哪几类规则**：裸域名 / 裸 IP、`||主机^`、`||主机/路径^`、`/正则/$doc`。看不懂或表达不了的（含 `*` 的通配主机、元素隐藏规则）会**跳过并如实计数**，不做近似猜测——猜错的方向是「以为屏蔽了、实际没有」，而那种失败不会报错。

**屏蔽总开关**：一键停掉手写名单与订阅名单。它**不影响**工具参数里 `excludeDomains` 的临时排除——后者是单次调用的明确意图。

**为什么是两层**：Exa 的 `excludeDomains` 最多 **1200 条**（实测 1201 条直接报错），而一份内容农场名单动辄上万个域名。所以 Exa 那边能塞多少塞多少（提高召回质量），本机再拿全部规则滤一遍兜底。

---

## 功能一览

- **`exa_search` 工具**：参数含条数、检索方式、内容类别、域名黑白名单、发布时间区间
- **默认只给高亮，不给正文**：Exa 能吐很长的正文，全塞进上下文会撑坏窗口；需要时由模型临时打开 `includeText`
- **被截断的高亮会标 `…`**：末段贴到长度上限且断在句中时会补省略号，并附一句说明，避免被误读成排版错误
- **自定义设置页**：宿主原生控件渲染，每栏之间有分隔线
- **只读工具**：声明为只读，调用不会逐次弹审批
- **网络白名单**：只放行 `api.exa.ai`（检索）与订阅名单来源主机

---

## 旧版本 HanaAgent（v0.450.0 及以下）

**HanaAgent v0.450.0 及以下请使用 [v1.0.0](https://github.com/139zbc/HanaAgent-plugins-exa-search/releases/tag/v1.0.0)。**

v1 是**插件**形态，与 v2 的 App 形态架构完全不同，走的是 pi SDK extension API。最大的差别在策略上：v1 会把 `web_search` 从模型的工具列表里**移除**，让 Exa 成为**默认且唯一**的搜索入口。

### 安装

```
1. 从 v1.0.0 Release 下载 exa-search.zip
2. 解压，把 exa-search 目录放到：
   %USERPROFILE%\.hanako\plugins\exa-search\
3. 重启 HanaAgent
4. 在 设置 → 插件 里配置 Exa API Key
```

v1 还要求信任级别为 `full-access`。

### 实现的效果

- **首次搜索就走 Exa**：在 context hook 阶段就把 `web_search` 移除，模型直接看不到它
- **三重防御**：
  1. context hook 注入系统提示并移除 `web_search`
  2. `exa_search` 失败时自动恢复 `web_search`，并提示模型改用
  3. straggler handler 兜底——万一 `web_search` 漏网被调用，会被拦截、改调 Exa 再投递结果
- **零工具被浪费**：即使模型仍调用 `web_search`，也不会真的走内置搜索

换句话说：v1 是**接管**，v2 是**分工**。v1 详细文档见 [`exa-search/README.md`](./exa-search/README.md)。

---

## 项目结构

```
.
├── README.md              ← 你正在看的（仓库主页）
├── .gitignore
├── LICENSE
├── exa-search/            ← v1 插件源码（hook 形态）
│   （其可安装的 zip 在 v1.0.0 Release，不在仓库里）
│   ├── README.md          ← v1 详细安装/使用文档
│   ├── LICENSE
│   ├── manifest.json
│   ├── index.js
│   ├── lib/exa-client.js
│   └── extensions/web-search-redirect.js
└── exa-search-v2/         ← v2 App 源码（App 形态，当前主线）
    ├── README.md          ← v2 详细文档（安装、设置、名单订阅、故障排查）
    ├── LICENSE
    ├── manifest.json      ← manifestVersion 2
    ├── index.js           ← 工具实现 + 后端路由
    ├── assets/icon.svg
    ├── ui/                ← 自定义设置页
    ├── sdk/               ← 随包携带的 App SDK
    └── tests/             ← 本地行为测试
```

---

## 两代对比

| | v1（插件） | v2（App，当前主线） |
|---|---|---|
| 适用 HanaAgent | v0.450.0 及以下 | ≥ 0.1050.9 |
| 清单 | `manifestVersion: 1` | `manifestVersion: 2` |
| 安装方式 | 手动解压到 `.hanako\plugins\` | 设置 → 扩展 → 本地安装，拖入 zip |
| 落在哪 | `.hanako\plugins\` | `.hanako\apps\` |
| 与内置搜索的关系 | **替代**：移除 `web_search` | **共存**：由模型按场景自选 |
| 信任级别 | full-access | 按能力授权（`app/tools.expose-to-model`） |
| 设置界面 | 通用表单 | 自定义设置页 |
| 内容农场屏蔽 | 无 | uBlock Origin 名单订阅 + 双层过滤 |
| 源代码 | [`exa-search/`](./exa-search/) | [`exa-search-v2/`](./exa-search-v2/) |
| 可安装包 | v1.0.0 Release 的 `exa-search.zip` | v2.0.0 Release 的 `app-exa-search-2.0.0.zip` |

两代互不依赖，**不要同时安装同一代的重复副本**。

---

## 许可

MIT — 见 [LICENSE](./LICENSE)
