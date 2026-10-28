/* AI 网页翻译 - 弹窗逻辑 */

const $ = (id) => document.getElementById(id);

function openOptions(e) {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
}
$("openOptions").addEventListener("click", openOptions);
$("openOptions2").addEventListener("click", openOptions);

/* ---- 整页翻译 ---- */

function withActiveTab(fn) {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs?.[0];
    if (!tab?.id) {
      $("pageTip").textContent = "未找到当前标签页";
      return;
    }
    if (!/^https?:/.test(tab.url || "")) {
      $("pageTip").textContent = "当前页面不支持翻译（仅限 http/https 网页）";
      return;
    }
    fn(tab.id);
  });
}

$("pageTranslate").addEventListener("click", () => {
  $("pageTip").textContent = "已开始整页翻译，请查看页面右下角进度条…";
  withActiveTab((id) => {
    chrome.tabs.sendMessage(id, { type: "translatePage" }, (r) => {
      if (chrome.runtime.lastError) {
        $("pageTip").textContent = "无法注入页面，请刷新该网页后重试";
      } else if (r === false) {
        $("pageTip").textContent = "页面未响应，请刷新后重试";
      }
      window.close();
    });
  });
});

$("pageRestore").addEventListener("click", () => {
  withActiveTab((id) => {
    chrome.tabs.sendMessage(id, { type: "restorePage" }, () => {
      void chrome.runtime.lastError;
      window.close();
    });
  });
});

// 状态检测
chrome.runtime.sendMessage({ type: "getConfigStatus" }, (resp) => {
  if (chrome.runtime.lastError || !resp) {
    $("statusText").innerHTML = '<span class="dot bad"></span>状态未知';
    return;
  }
  const el = $("statusText");
  if (!resp.configured) {
    el.innerHTML = '<span class="dot bad"></span>未配置 API Key，请先设置';
  } else if (resp.locked) {
    el.innerHTML = '<span class="dot bad"></span>🔒 已锁定，需输入主口令';
    $("go").disabled = true;
    $("result").className = "result error";
    $("result").textContent = "已锁定，点击下方「设置」输入主口令解锁";
  } else {
    el.innerHTML = `<span class="dot ok"></span>${resp.providerName} · 已就绪`;
  }
  $("enabledToggle").checked = !!resp.enabled;
});

// 划词开关
$("enabledToggle").addEventListener("change", async (e) => {
  const { config = {} } = await chrome.storage.local.get("config");
  config.enabled = e.target.checked;
  await chrome.storage.local.set({ config });
  chrome.runtime.sendMessage({ type: "configUpdated" }, () => void chrome.runtime.lastError);
});

// 快捷翻译
$("go").addEventListener("click", () => {
  const text = $("input").value.trim();
  if (!text) return;
  const btn = $("go");
  const out = $("result");
  btn.disabled = true;
  out.className = "result empty";
  out.textContent = "翻译中…";

  chrome.runtime.sendMessage({ type: "translate", text }, (resp) => {
    btn.disabled = false;
    if (resp?.ok) {
      out.className = "result";
      out.textContent = resp.result;
    } else {
      out.className = "result error";
      out.textContent = resp?.error || "翻译失败";
    }
  });
});
