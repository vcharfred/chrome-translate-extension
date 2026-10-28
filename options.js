/* AI 网页翻译 - 设置页逻辑 */

const MODELS = {
  deepseek: ["deepseek-chat", "deepseek-reasoner"],
  aliyun: ["qwen-plus", "qwen-turbo", "qwen-max", "qwen-flash"],
  hunyuan: ["hunyuan-turbos-latest", "hunyuan-lite", "hunyuan-t1-latest"],
};

const $ = (id) => document.getElementById(id);

function send(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (resp) => {
      void chrome.runtime.lastError;
      resolve(resp || {});
    });
  });
}

function currentProvider() {
  return document.querySelector('input[name="provider"]:checked')?.value || "deepseek";
}

function refreshModelHints() {
  const p = currentProvider();
  const list = $("modelList");
  list.innerHTML = "";
  for (const m of MODELS[p]) {
    const opt = document.createElement("option");
    opt.value = m;
    list.appendChild(opt);
  }
  if (!$("model").value.trim()) $("model").placeholder = MODELS[p][0];
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function toast(text) {
  const tip = $("saveTip");
  tip.textContent = text;
  tip.classList.add("show");
  setTimeout(() => tip.classList.remove("show"), 2000);
}

function encMsg(text, kind) {
  const el = $("encMsg");
  el.textContent = text;
  el.className = "msg " + (kind || "");
  if (text) setTimeout(() => { el.textContent = ""; el.className = "msg"; }, 3000);
}

/* ---------------- 状态渲染 ---------------- */

let state = { encrypted: false, locked: false };

function renderEncSection() {
  $("encOff").hidden = state.encrypted;
  $("encLocked").hidden = !(state.encrypted && state.locked);
  $("encUnlocked").hidden = !(state.encrypted && !state.locked);
  $("lockBanner").hidden = !(state.encrypted && state.locked);
  $("rememberKey").disabled = state.encrypted;

  if (state.encrypted && state.locked) {
    $("apiKey").disabled = true;
    $("apiKey").placeholder = "🔒 已锁定，解锁后可修改";
    $("keyHint").textContent = "密钥以密文保存，当前处于锁定状态。";
  } else {
    $("apiKey").disabled = false;
    $("apiKey").placeholder = "sk-...";
    $("keyHint").textContent = state.encrypted
      ? "密钥以密文保存（已解锁）。"
      : "";
  }
}

async function refreshStatus() {
  const resp = await send({ type: "getConfigStatus" });
  state.encrypted = !!resp.encrypted;
  state.locked = !!resp.locked;
  $("cacheCount").textContent = resp.cacheCount || 0;
  $("cacheSize").textContent = formatBytes(resp.cacheBytes || 0);
  $("cacheEnabled").checked = resp.cacheEnabled !== false;
  renderEncSection();
  return resp;
}

async function load() {
  const { config = {} } = await chrome.storage.local.get("config");
  if (config.provider) {
    const radio = document.querySelector(`input[name="provider"][value="${config.provider}"]`);
    if (radio) radio.checked = true;
  }
  if (config.apiKey) {
    $("apiKey").value = config.apiKey;
    $("rememberKey").checked = true;
  } else {
    try {
      const { sessionKey } = await chrome.storage.session.get("sessionKey");
      if (sessionKey) {
        $("apiKey").value = sessionKey;
        if (!config.enc) $("rememberKey").checked = false;
      }
    } catch (_) {}
  }
  if (config.model) $("model").value = config.model;
  $("targetLang").value = config.targetLang || "zh";
  $("pageScope").value = config.pageScope || "smart";
  $("pageModel").value = config.pageModel || "";
  $("cacheEnabled").checked = config.cacheEnabled !== false;
  $("enabled").checked = config.enabled !== false;
  $("enableEnc").checked = false;
  refreshModelHints();
  await refreshStatus();
}

/* ---------------- 保存 ---------------- */

async function saveSettings() {
  await send({
    type: "saveSettings",
    provider: currentProvider(),
    model: $("model").value.trim(),
    targetLang: $("targetLang").value,
    enabled: $("enabled").checked,
    pageScope: $("pageScope").value,
    pageModel: $("pageModel").value.trim(),
    cacheEnabled: $("cacheEnabled").checked,
  });
}

async function save() {
  const key = $("apiKey").value.trim();
  const wantEnc = $("enableEnc").checked && !state.encrypted;

  await saveSettings();

  if (wantEnc) {
    const p1 = $("newPass1").value;
    const p2 = $("newPass2").value;
    if (p1.length < 6) {
      encMsg("✘ 口令至少 6 位", "err");
      return;
    }
    if (p1 !== p2) {
      encMsg("✘ 两次输入的口令不一致", "err");
      return;
    }
    const r = await send({ type: "enableEncryption", apiKey: key, passphrase: p1 });
    if (!r.ok) {
      encMsg("✘ " + (r.error || "启用失败"), "err");
      return;
    }
    $("newPass1").value = "";
    $("newPass2").value = "";
    await refreshStatus();
    toast("已启用主口令加密 ✔");
    return;
  }

  if (key) {
    await send({ type: "saveKey", apiKey: key, remember: $("rememberKey").checked });
  }
  await refreshStatus();
  toast("已保存 ✔");
}

/* ---------------- 口令操作 ---------------- */

async function unlock() {
  const pass = $("unlockPass").value;
  if (!pass) return;
  const r = await send({ type: "unlock", passphrase: pass });
  if (r.ok) {
    $("unlockPass").value = "";
    await refreshStatus();
    encMsg("✔ 已解锁", "ok");
  } else {
    encMsg(r.error || "解锁失败", "err");
  }
}

async function changePassphrase() {
  const p = $("changePass").value;
  if (p.length < 6) {
    encMsg("✘ 新口令至少 6 位", "err");
    return;
  }
  const r = await send({ type: "changePassphrase", passphrase: p });
  if (r.ok) {
    $("changePass").value = "";
    encMsg("✔ 口令已更新", "ok");
  } else {
    encMsg("✘ " + (r.error || "修改失败"), "err");
  }
}

async function forgetPassphrase() {
  if (!confirm("确认重置？\n\n已加密的 API Key 将被永久删除，且无法找回。\n之后需要重新填写 API Key 并设置新口令。")) return;
  if (!confirm("再次确认：此操作不可撤销，确定继续吗？")) return;
  await send({ type: "forgetPassphrase" });
  $("apiKey").value = "";
  await refreshStatus();
  encMsg("已重置，请重新填写 API Key", "warn");
}

async function lockNow() {
  await send({ type: "lock" });
  await refreshStatus();
  encMsg("已锁定", "warn");
}

async function disableEnc() {
  if (!confirm("关闭加密后，API Key 将以明文保存在本机（关闭浏览器后仍保留）。确定继续吗？")) return;
  const r = await send({ type: "disableEncryption", remember: true });
  if (r.ok) {
    await refreshStatus();
    encMsg("已关闭加密", "warn");
  } else {
    encMsg("✘ " + (r.error || "操作失败"), "err");
  }
}

/* ---------------- 测试连接 ---------------- */

async function test() {
  const btn = $("test");
  const out = $("testResult");
  btn.disabled = true;
  out.className = "";
  out.textContent = "测试中…";

  await save();

  const r = await send({ type: "translate", text: "Hello, world! This is a connection test." });
  btn.disabled = false;
  if (r?.ok) {
    out.className = "ok";
    out.textContent = `✔ 连接成功：${r.result.slice(0, 60)}`;
  } else {
    out.className = "err";
    out.textContent = `✘ ${r?.error || "测试失败"}`;
  }
}

/* ---------------- 事件绑定 ---------------- */

document.querySelectorAll('input[name="provider"]').forEach((r) =>
  r.addEventListener("change", refreshModelHints)
);
$("enableEnc").addEventListener("change", (e) => {
  $("encSetup").hidden = !e.target.checked;
});
$("toggleKey").addEventListener("click", () => {
  const inp = $("apiKey");
  inp.type = inp.type === "password" ? "text" : "password";
});
$("save").addEventListener("click", save);
$("test").addEventListener("click", test);
$("btnUnlock").addEventListener("click", unlock);
$("unlockPass").addEventListener("keydown", (e) => {
  if (e.key === "Enter") unlock();
});
$("btnChangePass").addEventListener("click", changePassphrase);
$("btnForget").addEventListener("click", forgetPassphrase);
$("btnLock").addEventListener("click", lockNow);
$("btnDisableEnc").addEventListener("click", disableEnc);
$("btnClearCache").addEventListener("click", async () => {
  if (!confirm("清空全部翻译缓存？之后重复内容需要重新翻译。")) return;
  await send({ type: "clearCache" });
  await refreshStatus();
  toast("缓存已清空 ✔");
});

load();
