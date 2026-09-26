/**
 * Exa Search 自定义设置页。
 *
 * 这是一个普通 HTML 文档，跑在宿主签发的 iframe 里，用宿主自己的控件
 * （`./assets/app-ui.js` 自带 React 运行时，页面不需要打包器、不需要装 React）。
 *
 * 数据全部走后端：`hana.api.fetch` 打到本应用注册的 /state、/save、
 * /blocklist/update、/blocklist/clear。页面自己不认识 Exa，也不解析 uBO 格式，
 * 那些事实只有一个出处。
 */

import { appUi, mountAppUi } from "./assets/app-ui.js";
import { hana } from "./assets/hana-ui.js";

const DEFAULT_SUBSCRIPTION_URL =
  "https://danny0838.github.io/content-farm-terminator/files/blocklist-ubo/content-farms.txt";

/**
 * 归到「内容农场屏蔽名单」那一节渲染的字段。
 *
 * 这三个说的是同一件事：开关是总闸，`blockedDomains` 是它控制的手写名单，
 * 订阅名单也是它控制的。所以两个字段都不在「检索设置」里出现，
 * 要在通用字段循环里排掉，单独画。
 *
 * 尤其是 `blockedDomains`：它是普通 schema 字段，很容易被当成普通设置留在
 * 「检索设置」里，但那样读者要跳两节才能弄清「开关管的是什么」。
 */
const BLOCKLIST_SECTION_KEYS = ["blocklistEnabled", "blockedDomains"];

/** 开关、手写名单、订阅名单三者共用的键。 */
const BLOCKLIST_TOGGLE_KEY = "blocklistEnabled";
const MANUAL_DOMAINS_KEY = "blockedDomains";

const state = {
  schema: null,
  values: {},
  blocklist: null,
  limits: null,
  subscriptionUrl: "",
  bootError: null,
  actionError: null,
  actionNote: null,
  loading: true,
  saveStatus: "idle",
  clearing: false,
};

const root = document.getElementById("root");
const boot = document.getElementById("boot");
let handle = null;

/* ------------------------------------------------------------ 跟随宿主主题 */

/**
 * 让这一页真的长得像宿主的一部分。
 *
 * 官方控件的样式依赖一套宿主主题变量，而主题样式表是按 `[data-theme="xxx"]`
 * 写的选择器。SDK 会把主题 id 告诉页面，但不会把它写成属性；属性没人设，
 * 主题样式表即使注入进来也匹配不到任何元素。所以这里要自己补上属性，
 * 再把主题样式表拉进 head。
 *
 * 拉不到不是致命错误：theme-fallback.css 里已经垫了默认主题的取值。
 */
const THEME_STYLE_ATTR = "data-hana-theme-style";

function applyThemeAttribute(snapshot) {
  const id = typeof snapshot?.theme === "string" ? snapshot.theme.trim() : "";
  if (id) document.documentElement.dataset.theme = id;
}

async function applyHostThemeCss(cssUrl) {
  if (typeof cssUrl !== "string" || !cssUrl) return;
  try {
    const response = await fetch(cssUrl, { credentials: "same-origin" });
    if (!response.ok) return;
    const css = await response.text();
    let element = document.querySelector(`style[${THEME_STYLE_ATTR}]`);
    if (!element) {
      element = document.createElement("style");
      element.setAttribute(THEME_STYLE_ATTR, "");
      document.head.appendChild(element);
    }
    element.textContent = css;
  } catch {
    // 拿不到主题样式表时保留 theme-fallback.css 的外观。
  }
}

function followHostTheme() {
  try {
    const snapshot = hana.theme.getSnapshot();
    applyThemeAttribute(snapshot);
    void applyHostThemeCss(snapshot?.cssUrl);
    hana.theme.subscribe((next) => {
      applyThemeAttribute(next);
      void applyHostThemeCss(next?.cssUrl);
    });
  } catch {
    // 主题不可用时保持兜底外观。
  }
}

/* ------------------------------------------------------------------ 数据 */

async function callApi(path, init) {
  const response = await hana.api.fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  let data = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }
  if (!response.ok) {
    const detail = data && typeof data.error === "string" ? data.error : `HTTP ${response.status}`;
    throw new Error(detail);
  }
  // 双保险：后端对失败一律回非 2xx，但即便状态码被中间层改写了，
  // 也绝不能让 ok:false 被当成成功——那正是「更新失败却提示已更新」的来源。
  if (data && typeof data === "object" && data.ok === false) {
    throw new Error(typeof data.error === "string" ? data.error : "后端报告了失败，但没有给出原因。");
  }
  return data;
}

