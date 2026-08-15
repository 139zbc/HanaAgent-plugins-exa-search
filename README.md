# Exa Search (for HanaAgent)

> 🔗 [github.com/139zbc/HanaAgent-plugins-exa-search](https://github.com/139zbc/HanaAgent-plugins-exa-search)
> 📦 v1.0.0 · MIT License

HanaAgent 插件：用 Exa 的神经搜索引擎替代内置的 `web_search`（Tavily / Brave / Serper / AnySearch）。

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

## 快速开始

1. 下载最新 release 的 [`exa-search.zip`](https://github.com/139zbc/HanaAgent-plugins-exa-search/releases/latest)
2. 解压后把 `exa-search/` 文件夹拖入 HanaAgent 的 plugins 目录
3. 在 HanaAgent 设置 → 插件配置 Exa API Key
4. **详细安装步骤** → 见 [`exa-search/README.md`](./exa-search/README.md)

## 功能

- **接管搜索**：把 `web_search` 从 LLM 工具列表移除，注册 `exa_search` 工具代替
- **神经/语义搜索**：Exa `neural` 模式支持语义相似搜索
- **自动回落**：Exa 失败时自动恢复 `web_search`
- **三重防御**：context hook + 工具层 + straggler 兜底

## 兼容性

- HanaAgent ≥ 0.170.0
- full-access 信任级别
- Pi SDK extension API

## License

MIT — see [exa-search/LICENSE](./exa-search/LICENSE)
