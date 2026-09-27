# jev-browser 示例

无敏感信息的配置与流程示例。运行方式见 [../README.md](../README.md)，契约定义见 [../DESIGN.md](../DESIGN.md) §8。

| 文件 | 说明 |
| --- | --- |
| `read-page.flow.json` | 最小确定性流程：导航 → 提取标题 → 代码断言 → 截图（`execute` 用，模型调用为 0） |
| `config.attach-chrome.json` | 默认配置形态：接管日常 Chrome（有头），授权 `https://example.com`，云模型可见域同源 |
| `config.chromium-headless.json` | 切换为工具管理的无头 Chromium；`userDataDir` 为相对路径时按配置文件所在目录解析 |

使用示意（需先 `pnpm build` 构建）：

```powershell
# 诊断（不连接浏览器）
node cli/dist/index.js doctor --config examples/config.attach-chrome.json

# 执行确定性流程（attach 模式需要 Chrome ≥ 144 已在 chrome://inspect/#remote-debugging 授权）
node cli/dist/index.js execute --file examples/read-page.flow.json --origin "https://example.com"
```

注意：

- 纯确定性 `execute` 不需要任何模型 key；`run` 需要配置 planner 与 Jev key。
- `modelOrigins` 为空（默认）时禁止任何页面数据外发云模型；`snapshot --for-model` 与 goal 步骤会因此暂停/拒绝。
- 高风险动作（支付/删除/发送等目标名命中启发式 pattern）一律返回 `paused + needs_confirmation`，等待独立审批 grant（`grant create` → `task approve` → `task resume`）。