async function bootPage() {
  try {
    const data = await callApi("/state");
    state.schema = data?.schema ?? null;
    state.values = data?.values && typeof data.values === "object" ? { ...data.values } : {};
    state.blocklist = data?.blocklist ?? null;
    state.limits = data?.limits ?? null;
    state.subscriptionUrl = state.blocklist?.sourceUrl || DEFAULT_SUBSCRIPTION_URL;
  } catch (error) {
    state.bootError = `读取设置失败：${error.message}`;
  } finally {
    state.loading = false;
    if (boot) boot.remove();
    render();
    // 必须在首次渲染之后调：宿主收到这个握手，才会把主题、尺寸、
    // surface context 这些事件补发给本页。没调的话宿主不知道这页面活着。
    try {
      hana.ready();
    } catch (error) {
      state.actionError = `与宿主握手失败：${error.message}`;
      render();
    }
  }
}

/* --------------------------------------------------------------- 写配置 */

function setValue(key, value) {
  state.values[key] = value;
  if (state.saveStatus === "saved") state.saveStatus = "idle";
  render();
}

async function saveValues() {
  state.saveStatus = "saving";
  state.actionError = null;
  state.actionNote = null;
  render();

  const known = Object.keys(state.schema?.properties ?? {});
  const payload = {};
  for (const key of known) {
    if (key in state.values) payload[key] = state.values[key];
  }

  try {
    const result = await callApi("/save", { method: "POST", body: JSON.stringify({ values: payload }) });
    state.saveStatus = "saved";
    if (Array.isArray(result?.skipped) && result.skipped.length) {
      state.actionNote = `有 ${result.skipped.length} 项没有写入：${result.skipped.join("、")}`;
    }
    // "saved" 只是宿主按钮的一个短暂反馈档，三秒后自己回到 idle。
  } catch (error) {
    state.saveStatus = "idle";
    state.actionError = `保存失败：${error.message}`;
  }
  render();
}

/* ------------------------------------------------------------ 更新名单 */

async function updateBlocklist() {
  const url = String(state.subscriptionUrl ?? "").trim();
  if (!url) {
    state.actionError = "还没有填订阅链接。";
    state.actionNote = null;
    render();
    return false;
  }

  state.actionError = null;
  state.actionNote = null;

  try {
    const result = await callApi("/blocklist/update", {
      method: "POST",
      body: JSON.stringify({ url }),
    });
    state.blocklist = result?.blocklist ?? null;
    if (state.blocklist?.sourceUrl) state.subscriptionUrl = state.blocklist.sourceUrl;
    return true;
  } catch (error) {
    state.actionError = error.message;
    return false;
  } finally {
    render();
  }
}

async function clearBlocklist() {
  state.clearing = true;
  state.actionError = null;
  state.actionNote = null;
  render();
  try {
    await callApi("/blocklist/clear", { method: "POST" });
    state.blocklist = null;
    state.actionNote = "本地名单已清除。";
  } catch (error) {
    state.actionError = `清除失败：${error.message}`;
  } finally {
    state.clearing = false;
    render();
  }
}

/* --------------------------------------------------------------- 渲染 */

/** schema 里除屏蔽开关以外的字段，按声明顺序。 */
function schemaFields() {
  const properties = state.schema?.properties;
  if (!properties || typeof properties !== "object") return [];
  return Object.entries(properties)
    .filter(([key]) => !BLOCKLIST_SECTION_KEYS.includes(key))
    .map(([key, field]) => [key, field && typeof field === "object" ? field : {}]);
}

function fieldOf(key) {
  const field = state.schema?.properties?.[key];
  return field && typeof field === "object" ? field : {};
}

function currentValue(key, field) {
  const value = state.values[key];
  if (value !== undefined && value !== null && value !== "") return value;
  return field.default;
}

/** 屏蔽开关的当前取值：存过就用存的，否则用 schema 默认（true）。 */
function blocklistEnabled() {
  const stored = state.values[BLOCKLIST_TOGGLE_KEY];
  if (typeof stored === "boolean") return stored;
  const fallback = fieldOf(BLOCKLIST_TOGGLE_KEY).default;
  return typeof fallback === "boolean" ? fallback : true;
}

function labelFor(field, raw) {
  const labels = field.ui && Array.isArray(field.ui.enumLabels) ? field.ui.enumLabels : null;
  const index = Array.isArray(field.enum) ? field.enum.indexOf(raw) : -1;
  if (labels && index >= 0 && typeof labels[index] === "string") return labels[index];
  return String(raw);
}

