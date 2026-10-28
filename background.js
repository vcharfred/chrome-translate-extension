/**
 * AI 网页翻译 - 后台 Service Worker
 *
 * 安全设计：
 * 1. API Key 只保存在扩展私有存储中（chrome.storage.local 密文 / chrome.storage.session 内存），
 *    该存储按扩展隔离，网页、其他扩展均无法读取；
 * 2. 所有对大模型 API 的请求都在这里发起，Key 永不发送给内容脚本或页面；
 * 3. 启用主口令后，Key 以 AES-256-GCM 密文落盘，口令不保存，忘记只能重置；
 * 4. host_permissions 仅声明三家 API 域名。
 */

importScripts("crypto.js");

/**
 * 固化 session 存储的访问级别为 TRUSTED_CONTEXTS：
 * 只有扩展自己的可信上下文（Service Worker / 扩展页面）能读，
 * 内容脚本（与网页共用渲染进程，属不可信上下文）读取会被拒绝。
 * 这是默认值，此处显式声明以防未来默认行为变化。
 */
try {
  chrome.storage.session.setAccessLevel?.({ accessLevel: "TRUSTED_CONTEXTS" }).catch(() => {});
} catch (_) {}

const PROVIDERS = {
  deepseek: {
    name: "DeepSeek",
    url: "https://api.deepseek.com/chat/completions",
    defaultModel: "deepseek-chat",
  },
  aliyun: {
    name: "阿里云百炼（通义千问）",
    url: "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
    defaultModel: "qwen-plus",
  },
  hunyuan: {
    name: "腾讯混元",
    url: "https://api.hunyuan.cloud.tencent.com/v1/chat/completions",
    defaultModel: "hunyuan-turbos-latest",
  },
};

const LANGS = {
  zh: "简体中文",
  zht: "繁體中文",
  en: "英语",
  ja: "日语",
  ko: "韩语",
  fr: "法语",
  de: "德语",
  ru: "俄语",
  es: "西班牙语",
};

/* ---------------- 状态读取 ---------------- */

async function getSessionKey() {
  try {
    const { sessionKey } = await chrome.storage.session.get("sessionKey");
    return sessionKey || null;
  } catch (_) {
    return null;
  }
}

/**
 * 返回 { config, apiKey, locked, encrypted }
 * 优先级：会话内存(已解锁/会话模式) > 明文存储 > 密文存储(锁定)
 */
async function getState() {
  const { config = {} } = await chrome.storage.local.get("config");
  let apiKey = await getSessionKey();
  if (!apiKey && config.apiKey) apiKey = config.apiKey;
  const encrypted = !!config.enc;
  const locked = !apiKey && encrypted;
  return { config, apiKey, locked, encrypted };
}

async function saveConfig(config) {
  await chrome.storage.local.set({ config });
}

async function setSessionKey(key) {
  try {
    if (key) await chrome.storage.session.set({ sessionKey: key });
    else await chrome.storage.session.remove("sessionKey");
  } catch (_) {}
}

/* ---------------- 翻译结果缓存（跨页面 / 跨会话复用，省 token） ---------------- */

const CACHE_MAX = 4000;                        // 条目上限
const CACHE_MAX_BYTES = 4 * 1024 * 1024;       // 字节上限 4MB（chrome.storage.local 硬配额为 10MB，留出余量）
const encoder = new TextEncoder();

function entryBytes(k, v) {
  return k.length * 2 + encoder.encode(v).length;
}

function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

async function getCache() {
  const { tcache = {} } = await chrome.storage.local.get("tcache");
  return tcache;
}

async function putCache(entries) {
  if (!entries.length) return;
  const c = await getCache();
  for (const [k, v] of entries) c[k] = v;

  // 按插入顺序淘汰最旧的：先卡条目数，再卡字节数
  const keys = Object.keys(c);
  let bytes = 0;
  for (const k of keys) bytes += entryBytes(k, c[k]);
  let i = 0;
  while (i < keys.length && (keys.length - i > CACHE_MAX || bytes > CACHE_MAX_BYTES)) {
    bytes -= entryBytes(keys[i], c[keys[i]]);
    delete c[keys[i]];
    i += 1;
  }

  try {
    await chrome.storage.local.set({ tcache: c });
  } catch (_) {
    // 仍超出配额时砍掉一半最旧的再写一次
    const rest = Object.keys(c);
    for (const k of rest.slice(0, Math.ceil(rest.length / 2))) delete c[k];
    try {
      await chrome.storage.local.set({ tcache: c });
    } catch (_) {}
  }
}

async function cacheStats() {
  const c = await getCache();
  const keys = Object.keys(c);
  let bytes = 0;
  for (const k of keys) bytes += entryBytes(k, c[k]);
  return { count: keys.length, bytes };
}

