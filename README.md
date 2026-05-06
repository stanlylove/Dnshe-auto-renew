# DNSHE 免费域名自动续期

基于 GitHub Actions 的全自动免费域名续期工具，支持多账号、多域名，结果通过 Telegram / PushPlus 通知。

## 📌 功能特色

- **全自动续期**：每月 1 日（UTC）自动运行，亦可手动触发
- **多账号支持**：可配置任意数量的 DNSHE 账户
- **多域名遍历**：自动获取账户下所有子域名并逐一续期
- **智能跳过**：仅对进入续期窗口（到期前180天）的域名执行操作
- **即时通知**：支持 Telegram Bot 和 PushPlus 双通道推送详细报告
- **结果分组**：按账号分组显示成功、跳过、失败的域名详情
- **安全合规**：密钥全部存储在 GitHub Secrets 中，代码零硬编码

## 🚀 快速开始

### 1. Fork 本仓库或直接添加文件
将 `renew.yml` 放入 `.github/workflows/` 目录，`renew.py` 放在仓库根目录。

### 2. 配置 Secrets
在仓库 `Settings > Secrets and variables > Actions` 中添加以下密钥：

| Secret 名称 | 必填 | 说明 |
| :--- | :--- | :--- |
| `DNSHE_ACCOUNTS` | ✅ | 账号列表，格式见下方 |
| `TELEGRAM_BOT_TOKEN` | ❌ | Telegram Bot 令牌 |
| `TELEGRAM_CHAT_ID` | ❌ | Telegram 接收消息的 Chat ID |
| `PUSHPLUS_TOKEN` | ❌ | PushPlus 令牌 (pushplus.plus) |

**`DNSHE_ACCOUNTS` 填写格式（超级简单）：**
账户名称:API_KEY:API_SECRET;账户名称2:API_KEY2:API_SECRET2

- 每个账户格式：`名称:API密钥:API Secret`
- 多个账户用英文分号 `;` 分隔
- 名称可以随意写（仅用于报告），不要包含英文冒号 `:`

**示例：**
个人账户:cfsd_xxxxxxxxxx:yyyyyyyyyyyyy;公司账户:cfsd_zzzzzzzzzz:aaaaaaaaaaaaa

将上述字符串直接填入 `DNSHE_ACCOUNTS` Secret 即可。

### 3. 启用 GitHub Actions
推送代码后，Actions 会自动启用。您也可以在 `Actions` 页面手动触发 `DNSHE Auto Renew` 工作流。

## 📅 执行计划
工作流默认每月 1 日 UTC 0:00 自动执行。您可修改 `.github/workflows/renew.yml` 中的 `cron` 表达式：
```yaml
on:
  schedule:
    - cron: '0 0 1 * *'   # 每月 1 日
