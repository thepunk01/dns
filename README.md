# DNS Guardian

DNS Guardian 是一个可部署的 DNS 服务管理后台原型，功能覆盖：

- Cloudflare DDNS 记录管理与一键切换解析
- AWS 服务器 / Elastic IP 管理接口
- GFW 可达性探测，被墙后自动更换 IP
- 节点实时速率、延迟、在线状态监控
- 事件日志和自动化策略

## 快速启动

```bash
cp .env.example .env
npm start
```

打开：

```text
http://127.0.0.1:8787
```

默认 `MOCK_MODE=true`，不用密钥也可以演示流程。正式使用前，把 `.env` 里的 Cloudflare、AWS 和探测端点补齐，再改为：

```env
MOCK_MODE=false
```

## 真实环境建议

1. Cloudflare 创建 API Token，权限至少包含 `Zone:Read`、`DNS:Edit`。
2. AWS 服务器安装 `awscli`，并配置有 `ec2:AllocateAddress`、`ec2:AssociateAddress`、`ec2:DescribeInstances` 等权限的 IAM。
3. 国内外分别放置轻量探测端点，用于判断目标 IP 是否可达。
4. 服务器放置小文件 `/speedtest.bin`，后台会用它估算实时下载速率。

## API 入口

- `GET /api/overview`
- `GET /api/domains`
- `GET /api/servers`
- `GET /api/events`
- `POST /api/dns/switch`
- `POST /api/servers/:id/replace-ip`
- `POST /api/probe/run`

## 部署

普通服务器直接运行：

```bash
npm start
```

宝塔可用 Node 项目方式运行，反向代理到 `127.0.0.1:8787`。

## GitHub 一键更新

把项目放到 GitHub 后，服务器首次部署：

```bash
git clone https://github.com/你的账号/dns-guardian.git /opt/dns-guardian
cd /opt/dns-guardian
cp .env.example .env
npm install --omit=dev
```

安装 systemd 服务：

```bash
sudo cp deploy/dns-guardian.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now dns-guardian
```

以后更新只需要：

```bash
sudo bash /opt/dns-guardian/deploy/update.sh
```

更新脚本会执行 `git pull`、安装依赖并重启服务。`.env` 和运行中的 `data/store.json` 不会被 Git 覆盖。

## 一键安装

将项目推送到 GitHub 后，在全新的 Linux 服务器执行下面一条命令即可安装：

```bash
curl -fsSL https://raw.githubusercontent.com/thepunk01/dns/main/deploy/install.sh \
  | sudo bash -s -- --repo https://github.com/thepunk01/dns.git
```

安装脚本会自动：

- 识别 Debian/Ubuntu、RHEL/CentOS/Alma/Rocky、Alpine
- 安装 Git、curl 和 Node.js 20+
- 克隆或更新 GitHub 项目
- 创建 `.env` 和运行数据目录
- 安装 npm 依赖
- 优先注册 systemd 开机自启服务
- 没有 systemd 时自动使用后台进程启动

也支持自定义目录和分支：

```bash
curl -fsSL https://raw.githubusercontent.com/thepunk01/dns/main/deploy/install.sh \
  | sudo bash -s -- \
    --repo https://github.com/thepunk01/dns.git \
    --dir /opt/dns-guardian \
    --branch main
```

注意：iStoreOS/OpenWrt 这类路由系统通常没有完整 Node.js/npm 和 systemd，建议把管理后台安装在 Debian 12/Ubuntu 22.04+ 服务器，路由器只作为被监测节点。

## 在管理面板配置密钥

安装完成后打开管理页面，滚动到页面底部的“系统设置”，可以直接填写：

- Cloudflare API Token
- Cloudflare Zone ID
- AWS Region
- AWS CLI 路径或命令
- 国内探测端点
- 自动检测间隔
- 模拟模式 / 真实接口模式

保存后会写入服务器本地 `.env`，Token 不会在页面回显。`.env` 已加入 `.gitignore`，不会推送到 GitHub。

当前版本尚未内置管理员登录。正式公网使用时，建议先通过安全组限制 `8787` 来源，或在 Nginx/Caddy 前面增加 HTTPS 和 Basic Auth。