/** 一个 schema 字段画成什么控件。 */
function fieldControl(key, field) {
  const ariaLabel = String(field.title || key);
  const value = currentValue(key, field);

  if (Array.isArray(field.enum) && field.enum.length) {
    return appUi("Select", {
      key,
      ariaLabel,
      options: field.enum.map((entry) => ({ value: String(entry), label: labelFor(field, entry) })),
      value: String(value ?? ""),
      onChange: (next) => setValue(key, next),
    });
  }

  if (field.type === "boolean") {
    return appUi("Toggle", {
      key,
      ariaLabel,
      checked: value === true,
      onChange: (next) => setValue(key, next),
    });
  }

  if (field.type === "integer" || field.type === "number") {
    const fallback = typeof field.default === "number" ? field.default : 0;
    return appUi("NumberInput", {
      key,
      ariaLabel,
      value: typeof value === "number" ? value : Number.isFinite(Number(value)) ? Number(value) : fallback,
      min: typeof field.minimum === "number" ? field.minimum : undefined,
      max: typeof field.maximum === "number" ? field.maximum : undefined,
      precision: field.type === "integer" ? "int" : "float",
      emptyValue: fallback,
      onChange: (next) => setValue(key, next),
    });
  }

  // 手写名单天生是多行，给它一个文本域，跟订阅名单分开写。
  if (key === MANUAL_DOMAINS_KEY) {
    return appUi("TextArea", {
      key,
      rows: 4,
      spellCheck: false,
      value: String(value ?? ""),
      placeholder: "每行一个，或用逗号分隔；# 之后可以写注释",
      onChange: (event) => setValue(key, event.target.value),
    });
  }

  return appUi("TextInput", {
    key,
    type: field.sensitive ? "password" : "text",
    spellCheck: false,
    value: String(value ?? ""),
    onChange: (event) => setValue(key, event.target.value),
  });
}

/**
 * 一行的排版。
 *
 * SettingsRow 默认把控件挤在右边一小格（实测输入框只有 168px、下拉只有 69px），
 * 对 API Key、多行名单这类长文本不够用，所以按字段类型分别给：
 * 长文本走 stacked（标签在上、控件占满整行），数字与下拉留在 inline。
 */
function rowLayoutFor(key, field) {
  if (key === MANUAL_DOMAINS_KEY) return { layout: "stacked" };
  if (field.type === "string" && !Array.isArray(field.enum)) return { layout: "stacked" };
  if (Array.isArray(field.enum)) return { controlSize: "lg" };
  if (field.type === "integer" || field.type === "number") return { controlSize: "number" };
  return {};
}

function settingsSection() {
  const fields = schemaFields();
  if (!fields.length) {
    return appUi("SettingsSection", {
      key: "fields",
      title: "检索设置",
      children: [
        appUi("EmptyState", {
          key: "empty",
          title: "没能读到设置字段",
          description: "后端没有给出 schema。下面那份屏蔽名单仍然可用。",
        }),
      ],
    });
  }

  return appUi("SettingsSection", {
    key: "fields",
    title: "检索设置",
    description: "这些值写在宿主的设置贡献里，改完点右下角保存。",
    children: [
      appUi("SettingsStack", {
        key: "fields-stack",
        gap: "md",
        children: fields.map(([key, field]) =>
          appUi("SettingsRow", {
            key: `row-${key}`,
            label: String(field.title || key),
            hint: field.description ? String(field.description) : undefined,
            ...rowLayoutFor(key, field),
            control: fieldControl(key, field),
          }),
        ),
      }),
    ],
  });
}

