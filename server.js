import http from "node:http";
import fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import net from "node:net";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "public");
const dataDir = path.join(__dirname, "data");
const storePath = path.join(dataDir, "store.json");
const envPath = path.join(__dirname, ".env");

const env = loadEnv();
const config = {
  port: Number(env.PORT || 8787),
  host: env.HOST || "0.0.0.0",
  appName: env.APP_NAME || "DNS Guardian",
  mockMode: String(env.MOCK_MODE ?? "true").toLowerCase() !== "false",
  cfApiToken: env.CF_API_TOKEN || "",
  cfZoneId: env.CF_ZONE_ID || "",
  awsRegion: env.AWS_REGION || "ap-east-1",
  awsCliBin: env.AWS_CLI_BIN || "aws",
  probeEndpoints: (env.PROBE_ENDPOINTS || "").split(",").map((item) => item.trim()).filter(Boolean),
  speedTestPath: env.SPEED_TEST_PATH || "/speedtest.bin",
  autoIntervalSeconds: Number(env.AUTO_INTERVAL_SECONDS || 60)
};

let state = await loadStore();
let automationRunning = false;
let automationTimer;

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (url.pathname.startsWith("/api/")) {
      await handleApi(req, res, url);
      return;
    }

    await serveStatic(res, url.pathname);
  } catch (error) {
    sendJson(res, 500, { error: error.message || "Internal Server Error" });
  }
});

server.listen(config.port, config.host, () => {
  console.log(`${config.appName} listening on http://${config.host}:${config.port}`);
  logEvent("system", "服务启动", `管理后台已启动，模式：${config.mockMode ? "模拟" : "真实"}`);
});

scheduleAutomation();

