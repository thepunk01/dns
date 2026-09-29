const state = {
  overview: null,
  domains: [],
  servers: [],
  events: [],
  settings: null
};

const $ = (selector) => document.querySelector(selector);

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) }
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || "请求失败");
  return payload;
}

async function refresh() {
  const [overview, domains, servers, events, settings] = await Promise.all([
    api("/api/overview"),
    api("/api/domains"),
    api("/api/servers"),
    api("/api/events"),
    api("/api/settings")
  ]);
  state.overview = overview;
  state.domains = domains;
  state.servers = servers;
  state.events = events;
  state.settings = settings;
  render();
}

function render() {
  $("#modeBadge").textContent = state.overview.mockMode ? "模拟模式" : "真实接口";
  renderSettings();
  const stats = state.overview.stats;
  $("#stats").innerHTML = [
    ["域名解析", stats.domains, "Cloudflare 记录"],
    ["服务器池", stats.servers, "AWS / 边缘节点"],
    ["被墙 IP", stats.blocked, "今日检测"],
    ["实时压力", `${stats.pressureMbps} Mbps`, "候选机总下载"]
  ].map(([label, value, note]) => `
    <div class="stat">
      <span>${label}</span>
      <strong>${value}</strong>
      <span>${note}</span>
    </div>
  `).join("");

  $("#domainRows").innerHTML = state.domains.map((domain) => {
    const current = state.servers.find((server) => server.id === domain.currentServerId);
    return `
      <tr>
        <td class="title-cell">
          <strong>${domain.name}</strong>
          <span>${domain.type} · TTL ${domain.ttl}s · ${domain.proxied ? "代理" : "仅 DNS"}</span>
        </td>
        <td>${domain.currentIp}</td>
        <td>${statusPill(current?.status, current?.gfwStatus)}</td>
        <td>
          <div class="actions">
            ${state.servers.map((server) => `
              <button onclick="switchDns('${domain.id}', '${server.id}')" class="${server.id === domain.currentServerId ? "primary" : ""}">
                ${server.id === domain.currentServerId ? "当前" : "切换"} ${server.name}
              </button>
            `).join("")}
          </div>
        </td>
      </tr>
    `;
  }).join("");

  $("#serverRows").innerHTML = state.servers.map((server) => `
    <tr>
      <td class="title-cell">
        <strong>${server.name}</strong>
        <span>${server.provider} · ${server.region} · :${server.port}</span>
      </td>
      <td>${server.publicIp}</td>
      <td>
        ${server.gfwStatus === "blocked" ? pill("bad", "被墙") : pill("ok", "可达")}
        <div class="subtle">${server.latencyMs || 0}ms</div>
      </td>
      <td>
        ${server.status === "reachable" ? pill("ok", "可达") : pill("warn", "检测中")}
        <div class="subtle">${timeAgo(server.checkedAt)}</div>
      </td>
      <td>
        <strong>${server.speedMbps || 0} Mbps</strong>
        <div class="subtle">${server.transport || "-"}</div>
      </td>
      <td>
        <div class="actions">
          <button onclick="replaceIp('${server.id}')">更换 IP</button>
          <button onclick="runProbe()">探测</button>
        </div>
      </td>
    </tr>
  `).join("");

  $("#events").innerHTML = state.events.length ? state.events.map((event) => `
    <div class="event">
      <strong>${event.title}</strong>
      <span>${event.detail}</span>
      <time>${new Date(event.createdAt).toLocaleString()}</time>
    </div>
  `).join("") : `<div class="event"><strong>暂无事件</strong><span>系统启动后会记录自动化动作。</span></div>`;
}

function renderSettings() {
  const settings = state.settings;
  if (!settings) return;
  $("#mockMode").checked = settings.mockMode;
  $("#cfZoneId").value = settings.cfZoneId || "";
  $("#awsRegion").value = settings.awsRegion || "";
  $("#awsCliBin").value = settings.awsCliBin || "aws";
  $("#probeEndpoints").value = settings.probeEndpoints || "";
  $("#speedTestPath").value = settings.speedTestPath || "/speedtest.bin";
  $("#autoIntervalSeconds").value = settings.autoIntervalSeconds || 60;
  $("#tokenStatus").textContent = settings.cfApiTokenConfigured ? "当前 Token 已配置，留空则保持不变" : "当前未配置 Token";
}

function statusPill(status, gfwStatus) {
  if (gfwStatus === "blocked") return pill("bad", "被墙");
  if (status === "reachable") return pill("ok", "健康");
  return pill("warn", "检测中");
}

function pill(type, text) {
  return `<span class="pill ${type}"><i class="dot"></i>${text}</span>`;
}

function timeAgo(value) {
  if (!value) return "未检测";
  const seconds = Math.max(Math.round((Date.now() - new Date(value).getTime()) / 1000), 0);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  return `${minutes}m`;
}

async function switchDns(domainId, serverId) {
  await act("正在切换解析", async () => {
    await api("/api/dns/switch", {
      method: "POST",
      body: JSON.stringify({ domainId, serverId })
    });
  });
}

async function replaceIp(serverId) {
  await act("正在更换 AWS IP", async () => {
    await api(`/api/servers/${serverId}/replace-ip`, { method: "POST" });
  });
}

async function runProbe() {
  await act("正在执行线路探测", async () => {
    await api("/api/probe/run", { method: "POST" });
  });
}

async function act(message, fn) {
  toast(message);
  try {
    await fn();
    await refresh();
    toast("操作完成");
  } catch (error) {
    toast(error.message);
  }
}

function toast(text) {
  const node = $("#toast");
  node.textContent = text;
  node.classList.add("show");
  clearTimeout(window.__toastTimer);
  window.__toastTimer = setTimeout(() => node.classList.remove("show"), 2600);
}

$("#runProbe").addEventListener("click", runProbe);
$("#settingsForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  await act("正在保存系统设置", async () => {
    await api("/api/settings", {
      method: "POST",
      body: JSON.stringify({
        mockMode: $("#mockMode").checked,
        cfApiToken: $("#cfApiToken").value,
        cfZoneId: $("#cfZoneId").value,
        awsRegion: $("#awsRegion").value,
        awsCliBin: $("#awsCliBin").value,
        probeEndpoints: $("#probeEndpoints").value,
        speedTestPath: $("#speedTestPath").value,
        autoIntervalSeconds: Number($("#autoIntervalSeconds").value)
      })
    });
    $("#cfApiToken").value = "";
  });
});
refresh();
setInterval(refresh, 15000);
