# DNSHE 免费域名自动续期

基于 GitHub Actions 的全自动免费域名续期工具，同时支持 Loon 平台本地脚本运行。可管理多账号、自动遍历所有子域名、智能识别续期窗口，并通过 Telegram / PushPlus 推送详细报告。

---

## 目录

- [项目架构](#项目架构)
- [目录结构](#目录结构)
- [核心模块说明](#核心模块说明)
  - [renew.py —— GitHub Actions 主执行脚本](#renewpy--github-actions-主执行脚本)
  - [renew.yml —— GitHub Actions 工作流定义](#renewyml--github-actions-工作流定义)
  - [DNSHE_Renew.js —— Loon 平台脚本](#dnshe_renewjs--loon-平台脚本)
  - [Dnshe_Renew.boxjs.json —— BoxJs 订阅配置](#dnshe_renewboxjsjson--boxjs-订阅配置)
- [关键函数说明](#关键函数说明)
- [外部依赖](#外部依赖)
- [运行方式](#运行方式)
  - [方式一：GitHub Actions（推荐）](#方式一github-actions推荐)
  - [方式二：Loon 本地脚本](#方式二loon-本地脚本)
  - [方式三：本地手动运行](#方式三本地手动运行)
- [配置参考](#配置参考)
- [通知格式](#通知格式)
- [常见问题](#常见问题)

---

## 项目架构

```
┌─────────────────────────────────────────────────────────────────┐
│                      DNSHE Auto Renew                            │
├─────────────────────────────────────────────────────────────────┤
│                                                                   │
│  ┌─────────────────┐    ┌──────────────────────────────────┐    │
│  │  GitHub Actions  │    │       Loon 本地脚本              │    │
│  │  (renew.yml)     │    │  (DNSHE_Renew.js)               │    │
│  │                  │    │                                  │    │
│  │  ┌───────────┐   │    │  ┌──────────────┐               │    │
│  │  │ renew.py  │   │    │  │ BoxJs 订阅   │               │    │
│  │  │ (Python)  │   │    │  │ 配置 → 执行  │               │    │
│  │  └─────┬─────┘   │    │  └──────┬───────┘               │    │
│  │        │         │    │         │                        │    │
│  └────────│─────────┘    └─────────│────────────────────────┘    │
│           │                        │                             │
│           └──────────┬─────────────┘                             │
│                      │ HTTP API 调用                             │
│                      ▼                                            │
│           ┌──────────────────┐                                   │
│           │  DNSHE API       │                                   │
│           │  api005.dnshe.com│                                   │
│           └────────┬─────────┘                                   │
│                    │                                              │
│                    ▼                                              │
│           ┌──────────────────┐                                   │
│           │   DNSHE 免费域名  │                                   │
│           │   (续期操作)      │                                   │
│           └──────────────────┘                                   │
│                                                                   │
│  ┌───────────────────────┐  ┌──────────────────────┐            │
│  │  Telegram Bot         │  │  PushPlus            │            │
│  │  (消息通知)           │  │  (消息通知)          │            │
│  └───────────────────────┘  └──────────────────────┘            │
│                                                                   │
└─────────────────────────────────────────────────────────────────┘
```

**设计思路：**

- **平台无关的执行核心**：Python 脚本 `renew.py` 和 JavaScript 脚本 `DNSHE_Renew.js` 各自实现了相同的业务逻辑（获取域名 → 逐一续期 → 生成报告 → 发送通知），分别适配 GitHub Actions 和 Loon 两种运行环境。
- **声明式配置驱动**：账号密钥通过环境变量（GitHub Secrets）或 BoxJs 订阅注入，代码零硬编码。
- **幂等处理**：仅对到期前 180 天内的域名发起续期请求，已续期或未到窗口的域名自动跳过。
- **分级通知**：支持 Telegram 和 PushPlus 双通道推送，未配置通知渠道时降级为仅日志输出。

---

## 目录结构

```text
Dnshe-auto-renew/
├── .github/
│   └── workflows/
│       └── renew.yml                # GitHub Actions 工作流定义
├── loon/
│   ├── DNSHE_Renew.js               # Loon 平台 Cron 脚本
│   └── Dnshe_Renew.boxjs.json       # BoxJs 订阅配置文件
├── renew.py                         # Python 主执行脚本（核心逻辑）
├── .gitignore
└── README.md
```

---

## 核心模块说明

### renew.py —— GitHub Actions 主执行脚本

**职责**：接收环境变量中的账号配置，依次处理每个账户的域名续期，生成 HTML 格式报告并通过通知通道发送。

**关键函数**：

| 函数 | 类型 | 说明 |
|---|---|---|
| `parse_accounts(raw)` | 工具函数 | 解析 `DNSHE_ACCOUNTS` 环境变量中的简化格式字符串（`名称:Key:Secret;...`），返回结构化账户列表 |
| `get_all_subdomains(api_key, api_secret)` | 核心逻辑 | 向 DNSHE API 发起分页请求，获取指定账户下的所有子域名列表，支持 500 条/页的分页遍历 |
| `process_account(account)` | 核心逻辑 | 处理单个账户的完整续期流程：获取域名 → 遍历续期 → 分类统计（成功/跳过/永久/失败） |
| `build_report(all_results)` | 报告生成 | 将所有账户的处理结果合并为结构化 HTML 文本，含账户分组和统计摘要 |
| `send_telegram(token, chat_id, text)` | 通知发送 | 通过 Telegram Bot API 发送 HTML 格式的续期报告消息 |
| `send_pushplus(token, title, content)` | 通知发送 | 通过 PushPlus API 发送 HTML 格式的续期报告消息 |
| `main()` | 入口 | 读取环境变量 → 解析账户 → 逐账户处理 → 输出报告 → 发送通知 |

**执行流程**：

```text
main()
 ├─ 读取 DNSHE_ACCOUNTS 环境变量
 ├─ parse_accounts() → 解析为账户列表
 ├─ 遍历每个账户:
 │   ├─ get_all_subdomains() → 获取全量子域名
 │   └─ 遍历每个域名:
 │       ├─ POST renew 请求续期
 │       ├─ 成功 → 记录成功
 │       ├─ 失败码 renewal_not_yet_available → 跳过
 │       ├─ 提示 never expire → 永久域名
 │       └─ 其他错误 → 失败
 ├─ build_report() → 组装 HTML 报告
 └─ 通知通道:
     ├─ Telegram (若配置)
     └─ PushPlus (若配置)
```

---

### renew.yml —— GitHub Actions 工作流定义

**职责**：定义 GitHub Actions 的触发条件和执行步骤。

```yaml
name: DNSHE Auto Renew
on:
  schedule:
    - cron: '0 0 1 * *'   # 每月 1 日 UTC 0:00（北京时间 8:00）
  workflow_dispatch:         # 支持手动触发
jobs:
  renew:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4        # 检出代码
      - uses: actions/setup-python@v5    # 配置 Python 3.11
        with:
          python-version: '3.11'
      - run: pip install requests         # 安装依赖
      - name: Run renew script
        env:
          DNSHE_ACCOUNTS: ${{ secrets.DNSHE_ACCOUNTS }}
          TELEGRAM_BOT_TOKEN: ${{ secrets.TELEGRAM_BOT_TOKEN }}
          TELEGRAM_CHAT_ID: ${{ secrets.TELEGRAM_CHAT_ID }}
          PUSHPLUS_TOKEN: ${{ secrets.PUSHPLUS_TOKEN }}
        run: python renew.py
```

**关键说明**：

- **调度**：`schedule` 事件使用 cron 表达式 `0 0 1 * *`，每月 1 日 UTC 0:00 自动触发（北京时间早 8:00）
- **手动触发**：`workflow_dispatch` 允许用户在 GitHub Actions 页面手动启动
- **密钥注入**：四个环境变量均从 GitHub Secrets 读取，日志中不会明文显示
- **依赖安装**：仅需 `requests` 一个外部 Python 包

---

### DNSHE_Renew.js —— Loon 平台脚本

**职责**：在 Loon 代理环境下运行的 JavaScript 脚本，独立实现与 `renew.py` 相同的业务逻辑，通过 `$httpClient`、`$persistentStore`、`$notification` 等 Loon 原生 API 工作。

**关键函数**：

| 函数 | 类型 | 说明 |
|---|---|---|
| `httpRequest(method, endpoint, action, data, key, secret)` | 网络封装 | 封装 Loon 的 `$httpClient`，提供统一 HTTP 请求接口 |
| `getAllSubdomains(key, secret)` | 核心逻辑 | 异步分页获取所有子域名，每页 200 条，内置 300ms 请求间隔 |
| `processAccount(acc)` | 核心逻辑 | 异步处理单个账户：获取活跃域名（`status === "active"`）→ 逐一遍历续期 |
| `formatReport(results)` | 报告生成 | 格式化续期结果为纯文本，生成统计摘要 |
| `(async () => {...})()` | 入口 | 读取 BoxJs 或 argument 配置 → 逐账户处理 → 格式化报告 → Loon 通知 |

**与 `renew.py` 的关键差异**：

| 维度 | renew.py | DNSHE_Renew.js |
|---|---|---|
| 运行环境 | GitHub Actions / 本地 Python | Loon 代理 App |
| 配置来源 | 环境变量 `DNSHE_ACCOUNTS` | BoxJs 订阅 `$persistentStore` 或 `$argument` |
| 通知方式 | Telegram / PushPlus API | Loon 系统通知 `$notification.post` |
| HTTP 客户端 | `requests` 库 | `$httpClient`（Loon 内置） |
| 异步模型 | 同步阻塞 | async/await + Promise |
| 域名筛选 | 所有状态域名 | 仅 `status === "active"` 的活跃域名 |

---

### Dnshe_Renew.boxjs.json —— BoxJs 订阅配置

**职责**：定义 BoxJs 订阅面板的元数据，为用户提供可视化的 API 配置界面。

**配置结构**：

```json
{
  "id": "dnshe.renew.subscription",
  "name": "DNSHE 域名续期",
  "apps": [
    {
      "id": "dnshe.renew.app",
      "keys": ["DNSHE_RENEW_ACCOUNTS"],
      "settings": [
        {
          "id": "DNSHE_RENEW_ACCOUNTS",
          "type": "textarea",
          "placeholder": "账户一:APIKey:APISecret;账户二:APIKey2:APISecret2"
        }
      ]
    }
  ]
}
```

**配置键说明**：

| 键名 | 类型 | 用途 |
|---|---|---|
| `DNSHE_RENEW_ACCOUNTS` | textarea | 存储多账户配置，格式与 Python 脚本的 `DNSHE_ACCOUNTS` 环境变量一致 |

---

## 关键函数说明

### 续期业务核心逻辑

两个脚本的续期处理逻辑完全一致，以 Python 脚本为例：

```python
def process_account(account):
    # 1. 获取账户下的所有子域名（自动分页）
    subdomains = get_all_subdomains(api_key, api_secret)

    # 2. 遍历每个子域名
    for sub in subdomains:
        # 构造续期请求
        resp = requests.post(
            API_BASE,
            headers=headers,
            params={"endpoint": "subdomains", "action": "renew"},
            json={"subdomain_id": sub["id"]}
        )
        data = resp.json()

        # 3. 根据响应分类处理
        if data.get("success"):
            # ✅ 续期成功 → 记录新旧到期时间
        else:
            message = data.get("message", "")
            # ♾️ 永久域名（never expire）
            if "never expire" in message.lower():
                ...
            # ⏭️ 未到续期窗口
            elif error_code == "renewal_not_yet_available":
                ...
            # ❌ 其他失败
            else:
                ...
```

**续期判定规则**：

| API 响应特征 | 归类 | 含义 |
|---|---|---|
| `success: true` | ✅ 续期成功 | 域名已成功延长有效期 |
| `message` 包含 "never expire" | ♾️ 永久域名 | 该域名被设置为永不过期，无需续期 |
| `error_code == "renewal_not_yet_available"` | ⏭️ 跳过 | 域名到期时间尚早（超过 180 天），未进入续期窗口 |
| 其他失败 | ❌ 失败 | API 密钥错误、网络异常、限额超限等 |

### 速率限制策略

DNSHE API 的限制约为 30～60 次/分钟。两个脚本分别在每次请求后插入间隔：

- **renew.py**：列表请求间隔 **0.3s**，续期请求间隔 **0.5s**
- **DNSHE_Renew.js**：列表请求间隔 **300ms**，续期请求间隔 **500ms**

---

## 外部依赖

### Python 脚本（renew.py）

| 依赖 | 版本 | 用途 |
|---|---|---|
| `requests` | 最新版 | HTTP 客户端，用于调用 DNSHE API 及通知接口 |
| Python 标准库 | 3.8+ | `os`（环境变量）、`sys`（退出）、`time`（延时）、`datetime`（时间格式化） |

### Loon 脚本（DNSHE_Renew.js）

| 依赖 | 来源 | 用途 |
|---|---|---|
| `$httpClient` | Loon 内置 API | HTTP 请求 |
| `$persistentStore` | Loon 内置 API | BoxJs 持久化存储读写 |
| `$notification` | Loon 内置 API | 系统通知推送 |
| `$done` | Loon 内置 API | 脚本完成回调 |

**无需额外安装任何 npm 包。**

### GitHub Actions Workflow

| Action | 版本 | 用途 |
|---|---|---|
| `actions/checkout` | v4 | 检出仓库代码 |
| `actions/setup-python` | v5 | 配置 Python 运行环境 |

---

## 运行方式

### 方式一：GitHub Actions（推荐）

#### 前置准备

1. 登录 [DNSHE](https://my.dnshe.com/) → 进入 **免费域名** → 在 **API 管理** 中创建 API 密钥，保存 `API Key` 和 `API Secret`

2. 准备通知渠道（可选）：
   - **Telegram**：通过 `@BotFather` 创建机器人获取 `BOT_TOKEN`，通过 `@userinfobot` 获取 `CHAT_ID`
   - **PushPlus**：登录 [pushplus.plus](https://www.pushplus.plus/) 获取个人 Token

#### 配置步骤

1. Fork 本仓库

2. 在仓库 `Settings → Secrets and variables → Actions` 中添加以下密钥：

| Secret 名称 | 必填 | 说明 |
|---|---|---|
| `DNSHE_ACCOUNTS` | ✅ | 账户配置字符串，见下方格式说明 |
| `TELEGRAM_BOT_TOKEN` | ❌ | Telegram Bot 令牌 |
| `TELEGRAM_CHAT_ID` | ❌ | Telegram 接收消息的 Chat ID |
| `PUSHPLUS_TOKEN` | ❌ | PushPlus 令牌 |

**`DNSHE_ACCOUNTS` 格式**：

```text
账户名称:API_KEY:API_SECRET;账户名称2:API_KEY2:API_SECRET2
```

- 每个账户三段式：`名称:API密钥:API Secret`
- 多账户用英文分号 `;` 分隔
- 名称自定义（仅用于报告标识），不可包含 `:` 和 `;`

**示例**：

```text
个人博客:cfsd_xxxxxxxxxx:yyyyyyyyyyyyy;公司站点:cfsd_zzzzzzzzzz:aaaaaaaaaaaaa
```

3. 推送代码后，Actions 将自动激活。工作流将在 **每月 1 日 UTC 0:00（北京时间 8:00）** 自动执行。

#### 手动触发

在 GitHub 仓库的 **Actions** 页面，选择 **DNSHE Auto Renew** 工作流，点击 **Run workflow** 即可立即执行。

---

### 方式二：Loon 本地脚本

#### 配置 BoxJs 订阅

1. 打开 BoxJs 后台（通过 Loon 面板进入，或 Safari 访问 boxjs.com）
2. 进入 **订阅** 页面，添加订阅 URL：
   ```
   https://raw.githubusercontent.com/stanlylove/Dnshe-auto-renew/main/loon/Dnshe_Renew.boxjs.json
   ```
3. 保存后，在 **应用** 页面会生成 **DNSHE API** 配置项
4. 在文本框中输入账户配置（格式与 `DNSHE_ACCOUNTS` 相同）

#### 添加 Loon Cron 脚本

在 Loon 的配置文件中添加：

```text
[Script]
cron "0 8 1 * *" script-path=https://raw.githubusercontent.com/stanlylove/Dnshe-auto-renew/main/loon/DNSHE_Renew.js, tag=DNSHE续期, timeout=600, enable=true
```

如不使用 BoxJs，可通过 `argument` 直接传入：

```text
cron "0 8 1 * *" script-path=https://raw.githubusercontent.com/stanlylove/Dnshe-auto-renew/main/loon/DNSHE_Renew.js, tag=DNSHE续期, argument="账户一:APIKey:APISecret;账户二:APIKey2:APISecret2", timeout=600, enable=true
```

---

## 配置参考

### cron 表达式

工作流默认每月 1 日执行。如需调整，修改 `.github/workflows/renew.yml` 中的 `cron` 字段：

| 执行频率 | cron 表达式 | 说明 |
|---|---|---|
| 每月 1 日 8:00（北京时间） | `0 0 1 * *` | 默认配置，UTC 0:00 = 北京时间 8:00 |
| 每月 1 日和 15 日 | `0 0 1,15 * *` | 月中的两个时间点 |
| 每周一 8:00 | `0 0 * * 1` | UTC 0:00 |
| 每天 8:00 | `0 0 * * *` | 不推荐，域名续期每月一次即可 |

### 环境变量速查

| 变量名 | 格式 | 示例 |
|---|---|---|
| `DNSHE_ACCOUNTS` | `名称:Key:Secret;名称2:Key2:Secret2` | `域名一:key1:sec1;域名二:key2:sec2` |
| `TELEGRAM_BOT_TOKEN` | Bot 令牌字符串 | `123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11` |
| `TELEGRAM_CHAT_ID` | 纯数字或 `@username` | `123456789` |
| `PUSHPLUS_TOKEN` | PushPlus 令牌 | `abcdef1234567890abcdef` |

---

## 通知格式

### Telegram / PushPlus 消息模板

```text
📅 DNSHE 自动续期报告 - 20XX-XX-XX XX:XX UTC

🔹 账户：账号一
总域名：3 | ✅ 续期成功：2 | ⏭️ 跳过：0 | ♾️ 永久：0 | ❌ 失败：1

✅ myapp.example.com
   到期时间：2026-06-01 00:00:00 → 2027-06-01 00:00:00

⏭️ blog.example.com
   尚未到续期窗口（当前到期：2026-11-20）

♾️ old.example.com
   永久域名（无需续期）

❌ failed.example.com
   续期失败：rate_limit_exceeded

🔹 账户：账号二
总域名：1 | ✅ 续期成功：0 | ⏭️ 跳过：1 | ♾️ 永久：0 | ❌ 失败：0
```

**状态图标说明**：

| 图标 | 含义 | 说明 |
|---|---|---|
| ✅ | 续期成功 | 域名已成功延长一年有效期，显示新旧到期时间 |
| ⏭️ | 跳过 | 域名到期时间尚早（距到期超过 180 天），未进入续期窗口 |
| ♾️ | 永久域名 | 域名被设置为永不过期，无需发起续期操作 |
| ❌ | 失败 | 续期请求失败，显示具体错误信息 |

---

## 常见问题

**Q：免费域名真的能一直续期下去吗？**

A：只要官方服务不变更域名状态正常，且在到期前 180 天内续期，每次都会延长一年，可无限循环。

**Q：我只有 1 个账户怎么填？**

A：只写一个即可，结尾不需要分号。例如：`我的账户:key:secret`

**Q：通知渠道可以都不配置吗？**

A：可以。脚本只会在日志中打印报告，不会发送外部通知。GitHub Actions 的运行日志可在 Actions 页面查看。

**Q：为什么会遇到 rate_limit_exceeded 错误？**

A：脚本已内置 0.3～0.5 秒的请求间隔，确保不超过 API 限制（30～60 次/分钟）。如果域名数量极大，首次运行可能接近限制，后续运行因跳过已续期域名，请求量会自然减少。

**Q：Python 脚本和 Loon 脚本有什么区别？**

A：两者功能完全一致，只是运行环境不同。Python 脚本适合 GitHub Actions 或任意服务器环境，支持 Telegram / PushPlus 通知；Loon 脚本在 iOS 代理 App 中运行，使用系统通知推送结果。

---

## 致谢

- [**DNSHE**](https://www.dnshe.com/)：提供免费域名注册服务及完善的管理 API
- [**Deepseek**](https://deepseek.com/)：提供 AI 辅助编写与优化支持
