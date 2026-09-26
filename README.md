# Exa Search for HanaAgent

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![HanaAgent](https://img.shields.io/badge/HanaAgent-%E2%89%A50.170.0-blue)](https://github.com/liliMozi/openhanako)
[![Plugin Trust](https://img.shields.io/badge/trust-full--access-orange)](https://github.com/liliMozi/openhanako)
[![Version](https://img.shields.io/badge/version-v1.0.0-brightgreen)](https://github.com/139zbc/HanaAgent-plugins-exa-search/releases)
[![API](https://img.shields.io/badge/Exa%20API-neural%20search-purple)](https://exa.ai)

> 用 [Exa](https://exa.ai) 的神经搜索引擎给 HanaAgent 加语义检索。
>
> 仓库里有**两代实现**，架构完全不同，按你的 HanaAgent 版本选一个。

---

## 两个版本

| | v1（插件） | v2（App） |
|---|---|---|
| 目录 | [`exa-search/`](./exa-search/) | [`exa-search-v2/`](./exa-search-v2/) |
| 清单 | `manifestVersion: 1` | `manifestVersion: 2` |
| 安装到 | `%USERPROFILE%\.hanako\plugins\` | `%USERPROFILE%\.hanako\apps\` |
| 最低版本 | HanaAgent ≥ 0.170.0 | HanaAgent ≥ 0.1050.9 |
| 与内置搜索的关系 | **替代**：用 hook 把 `web_search` 从工具列表移除 | **共存**：注册 `exa_search`，由模型按场景自己选 |
| 信任级别 | full-access | 按能力授权（`app/tools.expose-to-model`） |
| 额外能力 | 无 | 自定义设置页、uBlock Origin 名单订阅、双层域名屏蔽 |

**怎么选**：想让 Exa **接管**搜索、默认就走语义检索，用 v1；想保留内置 `web_search` 并在两者之间**分工**（精确事实走关键词、探索性调研走语义），用 v2。

> v2 是 App 形态，走宿主公开的 v2 App 契约（`defineApp` + `ctx.tools.register`），不修改宿主工具列表，也不依赖 hook。两代互不依赖，不要同时安装同一代的重复副本。

### 快速开始（v2）

```bash
# 1. 把整个 exa-search-v2 目录复制到 Hana 的应用目录：
#    <HANA_HOME>\apps\exa-search\
# 2. 重启 HanaAgent
# 3. 在 市场 → 已安装 → App 类目的「待批准」里批准它
# 4. 在 设置 → 安全 → 应用能力 打开 Exa Search 开关
# 5. 在 设置 → 应用 → Exa Search 填 Exa API Key
```

📖 v2 详细说明（设置项、名单订阅、故障排查）→ 见 [`exa-search-v2/README.md`](./exa-search-v2/README.md)

---

## 为什么需要这个插件？

HanaAgent 内置的 `web_search` 默认走 Tavily / Brave / Serper——这些是**关键词匹配**。Exa 的 `neural` 模式做的是**语义相似搜索**：

| 场景 | 关键词搜索（Tavily/Brave） | 神经搜索（Exa） |
|---|---|---|
| "Anthropic 模型新进展" | 只匹配字面含 "Anthropic" 的页面 | 找**语义相关**但**不含原词**的页面（如模型对比、相关研究） |
| "跟 Zelda 类似的开放世界游戏" | 必须含 "Zelda" | 找**风格相似**的游戏（Genshin、Skyrim 等） |
| "AI 安全 alignment 最新研究" | 限于字面命中 | 跨领域找到 RLHF / interpretability / jailbreak 等相关研究 |

**神经搜索在研究型查询上准确率显著更高**——但 HanaAgent 默认不开。本插件把它**默认设为唯一**选项。

---

## 快速开始（v1）

```bash
# 1. 下载最新 release
https://github.com/139zbc/HanaAgent-plugins-exa-search/releases/latest

# 2. 解压
exa-search.zip → exa-search/

# 3. 拖到 HanaAgent 的 plugins 目录
%USERPROFILE%\.hanako\plugins\exa-search\

# 4. 重启 HanaAgent，在设置 → 插件配置 Exa API Key
```

📖 **详细安装步骤**（含 full-access 开关、API key 配置、平台路径、故障排查）→ 见 [`exa-search/README.md`](./exa-search/README.md)

---

## 架构（三层防御）

```
┌─────────────────────────────────────────────────────────────┐
│ LLM 决策时刻                                                  │
│                                                              │
│   ① context hook（最早）                                     │
│      注入 system note + 移除 web_search                       │
│      → LLM 看不到 web_search → 直接用 exa_search             │
│                            ↓                                 │
│   ② exa_search 工具                                          │
│      调 Exa API → 成功返回结果                                │
│            ↓ 失败时                                          │
│      自动恢复 web_search + 告诉 LLM 改用                      │
│                            ↓                                 │
│   ③ straggler handler（兜底）                                 │
│      万一 web_search 漏网 → 拦截 + 调 Exa + 投递给 LLM         │
└─────────────────────────────────────────────────────────────┘
```

✅ **首次搜索就用 Exa**（context hook 提前移除 web_search）
✅ **Exa 失败自动回落** web_search（Tavily/Brave 兜底）
✅ **零工具被浪费**——即使 LLM 调 web_search 也会被劫持

---

## 项目结构

```
.
├── README.md              ← 你正在看的（仓库主页）
├── .gitignore
├── LICENSE
├── exa-search.zip         ← 打包好的 v1 插件（直接下载用）
├── exa-search/            ← v1 插件源码（hook 形态）
│   ├── README.md          ← v1 详细安装/使用文档
│   ├── LICENSE
│   ├── manifest.json
│   ├── index.js
│   ├── lib/exa-client.js
│   └── extensions/web-search-redirect.js
└── exa-search-v2/         ← v2 App 源码（App 形态）
    ├── README.md          ← v2 详细文档（安装、设置、名单订阅）
    ├── LICENSE
    ├── manifest.json      ← manifestVersion 2
    ├── index.js           ← 工具实现 + 后端路由
    ├── assets/icon.svg
    ├── ui/                ← 自定义设置页（宿主原生控件）
    ├── sdk/               ← 随包携带的 App SDK
    └── tests/             ← 本地行为测试
```

---

## 功能

- ✅ **接管搜索**：`web_search` 从 LLM 工具列表移除，注册 `exa_search` 工具代替
- ✅ **神经/语义搜索**：Exa `neural` 模式找内容相关但不匹配关键词的页面
- ✅ **自动回落**：Exa 失败时自动恢复 `web_search` 并提示 LLM 改用
- ✅ **三重防御**：context hook + 工具层 + straggler handler

---

## 兼容性

| 要求 | 值 |
|---|---|
| HanaAgent | ≥ 0.170.0 |
| 信任级别 | full-access |
| 运行时 | Pi SDK extension API |

---

## FAQ

**Q: 这个插件会破坏其他工具吗？**
不会。**只**移除 `web_search`，其他工具（web_fetch、browser、exec_command 等）完全保留。

**Q: Exa 配额用完怎么办？**
插件自动恢复 `web_search`，LLM 切回 Tavily/Brave（你的原始配置）。同时你应该去 exa.ai 升级档位。

**Q: 我的 API key 安全吗？**
存放在 HanaAgent 加密的 config storage（`secret: true`）或本地文件（`%USERPROFILE%\.hanako\plugin-data\exa-search\api-key.txt`），**不**上传、不外泄。
---

## License

MIT — see [LICENSE](./LICENSE)
