



# Context7-必装

Context7 MCP 能直接从信息源提取最新的、特定版本的文档和代码示例，并将其整合到你的提示中。

案例：

```
Create a React 18 project with the new createRoot API. use context7
Create a basic Next.js project with app router. use context7
```

安装：

https://smithery.ai/servers/upstash/context7-mcp



```
# claude-windows-cmd安装
claude mcp add context7 --scope project -- cmd /c npx -y @upstash/context7-mcp
```



# REA逆向工程

官方地址：https://github.com/morluto/rea/blob/main/README_zh.md

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

  智能体会自动调用 REA 的 MCP 工具（open_binary、search_strings、procedure_pseudo_code 等）完成调查。





# Fetch MCP



## 使用步骤

- 抓网页：输入 URL，Fetch 去把内容弄回来
- 转格式：把乱七八糟的 HTML 转成干净的 Markdown（还能支持其他格式，比如纯文本）
- 喂 LLM：把抓来的内容通过 MCP 接口丢给智能体处理

Github: https://github.com/modelcontextprotocol/servers/blob/main/src/fetch/README.md



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