/* ---------------- 翻译调用 ---------------- */

function buildPrompt(text, targetLang) {
  const lang = LANGS[targetLang] || "简体中文";
  return {
    system:
      "你是一个专业的翻译引擎。将用户提供的文本准确、流畅地翻译为" +
      lang +
      "。只输出译文本身，不要解释、不要加引号、不要输出任何额外内容。" +
      "保留原文的换行与段落结构；专有名词、代码、网址保持原样；" +
      "若文本本身已是目标语言，则将其翻译为另一种更自然的表述并输出。",
    user: text,
    lang,
  };
}

/** 统一的 chat 接口请求 */
async function requestChat(p, apiKey, model, system, user, temperature, maxTokens) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60000);

  const body = {
    model: model || p.defaultModel,
    temperature: temperature === undefined ? 0.3 : temperature,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  };
  if (maxTokens) body.max_tokens = maxTokens;

  let resp;
  try {
    resp = await fetch(p.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    if (e.name === "AbortError") throw new Error("请求超时，请稍后重试");
    throw new Error("网络请求失败，请检查网络连接");
  }
  clearTimeout(timer);

  if (!resp.ok) {
    let detail = "";
    try {
      const err = await resp.json();
      detail = err?.error?.message || err?.message || "";
    } catch (_) {}
    const map = {
      401: "API Key 无效或未授权，请到设置页检查",
      403: "无权限访问该模型，请检查账号权限或 Key 是否有此模型授权",
      404: "接口或模型不存在，请检查模型名称",
      429: "请求频率或额度超限，请稍后重试",
      500: "服务商服务器错误，请稍后重试",
    };
    throw new Error(map[resp.status] || `请求失败 (HTTP ${resp.status}) ${detail}`.trim());
  }

  const data = await resp.json();
  const out = data?.choices?.[0]?.message?.content?.trim();
  if (!out) throw new Error("模型未返回内容，请重试");
  return out;
}

async function callLLM(provider, apiKey, model, text, targetLang) {
  const p = PROVIDERS[provider];
  if (!p) throw new Error("未知的服务商");
  const { system, user } = buildPrompt(text, targetLang);
  return requestChat(p, apiKey, model, system, user);
}

/** 批量翻译：输入 JSON 数组，输出等长 JSON 数组；失败自动重试一次 */
async function callLLMBatch(provider, apiKey, model, items, targetLang) {
  const p = PROVIDERS[provider];
  if (!p) throw new Error("未知的服务商");
  const lang = LANGS[targetLang] || "简体中文";
  const system =
    "你是专业翻译引擎。输入是一个 JSON 数组，每个元素是一段网页文本。" +
    "请逐项翻译为" + lang + "，并严格返回一个 JSON 数组：长度与输入完全相同、只包含译文字符串。" +
    "不要输出解释、不要 markdown 代码块、不要额外字段、不要改变数组顺序和长度。" +
    "保留原文的换行；代码、网址、邮箱、数字、专有名词保持原样；" +
    "若某段已是目标语言则原样返回。";
  const user = JSON.stringify(items);

  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      let content;
      try {
        content = await requestChat(p, apiKey, model, system, user, attempt === 0 ? 0.3 : 0, 4096);
      } catch (e) {
        // 部分服务商不接受较大的 max_tokens，去掉后重试
        if (/max_tokens/i.test(e.message || "")) {
          content = await requestChat(p, apiKey, model, system, user, attempt === 0 ? 0.3 : 0);
        } else {
          throw e;
        }
      }
      const arr = parseJsonArray(content);
      if (!Array.isArray(arr)) throw new Error("返回结果不是数组");
      if (arr.length !== items.length) {
        throw new Error(`返回条目数不匹配（${arr.length} / ${items.length}）`);
      }
      return arr.map((x) => (typeof x === "string" ? x : String(x ?? "")));
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(lastErr?.message || "批量翻译失败");
}

/** 从模型输出中稳健提取 JSON 数组（容忍代码块包裹、前后废话） */
function parseJsonArray(raw) {
  let t = String(raw || "").trim();
  t = t.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const start = t.indexOf("[");
  const end = t.lastIndexOf("]");
  if (start >= 0 && end > start) t = t.slice(start, end + 1);
  return JSON.parse(t);
}

