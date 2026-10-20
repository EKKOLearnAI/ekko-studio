const scanButton = document.getElementById("scan");
const importButton = document.getElementById("import");
const statusEl = document.getElementById("status");
const domainsEl = document.getElementById("domains");
const toolbarEl = document.getElementById("toolbar");
const filterInput = document.getElementById("filterInput");
const selectAllBtn = document.getElementById("selectAll");
const selectNoneBtn = document.getElementById("selectNone");
const selectMoreBtn = document.getElementById("selectMore");

let domainEntries = [];
let allDomainEntries = []; // 保存原始完整列表
let filterText = "";

/* ── 工具函数 ── */

function domainKey(cookie) {
  return (cookie.domain || "").replace(/^\./, "").toLowerCase();
}

function setStatus(message, type = "") {
  statusEl.textContent = message;
  statusEl.className = "status " + type.trim();
}

function setBusy(busy) {
  scanButton.disabled = busy;
  importButton.disabled = busy || getSelectedDomains().length === 0;
}

function getSelectedDomains() {
  return Array.from(domainsEl.querySelectorAll(".domain input[type='checkbox']:checked"))
    .map((input) => input.value);
}

/* ── 渲染域名列表 ── */

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function highlightText(text, query) {
  if (!query) return escapeHtml(text);
  const escaped = escapeHtml(text);
  const regex = new RegExp("(" + query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + ")", "gi");
  return escaped.replace(regex, '<mark>$1</mark>');
}

function renderDomains(entries) {
  domainsEl.textContent = "";
  if (entries.length === 0) {
    const empty = document.createElement("p");
    empty.className = "domain";
    empty.textContent = "没有找到可导入的 Cookie。";
    domainsEl.append(empty);
    importButton.disabled = true;
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const entry of entries) {
    const label = document.createElement("label");
    label.className = "domain";
    label.dataset.domain = entry.domain;

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.value = entry.domain;
    checkbox.addEventListener("change", () => {
      label.classList.toggle("selected", checkbox.checked);
      importButton.disabled = getSelectedDomains().length === 0;
    });

    const name = document.createElement("span");
    name.className = "domain-name";
    name.innerHTML = highlightText(entry.domain, filterText);

    const count = document.createElement("span");
    count.className = "domain-count";
    count.textContent = entry.count;

    label.append(checkbox, name, count);
    fragment.append(label);
  }
  domainsEl.append(fragment);
  importButton.disabled = true;
}

/* ── 筛选 ── */

function applyFilter() {
  if (!filterText) {
    renderDomains(allDomainEntries);
    return;
  }
  const q = filterText.toLowerCase();
  const filtered = allDomainEntries.filter((e) => e.domain.toLowerCase().includes(q));
  renderDomains(filtered);
}

filterInput.addEventListener("input", () => {
  filterText = filterInput.value.trim();
  applyFilter();
});

/* ── 全选 / 取消全选 ── */

function toggleVisibleDomains(checked) {
  const checkboxes = domainsEl.querySelectorAll(".domain input[type='checkbox']");
  checkboxes.forEach((cb) => {
    cb.checked = checked;
    cb.closest(".domain").classList.toggle("selected", checked);
  });
  importButton.disabled = getSelectedDomains().length === 0;
}

selectAllBtn.addEventListener("click", () => toggleVisibleDomains(true));
selectNoneBtn.addEventListener("click", () => toggleVisibleDomains(false));

/* ── 批量选择（按数量范围） ── */

