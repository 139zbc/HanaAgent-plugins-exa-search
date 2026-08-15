# Exa Search for HanaAgent

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![HanaAgent](https://img.shields.io/badge/HanaAgent-%E2%89%A50.170.0-blue)](https://github.com/liliMozi/openhanako)
[![Plugin Trust](https://img.shields.io/badge/trust-full--access-orange)](https://github.com/liliMozi/openhanako)
[![Version](https://img.shields.io/badge/version-v1.0.0-brightgreen)](https://github.com/139zbc/HanaAgent-plugins-exa-search/releases)
[![API](https://img.shields.io/badge/Exa%20API-neural%20search-purple)](https://exa.ai)

> 用 [Exa](https://exa.ai) 的神经搜索引擎替代 HanaAgent 内置的 `web_search`（Tavily / Brave / Serper / AnySearch），让 LLM 默认走语义搜索。

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

## 快速开始

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
├── exa-search.zip         ← 打包好的插件（直接下载用）
└── exa-search/            ← 插件源码
    ├── README.md          ← 详细安装/使用文档
    ├── LICENSE
    ├── manifest.json
    ├── index.js
    ├── lib/exa-client.js
    └── extensions/web-search-redirect.js
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