function formatTime(iso) {
  if (!iso) return "未知时间";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return String(iso);
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function blocklistSummaryText() {
  const counts = state.blocklist?.counts ?? {};
  return (
    `${counts.hosts ?? 0} 个域名 · ${counts.ipHosts ?? 0} 个 IP · ` +
    `${counts.hostPaths ?? 0} 条路径规则 · ${counts.regexes ?? 0} 条正则 · ` +
    `${counts.unsupported ?? 0} 条表达不了`
  );
}

function blocklistSection() {
  const enabled = blocklistEnabled();
  const toggleField = fieldOf(BLOCKLIST_TOGGLE_KEY);
  const manualField = fieldOf(MANUAL_DOMAINS_KEY);

  const rows = [
    appUi("SettingsRow", {
      key: "bl-enabled",
      label: String(toggleField.title || "启用内容农场屏蔽"),
      hint: enabled
        ? String(toggleField.description || "关闭后，手写名单与订阅名单都不再生效。")
        : "已关闭：下面那份手写名单与订阅来的名单都不再生效。工具参数里临时指定的排除仍然有效。",
      hintVariant: enabled ? "default" : "warn",
      control: appUi("Toggle", {
        key: "bl-toggle",
        ariaLabel: String(toggleField.title || "启用内容农场屏蔽"),
        checked: enabled,
        onChange: (next) => setValue(BLOCKLIST_TOGGLE_KEY, next),
      }),
    }),

    // 手写名单。它受上面那个开关控制，所以跟开关放在同一节，不留在「检索设置」里。
    appUi("SettingsRow", {
      key: "bl-manual",
      label: String(manualField.title || "永久屏蔽的域名"),
      hint: manualField.description ? String(manualField.description) : undefined,
      layout: "stacked",
      control: fieldControl(MANUAL_DOMAINS_KEY, manualField),
    }),

    appUi("SettingsRow", {
      key: "bl-url",
      label: "订阅链接",
      hint: "只支持 uBlock Origin 格式的纯文本名单。点「更新名单」会抓取、解析并保存在本机。",
      layout: "stacked",
      control: appUi("SettingsStack", {
        key: "bl-url-stack",
        gap: "sm",
        children: [
          appUi("TextInput", {
            key: "bl-url-input",
            type: "url",
            spellCheck: false,
            value: state.subscriptionUrl,
            placeholder: DEFAULT_SUBSCRIPTION_URL,
            onChange: (event) => {
              state.subscriptionUrl = event.target.value;
            },
          }),
          appUi("Inline", {
            key: "bl-actions",
            gap: "sm",
            align: "center",
            children: [
              appUi("VerificationButton", {
                key: "bl-update",
                ariaLabel: "更新订阅名单",
                labels: {
                  idle: "更新名单",
                  testing: "更新中…",
                  success: "已更新",
                  failure: "更新失败",
                },
                onVerify: updateBlocklist,
              }),
              appUi("Button", {
                key: "bl-clear",
                variant: "ghost",
                disabled: !state.blocklist || state.clearing,
                loading: state.clearing,
                onClick: clearBlocklist,
                children: "清除订阅",
              }),
            ],
          }),
        ],
      }),
    }),

    appUi("SettingsRow", {
      key: "bl-status",
      label: "当前名单",
      hint: state.blocklist
        ? `${state.blocklist.sourceUrl}　更新于 ${formatTime(state.blocklist.fetchedAt)}`
        : "还没订阅。填一个 uBlock Origin 格式的名单地址，点上面的「更新名单」抓取并解析。",
      hintVariant: state.blocklist ? "default" : "warn",
      layout: "stacked",
      control: state.blocklist ? blocklistSummaryText() : "尚未订阅",
    }),
  ];

  const limitNote = Number.isFinite(state.limits?.domainListMax)
    ? `Exa 单次最多接受 ${state.limits.domainListMax} 条排除域名，所以超出的部分靠本机过滤兜底，效果不受影响。`
    : "Exa 单次能接受的排除域名有上限，超出的部分由本机过滤兜底，效果不受影响。";

  return appUi("SettingsSection", {
    key: "blocklist",
    title: "内容农场屏蔽名单",
    description:
      "支持 uBlock Origin 格式。名单里的裸域名、||主机^、||主机/路径^、/正则/$doc 都会被解析；" +
      "含 * 的通配主机与元素隐藏规则本工具表达不了，会跳过并计数。" +
      limitNote,
    children: [appUi("SettingsStack", { key: "bl-stack", gap: "md", children: rows })],
  });
}

/** 顶部的启动错误、底部的操作结果，都不是「栏」，所以不放进行的流里。 */
function buildTree() {
  const children = [];

  if (state.bootError) {
    children.push(appUi("ErrorState", { key: "boot-error", title: "设置页没能读到状态", message: state.bootError }));
  }

  children.push(settingsSection());
  children.push(blocklistSection());

  if (state.actionError) {
    children.push(appUi("ErrorState", { key: "action-error", title: "没成功", message: state.actionError }));
  } else if (state.actionNote) {
    children.push(
      appUi("EmptyState", { key: "action-note", title: "上次操作的结果", description: state.actionNote }),
    );
  }

  children.push(
    appUi("Inline", {
      key: "save-row",
      justify: "end",
      align: "center",
      gap: "sm",
      children: [
        appUi("SaveButton", {
          key: "save",
          status: state.saveStatus,
          labels: { idle: "保存设置", saving: "保存中…", saved: "已保存" },
          onSavedFeedbackEnd: () => {
            state.saveStatus = "idle";
          },
          onClick: saveValues,
        }),
      ],
    }),
  );

  return { gap: "xs", children };
}

function render() {
  if (state.loading) return;
  const props = buildTree();
  if (!handle) handle = mountAppUi(root, "SettingsStack", props);
  else handle.update(props);
}

// 主题订阅要先于 ready：宿主是在收到握手之后才补发主题事件的，
// 先把监听挂上才不会漏掉第一帧。
followHostTheme();
void bootPage();