function showBatchModal() {
  // 移除已有弹窗
  const existing = document.querySelector(".modal-overlay");
  if (existing) existing.remove();

  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `
    <div class="modal">
      <h2>批量选择</h2>
      <div class="range-row">
        <label>Cookie 数量：</label>
        <input type="number" id="minCount" value="1" min="0" />
        <span>至</span>
        <input type="number" id="maxCount" value="" min="0" />
      </div>
      <div class="modal-actions">
        <button class="btn-secondary" id="batchCancel">取消</button>
        <button class="btn-primary" id="batchConfirm">确定</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  overlay.querySelector("#batchCancel").addEventListener("click", () => overlay.remove());
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) overlay.remove();
  });

  overlay.querySelector("#batchConfirm").addEventListener("click", () => {
    const minVal = parseInt(overlay.querySelector("#minCount").value, 10) || 0;
    const maxStr = overlay.querySelector("#maxCount").value.trim();
    const maxVal = maxStr === "" ? Infinity : parseInt(maxStr, 10);

    if (isNaN(minVal) || isNaN(maxVal) || minVal > maxVal) {
      setStatus("请输入有效的数量范围。", "error");
      overlay.remove();
      return;
    }

    // 在所有 domainEntries（原始完整列表）中匹配
    const selected = [];
    for (const entry of allDomainEntries) {
      if (entry.count >= minVal && entry.count <= maxVal) {
        selected.push(entry.domain);
      }
    }

    // 更新 checkbox 状态
    domainsEl.querySelectorAll(".domain input[type='checkbox']").forEach((cb) => {
      cb.checked = selected.includes(cb.value);
      cb.closest(".domain").classList.toggle("selected", cb.checked);
    });

    overlay.remove();
    importButton.disabled = getSelectedDomains().length === 0;
    setStatus(`已按范围选择 ${selected.length} 个域名。`, "success");
  });
}

selectMoreBtn.addEventListener("click", showBatchModal);

/* ── 扫描 ── */

async function scanDomains() {
  setBusy(true);
  setStatus("正在扫描当前浏览器 Cookie...");
  try {
    const cookies = await chrome.cookies.getAll({});
    const counts = new Map();
    for (const cookie of cookies) {
      const key = domainKey(cookie);
      if (!key) continue;
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    allDomainEntries = Array.from(counts, ([domain, count]) => ({ domain, count }))
      .sort((a, b) => b.count - a.count || a.domain.localeCompare(b.domain));
    domainEntries = allDomainEntries;
    filterText = "";
    filterInput.value = "";
    renderDomains(domainEntries);
    toolbarEl.hidden = false;
    setStatus(`找到 ${domainEntries.length} 个有 Cookie 的网站。`);
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "扫描失败", "error");
  } finally {
    setBusy(false);
  }
}

/* ── 导入 ── */

function toImportCookie(cookie) {
  const item = {
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain,
    path: cookie.path || "/",
    secure: Boolean(cookie.secure),
    httpOnly: Boolean(cookie.httpOnly),
    hostOnly: Boolean(cookie.hostOnly),
  };
  if (!cookie.session && typeof cookie.expirationDate === "number") {
    item.expires = Math.floor(cookie.expirationDate);
  }
  if (cookie.sameSite === "strict") item.sameSite = "Strict";
  if (cookie.sameSite === "lax") item.sameSite = "Lax";
  if (cookie.sameSite === "no_restriction") item.sameSite = "None";
  return item;
}

async function importSelected() {
  const selectedDomains = getSelectedDomains();
  if (selectedDomains.length === 0) {
    setStatus("请选择要导入的网站。", "error");
    return;
  }

  setBusy(true);
  setStatus("正在读取所选网站 Cookie...");
  try {
    const cookies = [];
    const seen = new Set();
    let skipped = 0;
    for (const domain of selectedDomains) {
      const hostCookies = await chrome.cookies.getAll({ domain });
      for (const cookie of hostCookies) {
        if (domainKey(cookie) === domain || domainKey(cookie).endsWith("." + domain)) {
          const key = JSON.stringify([cookie.domain, cookie.path, cookie.name, cookie.partitionKey]);
          if (seen.has(key)) continue;
          seen.add(key);
          if (cookie.partitionKey) { skipped++; continue; }
          cookies.push(toImportCookie(cookie));
        }
      }
    }

    if (cookies.length === 0) {
      setStatus("所选网站没有可导入 Cookie。", "error");
      return;
    }

    setStatus("正在连接本机 Ekko Studio…");
    const connection = await fetch("http://127.0.0.1:19489/api/cookie-import-helper/connect", {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(120000),
    });
    const target = await connection.json();
    if (!connection.ok) throw new Error(target.detail || "请先启动本机 Ekko Studio");
    const address = new URL(target.managerUrl);
    if (address.protocol !== "http:" || address.hostname !== "127.0.0.1" || !address.port
      || address.username || address.password || address.pathname !== "/" || address.search || address.hash
      || typeof target.token !== "string") throw new Error("无效的 Studio 连接");
    const managerUrl = address.origin;
    const token = target.token;
    const response = await fetch(managerUrl + "/api/cookie-import-helper/submit", {
      method: "POST", redirect: "error",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token: token,
        source_domain: selectedDomains.join(","),
        cookies: cookies,
      }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(body.detail || ("导入失败 (" + response.status + ")"));
    }

    setStatus("已导入 " + body.cookie_count + " 个 Cookie。" + (body.failed ? " 失败：" + body.failed + "。" : "") + (skipped ? " 已跳过 " + skipped + " 个分区 Cookie。" : ""), "success");
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "导入失败", "error");
  } finally {
    setBusy(false);
  }
}

/* ── 事件绑定 ── */

scanButton.addEventListener("click", scanDomains);
importButton.addEventListener("click", importSelected);