async function handleApi(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/overview") {
    const reachable = state.servers.filter((server) => server.status === "reachable").length;
    const blocked = state.servers.filter((server) => server.gfwStatus === "blocked").length;
    const pressure = state.servers.reduce((sum, server) => sum + (server.speedMbps || 0), 0);
    sendJson(res, 200, {
      appName: config.appName,
      mockMode: config.mockMode,
      stats: {
        domains: state.domains.length,
        servers: state.servers.length,
        reachable,
        blocked,
        pressureMbps: Math.round(pressure)
      },
      lastUpdatedAt: state.updatedAt
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/domains") {
    sendJson(res, 200, state.domains);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/servers") {
    sendJson(res, 200, state.servers);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/events") {
    sendJson(res, 200, state.events.slice(-80).reverse());
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/settings") {
    sendJson(res, 200, getSettings());
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/settings") {
    const body = await readBody(req);
    await updateSettings(body);
    logEvent("system", "保存系统设置", `运行模式已切换为${config.mockMode ? "模拟模式" : "真实接口"}`);
    sendJson(res, 200, { ok: true, settings: getSettings() });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/dns/switch") {
    const body = await readBody(req);
    const domain = state.domains.find((item) => item.id === body.domainId);
    const target = state.servers.find((item) => item.id === body.serverId);
    assert(domain, "域名不存在");
    assert(target, "服务器不存在");

    await updateCloudflareRecord(domain, target.publicIp);
    domain.currentServerId = target.id;
    domain.currentIp = target.publicIp;
    domain.updatedAt = new Date().toISOString();
    await saveStore();
    logEvent("dns", "切换解析", `${domain.name} 已切换到 ${target.name} (${target.publicIp})`);
    sendJson(res, 200, { ok: true, domain });
    return;
  }

  if (req.method === "POST" && url.pathname.match(/^\/api\/servers\/[^/]+\/replace-ip$/)) {
    const serverId = url.pathname.split("/")[3];
    const item = state.servers.find((server) => server.id === serverId);
    assert(item, "服务器不存在");
    const oldIp = item.publicIp;
    const allocation = await replaceAwsIp(item);
    item.publicIp = allocation.publicIp;
    item.elasticAllocationId = allocation.allocationId;
    item.gfwStatus = "checking";
    item.status = "checking";
    item.updatedAt = new Date().toISOString();
    await saveStore();
    logEvent("aws", "自动更换 IP", `${item.name}: ${oldIp} -> ${item.publicIp}`);
    sendJson(res, 200, { ok: true, server: item });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/probe/run") {
    await runProbeAndSpeed();
    sendJson(res, 200, { ok: true, servers: state.servers });
    return;
  }

  sendJson(res, 404, { error: "Not Found" });
}

async function runAutomation() {
  if (automationRunning) return;
  automationRunning = true;
  try {
    await runProbeAndSpeed();
    for (const server of state.servers) {
      if (!server.autoReplaceIp || server.gfwStatus !== "blocked") continue;
      const oldIp = server.publicIp;
      const allocation = await replaceAwsIp(server);
      server.publicIp = allocation.publicIp;
      server.elasticAllocationId = allocation.allocationId;
      server.gfwStatus = "checking";
      server.status = "checking";
      server.updatedAt = new Date().toISOString();
      logEvent("auto", "检测到被墙，已换 IP", `${server.name}: ${oldIp} -> ${server.publicIp}`);

      const boundDomains = state.domains.filter((domain) => domain.currentServerId === server.id);
      for (const domain of boundDomains) {
        await updateCloudflareRecord(domain, server.publicIp);
        domain.currentIp = server.publicIp;
        domain.updatedAt = new Date().toISOString();
        logEvent("dns", "同步解析", `${domain.name} 已同步新 IP ${server.publicIp}`);
      }
    }
    await saveStore();
  } finally {
    automationRunning = false;
  }
}

async function runProbeAndSpeed() {
  for (const server of state.servers) {
    const probe = await probeReachability(server);
    const speed = await measureSpeed(server);
    server.status = probe.reachable ? "reachable" : "unreachable";
    server.gfwStatus = probe.blocked ? "blocked" : "clean";
    server.latencyMs = probe.latencyMs;
    server.speedMbps = speed.mbps;
    server.transport = speed.transport;
    server.checkedAt = new Date().toISOString();
  }
  state.updatedAt = new Date().toISOString();
  await saveStore();
  logEvent("probe", "线路探测完成", "已刷新 GFW 状态、延迟和实时速率");
}

async function updateCloudflareRecord(domain, ip) {
  if (config.mockMode) return { id: domain.cfRecordId || "mock-record", content: ip };
  assert(config.cfApiToken, "缺少 CF_API_TOKEN");
  assert(config.cfZoneId, "缺少 CF_ZONE_ID");
  assert(domain.cfRecordId, `${domain.name} 缺少 cfRecordId`);

  const response = await fetch(`https://api.cloudflare.com/client/v4/zones/${config.cfZoneId}/dns_records/${domain.cfRecordId}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${config.cfApiToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      type: domain.type || "A",
      name: domain.name,
      content: ip,
      ttl: domain.ttl || 60,
      proxied: Boolean(domain.proxied)
    })
  });
  const payload = await response.json();
  if (!response.ok || !payload.success) {
    throw new Error(payload.errors?.[0]?.message || "Cloudflare 更新失败");
  }
  return payload.result;
}

async function replaceAwsIp(server) {
  if (config.mockMode) {
    return {
      publicIp: `23.136.${randomInt(10, 250)}.${randomInt(10, 250)}`,
      allocationId: `eipalloc-${randomUUID().slice(0, 8)}`
    };
  }

  assert(server.awsInstanceId, `${server.name} 缺少 awsInstanceId`);
  const allocate = await awsCli(["ec2", "allocate-address", "--domain", "vpc", "--region", config.awsRegion, "--output", "json"]);
  const allocation = JSON.parse(allocate);
  await awsCli([
    "ec2",
    "associate-address",
    "--instance-id",
    server.awsInstanceId,
    "--allocation-id",
    allocation.AllocationId,
    "--allow-reassociation",
    "--region",
    config.awsRegion
  ]);
  return { publicIp: allocation.PublicIp, allocationId: allocation.AllocationId };
}

function awsCli(args) {
  return new Promise((resolve, reject) => {
    execFile(config.awsCliBin, args, { timeout: 60000 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr || error.message));
        return;
      }
      resolve(stdout);
    });
  });
}

async function probeReachability(server) {
  if (config.probeEndpoints.length) {
    const results = await Promise.allSettled(config.probeEndpoints.map(async (endpoint) => {
      const response = await fetch(`${endpoint}?ip=${encodeURIComponent(server.publicIp)}&port=${server.port || 443}`, { signal: AbortSignal.timeout(8000) });
      if (!response.ok) throw new Error(`probe ${response.status}`);
      return response.json();
    }));
    const values = results.filter((item) => item.status === "fulfilled").map((item) => item.value);
    if (values.length) {
      const reachableCount = values.filter((item) => item.reachable).length;
      const latency = Math.round(avg(values.map((item) => Number(item.latencyMs || 0)).filter(Boolean)));
      return { reachable: reachableCount > 0, blocked: reachableCount === 0, latencyMs: latency || 0 };
    }
  }

  if (config.mockMode) {
    const blocked = Math.random() < 0.08;
    return { reachable: !blocked, blocked, latencyMs: randomInt(60, 160) };
  }

  const startedAt = Date.now();
  const reachable = await tcpCheck(server.publicIp, server.port || 443, 5000);
  return { reachable, blocked: !reachable, latencyMs: Date.now() - startedAt };
}

async function measureSpeed(server) {
  if (config.mockMode) {
    return { mbps: randomInt(350, 950), transport: `TCP ${randomInt(9000, 18000)} UDP ${randomInt(8, 12)}` };
  }

  const target = `http://${server.publicIp}${config.speedTestPath}`;
  const startedAt = Date.now();
  try {
    const response = await fetch(target, { signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error(`speed ${response.status}`);
    const buffer = await response.arrayBuffer();
    const seconds = Math.max((Date.now() - startedAt) / 1000, 0.1);
    return { mbps: Math.round((buffer.byteLength * 8) / seconds / 1000 / 1000), transport: "HTTP download" };
  } catch {
    return { mbps: 0, transport: "timeout" };
  }
}

function tcpCheck(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const done = (result) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

async function serveStatic(res, requestPath) {
  const safePath = requestPath === "/" ? "/index.html" : requestPath;
  const filePath = path.normalize(path.join(publicDir, safePath));
  if (!filePath.startsWith(publicDir)) {
    sendText(res, 403, "Forbidden");
    return;
  }
  try {
    const content = await fs.readFile(filePath);
    res.writeHead(200, { "Content-Type": contentType(filePath) });
    res.end(content);
  } catch {
    sendText(res, 404, "Not Found");
  }
}

async function loadStore() {
  await fs.mkdir(dataDir, { recursive: true });
  try {
    return JSON.parse(await fs.readFile(storePath, "utf8"));
  } catch {
    const now = new Date().toISOString();
    const initial = {
      updatedAt: now,
      domains: [
        {
          id: "domain-main",
          name: "edge.example.com",
          type: "A",
          ttl: 60,
          proxied: false,
          cfRecordId: "",
          currentServerId: "srv-hk-1",
          currentIp: "23.136.252.8",
          updatedAt: now
        }
      ],
      servers: [
        {
          id: "srv-hk-1",
          name: "香港优化 01",
          provider: "AWS",
          region: "ap-east-1",
          publicIp: "23.136.252.8",
          port: 443,
          awsInstanceId: "",
          elasticAllocationId: "",
          autoReplaceIp: true,
          status: "reachable",
          gfwStatus: "clean",
          latencyMs: 69,
          speedMbps: 450,
          transport: "TCP 12339 UDP 10",
          checkedAt: now
        },
        {
          id: "srv-hk-2",
          name: "香港优化 02",
          provider: "AWS",
          region: "ap-east-1",
          publicIp: "43.198.12.88",
          port: 443,
          awsInstanceId: "",
          elasticAllocationId: "",
          autoReplaceIp: true,
          status: "reachable",
          gfwStatus: "clean",
          latencyMs: 67,
          speedMbps: 544,
          transport: "TCP 10934 UDP 10",
          checkedAt: now
        },
        {
          id: "srv-sg-1",
          name: "新加坡备用 01",
          provider: "AWS",
          region: "ap-southeast-1",
          publicIp: "18.141.21.9",
          port: 443,
          awsInstanceId: "",
          elasticAllocationId: "",
          autoReplaceIp: false,
          status: "reachable",
          gfwStatus: "clean",
          latencyMs: 115,
          speedMbps: 509,
          transport: "TCP 16888 UDP 10",
          checkedAt: now
        }
      ],
      events: []
    };
    await fs.writeFile(storePath, JSON.stringify(initial, null, 2));
    return initial;
  }
}

async function saveStore() {
  state.updatedAt = new Date().toISOString();
  await fs.writeFile(storePath, JSON.stringify(state, null, 2));
}

function getSettings() {
  return {
    mockMode: config.mockMode,
    cfApiTokenConfigured: Boolean(config.cfApiToken),
    cfZoneId: config.cfZoneId,
    awsRegion: config.awsRegion,
    awsCliBin: config.awsCliBin,
    probeEndpoints: config.probeEndpoints.join(","),
    speedTestPath: config.speedTestPath,
    autoIntervalSeconds: config.autoIntervalSeconds
  };
}

async function updateSettings(body) {
  if (typeof body.mockMode === "boolean") config.mockMode = body.mockMode;
  if (typeof body.cfZoneId === "string") config.cfZoneId = body.cfZoneId.trim();
  if (typeof body.awsRegion === "string" && body.awsRegion.trim()) config.awsRegion = body.awsRegion.trim();
  if (typeof body.awsCliBin === "string" && body.awsCliBin.trim()) config.awsCliBin = body.awsCliBin.trim();
  if (typeof body.probeEndpoints === "string") {
    config.probeEndpoints = body.probeEndpoints.split(",").map((item) => item.trim()).filter(Boolean);
  }
  if (typeof body.speedTestPath === "string" && body.speedTestPath.trim()) {
    config.speedTestPath = body.speedTestPath.trim();
  }
  if (body.autoIntervalSeconds !== undefined) {
    const interval = Number(body.autoIntervalSeconds);
    if (Number.isFinite(interval) && interval >= 15) config.autoIntervalSeconds = Math.round(interval);
  }
  if (typeof body.cfApiToken === "string" && body.cfApiToken.trim()) {
    config.cfApiToken = body.cfApiToken.trim();
  }

  await persistEnv({
    MOCK_MODE: String(config.mockMode),
    CF_API_TOKEN: config.cfApiToken,
    CF_ZONE_ID: config.cfZoneId,
    AWS_REGION: config.awsRegion,
    AWS_CLI_BIN: config.awsCliBin,
    PROBE_ENDPOINTS: config.probeEndpoints.join(","),
    SPEED_TEST_PATH: config.speedTestPath,
    AUTO_INTERVAL_SECONDS: String(config.autoIntervalSeconds)
  });
  scheduleAutomation();
}

function scheduleAutomation() {
  clearInterval(automationTimer);
  automationTimer = setInterval(() => {
    runAutomation().catch((error) => logEvent("error", "自动化执行失败", error.message));
  }, Math.max(config.autoIntervalSeconds, 15) * 1000);
}

async function persistEnv(values) {
  let lines = [];
  try {
    lines = (await fs.readFile(envPath, "utf8")).split(/\r?\n/);
  } catch {
    lines = [];
  }

  for (const [key, value] of Object.entries(values)) {
    const index = lines.findIndex((line) => line.trimStart().startsWith(`${key}=`));
    const nextLine = `${key}=${String(value).replace(/\r?\n/g, "")}`;
    if (index >= 0) lines[index] = nextLine;
    else lines.push(nextLine);
  }
  await fs.writeFile(envPath, `${lines.filter((line, index, all) => index < all.length - 1 || line !== "").join("\n").trimEnd()}\n`, { mode: 0o600 });
}

function logEvent(type, title, detail) {
  state.events.push({ id: randomUUID(), type, title, detail, createdAt: new Date().toISOString() });
  if (state.events.length > 300) state.events = state.events.slice(-300);
  saveStore().catch(() => {});
}

function loadEnv() {
  const result = { ...process.env };
  try {
    const text = readFileSync(path.join(__dirname, ".env"), "utf8");
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
      const [key, ...rest] = trimmed.split("=");
      result[key.trim()] = rest.join("=").trim();
    }
  } catch {}
  return result;
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function sendJson(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function sendText(res, status, payload) {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(payload);
}

function contentType(filePath) {
  if (filePath.endsWith(".html")) return "text/html; charset=utf-8";
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  if (filePath.endsWith(".js")) return "text/javascript; charset=utf-8";
  return "application/octet-stream";
}

function assert(value, message) {
  if (!value) throw new Error(message);
}

function avg(values) {
  if (!values.length) return 0;
  return values.reduce((sum, item) => sum + item, 0) / values.length;
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}
