/**
 * AI 网页翻译 - 内容脚本
 * 职责：划词翻译 + 整页翻译（含省 token 的正文提取、语言跳过、缓存复用）。
 * 注意：本脚本不持有、不读取、不传输任何 API Key，只与后台交换纯文本。
 */
(() => {
  if (window.__aiTranslateInjected) return;
  window.__aiTranslateInjected = true;

  let enabled = true;
  let fabEl = null;
  let panelEl = null;
  let barEl = null;

  const sendMsg = (msg) =>
    new Promise((resolve) => {
      chrome.runtime.sendMessage(msg, (resp) => {
        void chrome.runtime.lastError;
        resolve(resp || {});
      });
    });

  /* ================= 状态刷新 ================= */

  function refreshStatus() {
    chrome.runtime.sendMessage({ type: "getConfigStatus" }, (resp) => {
      if (chrome.runtime.lastError) return;
      enabled = !!(resp && resp.enabled && resp.configured);
    });
  }
  refreshStatus();

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === "configUpdated") refreshStatus();
    if (msg?.type === "translateSelection") translateSelection();
    if (msg?.type === "translatePage") translatePage();
    if (msg?.type === "restorePage") restorePage();
    if (msg?.type === "togglePage") togglePage();
  });

  const getCfg = () =>
    new Promise((resolve) => {
      chrome.storage.local.get("config", (r) => resolve(r?.config || {}));
    });

  /* ================= 划词翻译 ================= */

  document.addEventListener("mouseup", (e) => {
    if (fabEl?.contains(e.target) || panelEl?.contains(e.target) || barEl?.contains(e.target)) return;

    const sel = window.getSelection();
    const text = sel ? sel.toString().trim() : "";

    if (!enabled || text.length < 2 || text.length > 5000) {
      hideFab();
      return;
    }
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
      hideFab();
      return;
    }

    const rect = sel.getRangeAt(0).getBoundingClientRect();
    if (!rect || (rect.width === 0 && rect.height === 0)) return;

    showFab(rect.right + window.scrollX + 6, rect.top + window.scrollY - 34, text);
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      hideFab();
      hidePanel();
    }
  });

  function translateSelection() {
    const sel = window.getSelection();
    const text = sel ? sel.toString().trim() : "";
    if (!text) return;
    const rect = sel.getRangeAt(0).getBoundingClientRect();
    showPanel(rect.right + window.scrollX, rect.bottom + window.scrollY, text);
    doTranslate(text);
  }

  function showFab(x, y, text) {
    hideFab();
    fabEl = document.createElement("div");
    fabEl.className = "aitx-fab";
    fabEl.textContent = "译";
    fabEl.title = "点击翻译";
    fabEl.style.left = `${Math.min(x, window.scrollX + document.documentElement.clientWidth - 44)}px`;
    fabEl.style.top = `${Math.max(y, window.scrollY + 4)}px`;

    fabEl.addEventListener("mousedown", (e) => e.stopPropagation());
    fabEl.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      hideFab();
      showPanel(x, y + 34, text);
      doTranslate(text);
    });
    document.documentElement.appendChild(fabEl);
  }

  function hideFab() {
    fabEl?.remove();
    fabEl = null;
  }

  function showPanel(x, y, sourceText) {
    hidePanel();
    panelEl = document.createElement("div");
    panelEl.className = "aitx-panel";
    panelEl.innerHTML = `
      <div class="aitx-head">
        <span class="aitx-title">AI 翻译</span>
        <span class="aitx-head-btns">
          <button class="aitx-btn aitx-copy" title="复制译文">复制</button>
          <button class="aitx-btn aitx-close" title="关闭">✕</button>
        </span>
      </div>
      <div class="aitx-src"></div>
      <div class="aitx-body">
        <div class="aitx-loading"><span></span><span></span><span></span> 翻译中…</div>
      </div>
    `;
    panelEl.querySelector(".aitx-src").textContent = truncate(sourceText, 160);

    const vw = document.documentElement.clientWidth;
    const left = Math.max(window.scrollX + 8, Math.min(x - 280, window.scrollX + vw - 328));
    panelEl.style.left = `${left}px`;
    panelEl.style.top = `${y}px`;

    panelEl.querySelector(".aitx-close").addEventListener("click", hidePanel);
    panelEl.querySelector(".aitx-copy").addEventListener("click", (e) => {
      const body = panelEl.querySelector(".aitx-body");
      const text = body.dataset.result || "";
      navigator.clipboard.writeText(text).then(() => {
        e.target.textContent = "已复制";
        setTimeout(() => (e.target.textContent = "复制"), 1200);
      });
    });
    panelEl.addEventListener("mousedown", (e) => e.stopPropagation());
    document.documentElement.appendChild(panelEl);
  }

  function hidePanel() {
    panelEl?.remove();
    panelEl = null;
  }

  function truncate(s, n) {
    return s.length > n ? s.slice(0, n) + "…" : s;
  }

  function doTranslate(text) {
    chrome.runtime.sendMessage({ type: "translate", text }, (resp) => {
      if (!panelEl) return;
      const body = panelEl.querySelector(".aitx-body");
      if (chrome.runtime.lastError) {
        body.className = "aitx-err";
        body.textContent = "扩展通信失败，请刷新页面重试";
        return;
      }
      if (resp?.ok) {
        body.className = "aitx-body";
        body.dataset.result = resp.result;
        body.textContent = resp.result;
      } else {
        body.className = "aitx-err";
        body.textContent = resp?.error || "翻译失败，请稍后重试";
      }
    });
  }

  /* ================= 整页翻译 ================= */

  const SKIP_TAGS = new Set([
    "SCRIPT", "STYLE", "NOSCRIPT", "CODE", "PRE", "TEXTAREA",
    "SVG", "CANVAS", "IFRAME", "MATH", "KBD", "SAMP", "OPTION",
  ]);

  // 非正文区域：导航、页脚、侧栏、菜单等（整页翻译时默认跳过，最省 token）
  const NOISE_SELECTOR = [
    "nav", "footer", "aside", "[role=navigation]", "[role=banner]",
    "[role=contentinfo]", "[role=complementary]", "[role=menu]", "[role=menubar]",
    "[aria-label*=nav i]", "[aria-label*=menu i]", "[aria-label*=breadcrumb i]",
    "[class*=nav-]", "[class*=navbar]", "[class*=footer]", "[class*=sidebar]",
    "[class*=breadcrumb]", "[class*=pagination]", "[class*=cookie]", "[class*=banner]",
    "[id*=nav]", "[id*=footer]", "[id*=sidebar]", "[id*=breadcrumb]", "[id*=cookie]",
  ].join(",");

  const MAX_CHARS = 1800;   // 单批字符上限（越大 → 请求越少、系统提示开销越低）
  const MAX_ITEMS = 40;     // 单批条目上限
  const CONCURRENCY = 3;    // 并发请求数

  const RE = {
    han: /[㐀-䶿一-鿿豈-﫿]/,
    kana: /[぀-ヿ]/,
    hangul: /[가-힯]/,
    cyr: /[Ѐ-ӿ]/,
    latin: /[A-Za-z]/,
  };

  /** 文本是否已经是目标语言（是则无需翻译，直接省掉 token） */
  function alreadyTarget(t, lang) {
    const han = RE.han.test(t);
    const kana = RE.kana.test(t);
    const hangul = RE.hangul.test(t);
    const cyr = RE.cyr.test(t);
    const latin = RE.latin.test(t);
    switch (lang) {
      case "zh":
      case "zht":
        return han && !latin && !kana && !hangul && !cyr;
      case "en":
        return latin && !han && !kana && !hangul && !cyr;
      case "ja":
        return (kana || han) && !latin && !hangul && !cyr;
      case "ko":
        return hangul && !latin && !han && !kana && !cyr;
      case "ru":
        return cyr && !latin && !han && !kana && !hangul;
      default:
        return false;
    }
  }

  const page = {
    running: false,
    stopped: false,
    items: [],
    translated: 0,
    total: 0,
    errors: 0,
    chars: 0,
    reqs: 0,
    cached: 0,
    skipped: 0,
    showing: "trans",
    cache: new Map(),
  };

  function isVisible(el) {
    if (!el) return false;
    const st = getComputedStyle(el);
    if (st.display === "none" || st.visibility === "hidden" || st.opacity === "0") return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  /** 收集可翻译文本节点；scope=smart 时跳过导航/页脚等非正文 */
  function collectNodes(scope, targetLang) {
    const out = [];
    let skipped = 0;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const t = node.nodeValue || "";
        if (t.trim().length < 2) return NodeFilter.FILTER_REJECT;
        const p = node.parentElement;
        if (!p) return NodeFilter.FILTER_REJECT;
        if (SKIP_TAGS.has(p.tagName)) return NodeFilter.FILTER_REJECT;
        if (p.closest('[translate="no"], .notranslate, .aitx-fab, .aitx-panel, .aitx-bar')) {
          return NodeFilter.FILTER_REJECT;
        }
        if (scope === "smart") {
          try {
            if (p.closest(NOISE_SELECTOR)) return NodeFilter.FILTER_REJECT;
          } catch (_) {}
        }
        if (!isVisible(p)) return NodeFilter.FILTER_REJECT;
        if (!/[A-Za-zÀ-ɏͰ-ϿЀ-ӿ一-鿿぀-ヿ가-힯]/.test(t)) return NodeFilter.FILTER_REJECT;
        if (alreadyTarget(t, targetLang)) {
          skipped += 1;
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    let n;
    while ((n = walker.nextNode())) out.push({ node: n, orig: n.nodeValue });
    page.skipped = skipped;
    return out;
  }

  function makeBatches(items) {
    const batches = [];
    let cur = [];
    let len = 0;
    for (const it of items) {
      const t = it.orig.trim();
      if (cur.length >= MAX_ITEMS || len + t.length > MAX_CHARS) {
        batches.push(cur);
        cur = [];
        len = 0;
      }
      cur.push({ ...it, text: t });
      len += t.length;
    }
    if (cur.length) batches.push(cur);
    return batches;
  }

  async function translatePage() {
    if (page.running) return;

    const cfg = await getCfg();
    if (!enabled) {
      const st = await sendMsg({ type: "getConfigStatus" });
      if (!st.configured || !st.enabled) {
        renderBar(0, 0);
        setBarStatus("请先完成配置并启用翻译", true);
        return;
      }
    }
    const scope = cfg.pageScope || "smart";
    const targetLang = cfg.targetLang || "zh";

    const items = collectNodes(scope, targetLang);
    if (!items.length) {
      renderBar(0, 0);
      setBarStatus(
        page.skipped ? `无需翻译：${page.skipped} 段已是${targetLabel(targetLang)}` : "本页没有可翻译的文本",
        true
      );
      setTimeout(closeBar, 2500);
      return;
    }

    const chars = items.reduce((s, it) => s + it.orig.trim().length, 0);
    Object.assign(page, {
      running: true,
      stopped: false,
      items,
      translated: 0,
      errors: 0,
      chars: 0,
      reqs: 0,
      cached: 0,
      showing: "trans",
    });

    renderBar(0, items.length);
    setBarStatus(
      `共 ${items.length} 段 / ${chars} 字${page.skipped ? `（已跳过 ${page.skipped} 段无需翻译）` : ""}`
    );

    const queue = makeBatches(items);

    const worker = async () => {
      while (queue.length && !page.stopped) {
        const b = queue.shift();
        const texts = b.map((i) => i.text);

        let results = null;
        const local = texts.map((t) => page.cache.get(t));
        if (local.every((v) => typeof v === "string")) {
          results = local;
        } else {
          const resp = await sendMsg({ type: "translateBatch", items: texts });
          if (!resp.ok) {
            page.errors += 1;
            if (resp.locked || /尚未配置/.test(resp.error || "")) {
              page.stopped = true;
              setBarStatus(resp.error || "翻译中止", true);
              break;
            }
            continue;
          }
          results = resp.results;
          page.reqs += resp.requests || 1;
          page.cached += resp.cached || 0;
        }

        applyBatch(b, results);
        page.translated += b.length;
        page.chars += texts.reduce((s, t) => s + t.length, 0);
        updateBar();
      }
    };

    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));

    page.running = false;
    if (!page.stopped) {
      setBarStatus(
        `完成 ${page.translated}/${items.length} 段 · ${page.chars} 字 · ${page.reqs} 次请求` +
          (page.cached ? ` · ${page.cached} 段命中缓存` : "") +
          (page.errors ? ` · ${page.errors} 批失败` : "")
      );
    }
    finishBar();
  }

  function targetLabel(lang) {
    return { zh: "中文", zht: "中文", en: "英文", ja: "日文", ko: "韩文", ru: "俄文" }[lang] || "目标语言";
  }

  function applyBatch(batch, results) {
    batch.forEach((it, i) => {
      const t = typeof results[i] === "string" && results[i].trim() ? results[i] : it.text;
      page.cache.set(it.text, t);
      const rec = page.items.find((x) => x.node === it.node);
      if (rec) rec.trans = t;
      if (page.showing === "trans") it.node.nodeValue = t;
    });
  }

  function togglePage() {
    if (!page.items.length) return;
    page.showing = page.showing === "trans" ? "orig" : "trans";
    for (const it of page.items) {
      it.node.nodeValue = page.showing === "trans" ? it.trans || it.orig : it.orig;
    }
    const btn = barEl?.querySelector(".aitx-toggle");
    if (btn) btn.textContent = page.showing === "trans" ? "显示原文" : "显示译文";
  }

  function restorePage() {
    for (const it of page.items) {
      if (it.node && it.node.parentNode) it.node.nodeValue = it.orig;
    }
    Object.assign(page, { running: false, stopped: true, items: [], translated: 0, errors: 0 });
    closeBar();
  }

  /* ---- 底部控制条 ---- */

  function renderBar(done, total) {
    closeBar();
    barEl = document.createElement("div");
    barEl.className = "aitx-bar";
    barEl.innerHTML = `
      <div class="aitx-bar-head">
        <span class="aitx-bar-title">AI 整页翻译</span>
        <button class="aitx-x" title="关闭">✕</button>
      </div>
      <div class="aitx-progress"><i></i></div>
      <div class="aitx-bar-status">准备中…</div>
      <div class="aitx-bar-btns">
        <button class="aitx-b aitx-toggle">显示原文</button>
        <button class="aitx-b aitx-restore">恢复原文</button>
      </div>
    `;
    barEl.querySelector(".aitx-x").addEventListener("click", stopAndClose);
    barEl.querySelector(".aitx-toggle").addEventListener("click", togglePage);
    barEl.querySelector(".aitx-restore").addEventListener("click", restorePage);
    document.documentElement.appendChild(barEl);
    page.translated = done;
    page.total = total;
    updateBar();
  }

  function updateBar() {
    if (!barEl) return;
    const total = page.total || page.items.length || 1;
    const pct = Math.min(100, Math.round((page.translated / total) * 100));
    barEl.querySelector(".aitx-progress i").style.width = `${pct}%`;
    if (!page.stopped) {
      setBarStatus(
        `已翻译 ${page.translated}/${total} 段 · ${page.reqs} 次请求` +
          (page.cached ? ` · 缓存 ${page.cached}` : "")
      );
    }
  }

  function setBarStatus(text, isErr) {
    if (!barEl) return;
    const el = barEl.querySelector(".aitx-bar-status");
    el.textContent = text;
    el.className = "aitx-bar-status" + (isErr ? " err" : "");
  }

  function finishBar() {
    if (barEl) barEl.classList.add("done");
  }

  function stopAndClose() {
    page.stopped = true;
    closeBar();
  }

  function closeBar() {
    barEl?.remove();
    barEl = null;
  }
})();
