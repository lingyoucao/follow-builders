# 236 个 X 账号采集部署

已将 `config/x-account-catalog.json` 中的 226 个唯一账号与原有 26 个合并；重合 16 个，最终 236 个。原账号均保留。清单账号尚未逐个联网验证，首次采集报告会列出查询失败者。

## 自行配置 GitHub Actions

1. 将代码推送到你自己的 GitHub 仓库默认分支。
2. Settings → Secrets and variables → Actions → New repository secret，添加 `X_BEARER_TOKEN`。这是 X 官方 API 凭据；需要拥有相应端点访问权限和足够配额。仅运行 X 采集不需要播客 token。
3. Settings → Actions → General，启用 Actions，允许 workflow 写入仓库；分支保护也须允许提交。Fork 仓库还需启用定时 workflow。
4. Actions → Generate Feeds → Run workflow → 选择 `tweets-only`。
5. 查看 Summary 和 `reports/x-collection.json`，检查 completed、failed、incomplete、skipped。账号无新帖仍算完成；失败、分页未完成、因限流跳过都会使本轮标红，成功数据仍会先提交。
6. 当前每天 UTC 06:17（北京时间 14:17）自动采集 X。手动选 all 才会一起抓博客和播客，后者需要 `POD2TXT_API_KEY`。

定时运行可能延迟，不保证准点。仓库包含公开 feed 和采集数据；不要将 token 写入配置或提交文件。GitHub 推送冲突或分支保护阻止写入时需先处理仓库权限或同步分支后重新运行。

## 本地运行

```bash
cd scripts
npm ci
npm test
# 在当前进程环境中配置 X_BEARER_TOKEN 后运行；不要将真实 token 提交到 Git。
node generate-feed.js --tweets-only
node prepare-digest.js --feed-dir .. > /tmp/follow-builders-digest-input.json
```

`prepare-digest.js` 输出 LLM 所需的 JSON，不直接生成中文日报。现有 Agent 可继续使用这些输入进行摘要。日报使用 feed 生成时间前 24 小时的内容，周报使用前 7 天，避免把整个保留窗口每天重复送入摘要；feed 超过 36 小时未更新时输出提示。X feed 缺失时以非零退出码明确报错。

使用自己的远程公开 feed：

```bash
FEED_BASE_URL=https://raw.githubusercontent.com/OWNER/REPO/main node scripts/prepare-digest.js
```

默认远程地址已指向 `lingyoucao/follow-builders`，不会再读取原作者的 26 人 feed。本地 `--feed-dir` 优先于远程地址，且使用本仓库 prompts。远程模式的 prompts 默认从同一仓库读取，可用 `PROMPTS_BASE_URL` 单独指定。私有仓库建议 checkout 后使用本地模式。

## 数据与恢复

- `config/x-account-catalog.json`：可维护的 JSON 账号目录，包含 name、handle、url（X 主页链接）、category、focus、enabled。原 Markdown 仅作为调研存档，脚本不再读取它。
- `config/default-sources.json`：236 个账号；设置 `enabled: false` 可暂停个别账号。
- `feed-x.json`：按 tweet ID 去重、保留最近 7 天，兼容原摘要入口。
- `data/x/YYYY-MM-DD.json`：按采集日期（UTC）归档本次获取内容，不是推文发表日期；同日重复运行合并去重。
- `state-feed.json`：用户 ID 缓存、账号游标、未完成分页。内容落盘后才保存游标；崩溃重放通过 ID 去重。
- `reports/x-collection.json`：最近一次采集的覆盖情况。

每账号每页最多请求 100 条，默认每轮最多 3 页；超出部分下轮从保存的分页位置继续。分页临时失败时保留原窗口和分页位置；分页 token 失效时在原窗口内重新抓取；持续失败应检查报告。首次仅回溯 24 小时；后续使用 since_id。API 自身可访问历史范围仍有限制，不能保证无限补采。

可设置 `X_MAX_PAGES_PER_ACCOUNT`（正整数，默认 3）、`X_INITIAL_LOOKBACK_HOURS`（正数，默认 24）。采集串行，临时网络或 5xx 最多重试三次；遇 401、402 或 429 停止本轮后续账号，等待下轮。下轮优先处理上次阻塞的账号，避免末尾账号长期饥饿。长期限流应降低账号数量/频率或调整配额。

重新合并原始清单：`node scripts/import-x-accounts.js`。脚本默认读取固定路径 `config/x-account-catalog.json`，校验 JSON 结构、非空目录、handle 格式、重复账号、url 与 handle 的一致性和 enabled 类型；缺少 url 时自动生成 X 主页链接，数量可继续扩展，无须修改脚本。按大小写不敏感合并，补充分类和关注点，不删除已有账号或覆盖其配置。

自定义导入：`node scripts/import-x-accounts.js --source /path/catalog.json --config /path/sources.json`，相对路径按当前工作目录解析，支持从任意目录运行。目录格式：`{"schemaVersion":1,"accounts":[{"name":"示例","handle":"example","enabled":true}]}`。账号的真实有效性需联网验证。

本版每天采集一次，排除回复与转推。S/A/B 分级调度、完整 Thread、Reply 分析及 LLM 自动日报尚未实现。

## 已知边界

当前 236 个账号只有格式与合并校验，真实账号存在性、API 权限、配额和价格需配置凭据后验证。完整分页完成前不推进账号游标；写入使用临时文件加 rename，但多个输出文件不构成数据库事务。Actions 串行调度；不要同时从本地和 Actions 写同一仓库状态。API 历史范围限制仍可能影响长时间停机后的补采。

采集器保留旧版 tweet.fields / note_tweet 兼容路径；如果 X 明确返回字段不支持的 400 错误，会尝试新版 post.fields / note_post，并记录成功格式以供后续请求使用。响应兼容 retweet_count / repost_count。参数参照 [X 官方文档](https://docs.x.com/x-api/users/get-posts)，仍需真实 token 联调。