/* ---------------- 消息入口 ---------------- */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const type = msg?.type;

  if (type === "getConfigStatus") {
    (async () => {
      const s = await getState();
      sendResponse({
        configured: !!s.apiKey || s.locked,
        enabled: s.config.enabled !== false,
        provider: s.config.provider || "deepseek",
        providerName: (PROVIDERS[s.config.provider || "deepseek"] || {}).name || "",
        targetLang: s.config.targetLang || "zh",
        model: s.config.model || "",
        encrypted: s.encrypted,
        locked: s.locked,
        rememberKey: s.config.rememberKey !== false,
        pageScope: s.config.pageScope || "smart",
        pageModel: s.config.pageModel || "",
        cacheEnabled: s.config.cacheEnabled !== false,
        cacheCount: (await cacheStats()).count,
        cacheBytes: (await cacheStats()).bytes,
      });
    })();
    return true;
  }

  if (type === "configUpdated") {
    chrome.tabs.query({}, (tabs) => {
      for (const t of tabs) {
        if (t.id != null) {
          chrome.tabs.sendMessage(t.id, { type: "configUpdated" }).catch(() => {});
        }
      }
    });
    sendResponse({ ok: true });
    return false;
  }

  if (type === "translate") {
    (async () => {
      try {
        const s = await getState();
        if (s.locked) {
          sendResponse({
            ok: false,
            locked: true,
            error: "🔒 已锁定，请打开设置页输入主口令解锁",
          });
          return;
        }
        if (!s.apiKey) {
          sendResponse({ ok: false, error: "尚未配置 API Key，请点击工具栏图标进入设置" });
          return;
        }
        const text = String(msg.text || "").slice(0, 5000);
        if (!text.trim()) {
          sendResponse({ ok: false, error: "没有需要翻译的文本" });
          return;
        }
        const result = await callLLM(
          msg.provider || s.config.provider || "deepseek",
          s.apiKey,
          msg.model || s.config.model,
          text,
          msg.targetLang || s.config.targetLang || "zh"
        );
        sendResponse({ ok: true, result });
      } catch (e) {
        sendResponse({ ok: false, error: e.message || "翻译失败" });
      }
    })();
    return true;
  }

  // 整页翻译：批量翻译一组文本
  if (type === "translateBatch") {
    (async () => {
      try {
        const s = await getState();
        if (s.locked) {
          sendResponse({ ok: false, locked: true, error: "🔒 已锁定，请打开设置页输入主口令解锁" });
          return;
        }
        if (!s.apiKey) {
          sendResponse({ ok: false, error: "尚未配置 API Key，请点击工具栏图标进入设置" });
          return;
        }
        const items = Array.isArray(msg.items) ? msg.items : [];
        if (!items.length) {
          sendResponse({ ok: false, error: "没有待翻译内容" });
          return;
        }

        const target = s.config.targetLang || "zh";
        const prov = PROVIDERS[s.config.provider || "deepseek"] || {};
        // 缓存键包含实际模型，换模型后旧缓存自动失效，避免低价模型的结果被沿用
        const model = s.config.pageModel || s.config.model || prov.defaultModel || "";
        const prefix = `${target}|${model}|`;
        const useCache = s.config.cacheEnabled !== false;

        const cache = useCache ? await getCache() : {};
        const keys = items.map((t) => hashStr(prefix + t));
        const results = keys.map((k) => (typeof cache[k] === "string" && cache[k] ? cache[k] : null));

        const missing = [];
        results.forEach((r, i) => {
          if (r === null) missing.push(i);
        });
        const cached = items.length - missing.length;
        let requests = 0;

        if (missing.length) {
          const sub = missing.map((i) => items[i]);
          const out = await callLLMBatch(
            s.config.provider || "deepseek",
            s.apiKey,
            s.config.pageModel || s.config.model, // 整页翻译可单独指定低价模型
            sub,
            target
          );
          requests = 1;
          const toSave = [];
          missing.forEach((idx, j) => {
            const v = typeof out[j] === "string" && out[j].trim() ? out[j] : items[idx];
            results[idx] = v;
            toSave.push([keys[idx], v]);
          });
          if (useCache) await putCache(toSave);
        }

        sendResponse({ ok: true, results, cached, requests });
      } catch (e) {
        sendResponse({ ok: false, error: e.message || "批量翻译失败" });
      }
    })();
    return true;
  }

  /* ---- 密钥与口令管理 ---- */

  // 保存基础设置（服务商 / 模型 / 语言 / 开关）
  if (type === "saveSettings") {
    (async () => {
      const s = await getState();
      const cfg = { ...s.config };
      if (msg.provider) cfg.provider = msg.provider;
      if (msg.model !== undefined) cfg.model = msg.model;
      if (msg.targetLang) cfg.targetLang = msg.targetLang;
      if (msg.pageScope) cfg.pageScope = msg.pageScope;
      if (msg.pageModel !== undefined) cfg.pageModel = msg.pageModel;
      if (msg.cacheEnabled !== undefined) cfg.cacheEnabled = msg.cacheEnabled;
      cfg.enabled = msg.enabled !== false;
      await saveConfig(cfg);
      broadcastUpdate();
      sendResponse({ ok: true });
    })();
    return true;
  }

  // 保存 API Key（未启用加密时）
  if (type === "saveKey") {
    (async () => {
      try {
        const s = await getState();
        const key = (msg.apiKey || "").trim();
        const cfg = { ...s.config };
        cfg.rememberKey = msg.remember !== false;
        if (key) {
          if (cfg.rememberKey) {
            cfg.apiKey = key;
            await setSessionKey(null);
          } else {
            delete cfg.apiKey;
            await setSessionKey(key);
          }
        }
        await saveConfig(cfg);
        broadcastUpdate();
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true;
  }

  // 启用主口令加密：用口令把当前 Key 加密后落盘
  if (type === "enableEncryption") {
    (async () => {
      try {
        const s = await getState();
        const key = (msg.apiKey || s.apiKey || "").trim();
        if (!key) {
          sendResponse({ ok: false, error: "请先填写 API Key" });
          return;
        }
        const enc = await encryptString(msg.passphrase, key);
        const cfg = { ...s.config, enc };
        delete cfg.apiKey;
        await saveConfig(cfg);
        await setSessionKey(key); // 解锁状态保持到浏览器关闭
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false, error: e.message || "加密失败" });
      }
    })();
    return true;
  }

  // 解锁：口令正确则把明文放进内存（session storage，不落盘）
  if (type === "unlock") {
    (async () => {
      try {
        const s = await getState();
        if (!s.config.enc) {
          sendResponse({ ok: false, error: "未启用主口令加密" });
          return;
        }
        const plain = await decryptString(msg.passphrase, s.config.enc);
        if (!plain) throw new Error("解密结果为空");
        await setSessionKey(plain);
        broadcastUpdate();
        sendResponse({ ok: true });
      } catch (_) {
        sendResponse({ ok: false, error: "✘ 口令错误" });
      }
    })();
    return true;
  }

  // 修改口令（需在已解锁状态）
  if (type === "changePassphrase") {
    (async () => {
      try {
        const s = await getState();
        if (!s.apiKey) {
          sendResponse({ ok: false, locked: true, error: "请先解锁" });
          return;
        }
        const enc = await encryptString(msg.passphrase, s.apiKey);
        const cfg = { ...s.config, enc };
        delete cfg.apiKey;
        await saveConfig(cfg);
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false, error: e.message || "修改失败" });
      }
    })();
    return true;
  }

  // 关闭加密：把明文按"记住"设置存回
  if (type === "disableEncryption") {
    (async () => {
      try {
        const s = await getState();
        const plain = s.apiKey;
        if (!plain) {
          sendResponse({ ok: false, locked: true, error: "请先解锁后再关闭加密" });
          return;
        }
        const cfg = { ...s.config };
        delete cfg.enc;
        if (msg.remember !== false) {
          cfg.apiKey = plain;
          await setSessionKey(null);
        } else {
          delete cfg.apiKey;
          await setSessionKey(plain);
        }
        await saveConfig(cfg);
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false, error: e.message || "操作失败" });
      }
    })();
    return true;
  }

  // 清空翻译缓存
  if (type === "clearCache") {
    (async () => {
      await chrome.storage.local.remove("tcache");
      sendResponse({ ok: true });
    })();
    return true;
  }

  // 锁定：清除内存中的明文
  if (type === "lock") {
    (async () => {
      await setSessionKey(null);
      broadcastUpdate();
      sendResponse({ ok: true });
    })();
    return true;
  }

  // 忘记口令：不可逆清除密文，需重新填写 API Key
  if (type === "forgetPassphrase") {
    (async () => {
      const { config = {} } = await chrome.storage.local.get("config");
      const cfg = { ...config };
      delete cfg.enc;
      delete cfg.apiKey;
      await saveConfig(cfg);
      await setSessionKey(null);
      broadcastUpdate();
      sendResponse({ ok: true });
    })();
    return true;
  }

  return false;
});

function broadcastUpdate() {
  chrome.tabs.query({}, (tabs) => {
    for (const t of tabs) {
      if (t.id != null) {
        chrome.tabs.sendMessage(t.id, { type: "configUpdated" }).catch(() => {});
      }
    }
  });
}

/* ---------------- 右键菜单 ---------------- */

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "ai-translate-selection",
    title: "翻译选中文本",
    contexts: ["selection"],
  });
  chrome.contextMenus.create({
    id: "ai-translate-page",
    title: "翻译整个网页",
    contexts: ["page"],
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (tab?.id == null) return;
  if (info.menuItemId === "ai-translate-selection") {
    chrome.tabs.sendMessage(tab.id, { type: "translateSelection" }).catch(() => {});
  } else if (info.menuItemId === "ai-translate-page") {
    chrome.tabs.sendMessage(tab.id, { type: "translatePage" }).catch(() => {});
  }
});
