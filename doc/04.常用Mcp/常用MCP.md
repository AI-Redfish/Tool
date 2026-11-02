# Context7-必装

Context7 MCP 能直接从信息源提取最新的、特定版本的文档和代码示例，并将其整合到你的提示中。

案例：

```
Create a React 18 project with the new createRoot API. use context7
Create a basic Next.js project with app router. use context7
```

安装：

<https://smithery.ai/servers/upstash/context7-mcp>

```
# claude-windows-cmd安装
claude mcp add context7 --scope project -- cmd /c npx -y @upstash/context7-mcp
```

# REA逆向工程

官方地址：<https://github.com/morluto/rea/blob/main/README_zh.md>

一个让 AI 智能体做逆向工程的工具集。没有源码时，智能体可以用它分析原生二进制、Electron/JS 应用、.NET程序集和网站，解释功能

如何工作，然后帮你复刻。

例如你自己需要开发一个Agent工具，用来让AI分期其他Agent工具然后复刻部分功能非常有用。

**使用步骤**

1，安装（需要 Node.js 22.19+ / 24.11+ / 26）

```
npm install --global rea-agents
rea setup
```

setup 会引导你：选择要连接的智能体（Claude Code、Cursor、Codex 等）→ 自动写入 MCP 配置 → 可选连接已安装Ghidra/Hopper。

2，重启智能体后直接提问

```
逆向工程"备忘录"应用，找到离线搜索功能的工作方式，
解释其控制流，并为我的项目实现一个版本。
```

智能体会自动调用 REA 的 MCP 工具（open\_binary、search\_strings、procedure\_pseudo\_code 等）完成调查。

# BLA

针对REA的软件保护措施。

**官方地址**

<https://github.com/qybaihe/bla/blob/main/docs/readme/README_zh.md>

<br />

<br />

# treg

treg 搭建了一个统一的目录，让 Agent 通过**单一的地址和 Token**，就能调用来自数十家供应商的数千个接口，并按实际调用次数计费。

支持本地部署。

| **类别**        | **具体涵盖的工具/数据**                                            | **典型应用场景举例**                                   |
| :------------ | :-------------------------------------------------------- | :--------------------------------------------- |
| **SEO 与搜索数据** | 关键词与排名追踪、外链与网站权威度、SERP 数据、AI 可见性                          | 查询某个域名的外链情况；分析关键词的搜索量                          |
| **社交与趋势**     | 社交资料与趋势、帖子抓取、广告库                                          | 获取 TikTok 用户资料；搜索 Reddit 帖子；查看竞品在 Facebook 的广告 |
| **人物与公司信息**   | 公司 firmographics、技术栈、融资信息、工作邮箱查找                          | 通过域名丰富公司信息；根据姓名查找工作邮箱                          |
| **广告与营销**     | 广告库、广告活动管理、广告创意                                           | 分析竞争对手的广告投放策略                                  |
| **网页数据抓取**    | 将网页内容提取为 Markdown 格式                                      | 抓取并总结指定网页的内容                                   |
| **内容生成**      | 图像、视频、语音、音乐生成（如 Seedance, Gemini Image, GPT Image, Veo 等） | 根据文本提示生成图片或视频                                  |
| **测量与分析**     | Google Analytics、Search Console、Business Profile          | 获取网站的流量分析数据                                    |

# Fetch MCP

## 使用步骤

* 抓网页：输入 URL，Fetch 去把内容弄回来

* 转格式：把乱七八糟的 HTML 转成干净的 Markdown（还能支持其他格式，比如纯文本）

* 喂 LLM：把抓来的内容通过 MCP 接口丢给智能体处理

Github: <https://github.com/modelcontextprotocol/servers/blob/main/src/fetch/README.md>

**使用**

```

windows
"fetch": {
      "command": "cmd",
      "args": [
        "/c",
        "uvx",
        "mcp-server-fetch"
      ]
    }
    
    
  
```

## 使用案例

**抓取网页并分析**

```
use MCP：fetch

获取: https://github.com/modelcontextprotocol/servers/ 
分析里面的内容。
```

# drawio

相比于让AI 直接生成html等方式，drawio这个mcp输出的文件可以二次编辑。

解决了如果AI输出不准确，人工可以接入的场景。

## 安装

**windows**

```
"drawio": {
      "command": "cmd",
      "args": [
        "/c",
        "npx",
        "-y",
        "@next-ai-drawio/mcp-server@latest"
      ]
    }
```

**使用**

```
1，使用MCP： drawio
帮我创建一个sso流程图
```

# 高德MCPServer

# Excel MCP Server

用语言控制Excel。
