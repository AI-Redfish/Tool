#!/usr/bin/env python3
"""jev-desktop 的 CLI 适配器：argparse 子命令从 core.TOOLS 元数据自动生成（server-py 同模式）。

用法：
  python cli.py list
  python cli.py doctor [--with-network]
  python cli.py windows
  python cli.py snapshot --app 记事本 [--level uia|ocr|vlm] [--root @id:eN]
  python cli.py act click --target @s1a2b3c4:e5        （target 等复杂参数支持内联 JSON 或 @file）
  python cli.py execute --file examples/console.flow.json
  python cli.py run "..." --app 记事本 --success-criteria '["记事本标题包含 hello"]'

全局参数：--config / --json / --dry-run / --session / --timeout（任意位置可用）
退出码：0 done；2 参数/配置错误；4 failed；130 cancelled
"""

import argparse
import json
import os
import signal
import sys

from core import SERVER_NAME, SERVER_VERSION, TOOLS, get_tool
from core import api as core_api

# Windows 控制台默认 GBK，统一 UTF-8，避免中文乱码（server-py 已验证此做法）
for stream in (sys.stdout, sys.stderr):
    if hasattr(stream, "reconfigure"):
        stream.reconfigure(encoding="utf-8")

_CANCEL_EVENT = None


def _sigint_handler(signum, frame):
    if _CANCEL_EVENT is not None:
        _CANCEL_EVENT.set()
        print(f"[{SERVER_NAME}] 收到 Ctrl+C：正在协作取消（当前步骤完成后返回）…", file=sys.stderr)


def _parse_complex(value: str, *, allow_ref: bool = False):
    """object/array 参数：内联 JSON 或 @file/路径 引用 JSON 文件；
    allow_ref 时（target 参数）兼容 @<快照id>:eN 的 ref 字符串。"""
    def _fail(msg):
        print(f"[{SERVER_NAME}-cli] {msg}", file=sys.stderr)
        sys.exit(2)
    raw = value[1:] if value.startswith("@") else value
    if value.startswith("@") and os.path.isfile(raw):
        try:
            with open(raw, "r", encoding="utf-8-sig") as f:
                return json.load(f)
        except (OSError, ValueError) as e:
            _fail(f"读取 JSON 失败 {raw}: {e}")
    if raw.lower().endswith(".json"):
        try:
            with open(raw, "r", encoding="utf-8-sig") as f:
                return json.load(f)
        except (OSError, ValueError) as e:
            _fail(f"读取 JSON 失败 {raw}: {e}")
    try:
        return json.loads(value)
    except ValueError:
        if allow_ref and value.startswith("@"):
            return value  # ref 字符串（@<快照id>:eN），交由 TargetSpec 校验
        _fail(f"参数不是合法 JSON，且不是 .json 文件路径: {value[:80]}")


def _add_global_args(p: argparse.ArgumentParser, *, for_sub: bool) -> None:
    """全局参数同时挂在主解析器与子命令（任意位置可用）；for_sub 用 SUPPRESS 默认值，
    避免子命令未提供时覆盖主解析器已解析的值。"""
    kw = dict(default=argparse.SUPPRESS) if for_sub else {}
    # 注意：argparse 会把 help 当格式串做 % 插值，字面 % 必须写成 %%
    p.add_argument("--config", **kw,
                   help=r"配置文件路径（默认 %%LOCALAPPDATA%%\AI-Redfish\jev-desktop\config.json）")
    p.add_argument("--json", action="store_true", **kw, help="禁交互，输出纯 envelope JSON")
    p.add_argument("--dry-run", dest="dry_run", action="store_true", **kw,
                   help="只观察/解析目标，不执行动作")
    p.add_argument("--session", **kw, help="会话 id（默认 default；ref 跨命令复用）")
    p.add_argument("--timeout", type=int, **kw, help="run 超时毫秒（只可缩短全局默认）")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog=f"{SERVER_NAME}-cli",
        description=f"{SERVER_NAME} CLI（v{SERVER_VERSION}）— Windows 桌面软件控制（UIA + Jev + 规划 LLM）",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="示例：\n"
               "  python cli.py snapshot --app 记事本\n"
               "  python cli.py act click --target @<快照id>:e5\n"
               "  python cli.py execute --file examples/console.flow.json\n"
               '  python cli.py run "在记事本里写 hello 并保存" --app 记事本\n',
    )
    parser.add_argument("--version", action="version", version=f"{SERVER_NAME}-cli v{SERVER_VERSION}")
    _add_global_args(parser, for_sub=False)
    sub = parser.add_subparsers(dest="tool")

    for tool in TOOLS:
        short = tool["name"].removeprefix("desktop_")  # DESIGN §10.2：子命令与 MCP 工具一一对应
        sp = sub.add_parser(short, help=tool["description"], aliases=[tool["name"]],
                            formatter_class=argparse.RawDescriptionHelpFormatter)
        _add_global_args(sp, for_sub=True)
        for p in tool["params"]:
            name = p["name"]
            if name in ("session", "dry_run", "success_criteria", "stop_on_error"):
                continue  # 已由全局参数/专用旗标覆盖（同 dest），避免重复
            t = p["type"]
            flag = f"--{name.replace('_', '-')}"  # 惯例：旗标用连字符
            aliases_flag = [flag, f"--{name}"] if "_" in name else [flag]
            if t in ("object", "array"):
                sp.add_argument(*aliases_flag, dest=name, metavar="JSON|@file",
                                help=p["description"] + "（内联 JSON 或 @文件路径）")
            elif t == "boolean":
                sp.add_argument(*aliases_flag, dest=name, action="store_true",
                                help=p["description"] + "（旗标，出现即 true）")
            elif t == "integer":
                sp.add_argument(*aliases_flag, dest=name, type=int, help=p["description"])
            elif t == "number":
                sp.add_argument(*aliases_flag, dest=name, type=float, help=p["description"])
            else:
                sp.add_argument(*aliases_flag, dest=name, help=p["description"])
        # 便捷别名/位置式参数
        # 便捷别名/位置式参数
        if tool["name"] == "desktop_execute":
            sp.add_argument("--file", dest="steps", metavar="JSON|@file",
                            help="（别名）FlowStep JSON 文件，等价 --steps @file")
            sp.add_argument("--continue-on-error", dest="stop_on_error", action="store_false",
                            help="步骤失败时继续执行后续步骤（默认失败即停）")
        if tool["name"] == "desktop_act":
            sp.add_argument("action_pos", nargs="?", help="（位置式）action 名，如 click/press/type")
            sp.add_argument("value_pos", nargs="?", help="（位置式）value，如 ctrl+s 或要输入的文本")
        if tool["name"] == "desktop_run":
            sp.add_argument("goal_pos", nargs="?", help="（位置式）目标")
            sp.add_argument("--success-criteria", dest="success_criteria", metavar="JSON|@file",
                            help='验收条件数组 JSON，如 \'["记事本标题包含 hello"]\'')
    sub.add_parser("list", help="列出所有可用工具")
    return parser


def print_tools() -> None:
    print(f"[{SERVER_NAME}] 可用工具（v{SERVER_VERSION}）：")
    for t in TOOLS:
        print(f"  - {t['name']:<20} {t['description'].split('。')[0]}")
    print("\n全局参数：--config / --json / --dry-run / --session / --timeout；帮助：<子命令> -h")


def _collect_args(tool: dict, ns) -> dict:
    args: dict = {}
    for p in tool["params"]:
        v = getattr(ns, p["name"], None)
        if v is None:
            continue
        if p["type"] == "boolean" and v is False:
            continue  # store_true 旗标缺省即为 False：不注入，保留 core 侧默认值
        if p["type"] in ("object", "array") and isinstance(v, str):
            v = _parse_complex(v, allow_ref=(p["name"] == "target"))
        args[p["name"]] = v
    if tool["name"] == "desktop_execute":
        args["stop_on_error"] = bool(getattr(ns, "stop_on_error", True))
    # 位置式兼容
    if tool["name"] == "desktop_act":
        if getattr(ns, "action_pos", None):
            args.setdefault("action", ns.action_pos)
        if getattr(ns, "value_pos", None) is not None and "value" not in args:
            args["value"] = ns.value_pos
        if "action" not in args:
            print(f"[{SERVER_NAME}-cli] act 缺少 action（可位置式或 --action）", file=sys.stderr)
            sys.exit(2)
    if tool["name"] == "desktop_run":
        if getattr(ns, "goal_pos", None):
            args.setdefault("goal", ns.goal_pos)
        sc = getattr(ns, "success_criteria", None)
        if sc is not None:
            args["success_criteria"] = _parse_complex(sc) if isinstance(sc, str) else sc
    # --file 传入完整 flow 对象时拆包：取 steps，并允许 flow 级 app/title/window_id 作为窗口范围
    if tool["name"] == "desktop_execute" and isinstance(args.get("steps"), dict):
        flow = args["steps"]
        if isinstance(flow.get("steps"), list):
            for k in ("app", "title", "window_id"):
                if k in flow and k not in args:
                    args[k] = flow[k]
            args["steps"] = flow["steps"]
    return args


def _print_human(env: dict) -> None:
    """人读输出：状态 + 结果摘要；详细 JSON 随时可用 --json。"""
    status = env.get("status")
    icon = {"done": "✔", "failed": "✘", "cancelled": "⏹"}.get(status, "?")
    print(f"{icon} 状态: {status}   (耗时 {env.get('metrics', {}).get('elapsedMs', '?')}ms)")
    result = env.get("result")
    if isinstance(result, dict):
        if "windows" in result:
            for w in result["windows"]:
                fg = " [前台]" if w.get("foreground") else ""
                print(f"  [{w['id']:<8}] {w['process'] or '?':<22} {w['title'][:60]}{fg}")
            if not result["windows"]:
                print("  （无可见顶层窗口）")
        elif "snapshotId" in result:
            print(result.get("text") or "")
            if result.get("image"):
                print(f"[截图] {result['image']}")
            refs = result.get("refs") or []
            if refs:
                print(f"[refs] 共 {len(refs)} 个；示例: {refs[0]['ref']}")
        elif "path" in result:
            print(f"  截图: {result['path']} ({result.get('width')}x{result.get('height')})")
        elif "checks" in result:
            for c in result["checks"]:
                mark = "✔" if c["ok"] else "✘"
                print(f"  {mark} {c['name']:<14} {c['detail'][:110]}")
        elif "steps" in result:
            for s in result["steps"]:
                mark = "✔" if s.get("ok") else "✘"
                desc = s.get("act") or s.get("kind") or s.get("op") or ""
                extra = s.get("target") or s.get("detail") or ""
                if isinstance(s.get("error"), dict):
                    extra = f"[{s['error'].get('code')}] {s['error'].get('message', '')[:80]}"
                print(f"  {mark} {s.get('id')}: {desc}  {str(extra)[:90]}")
        elif "op" in result:
            print(result.get("text") if result.get("text") else "（剪贴板为空）")
        else:
            print(json.dumps(result, ensure_ascii=False, indent=2)[:3000])
    elif isinstance(result, str):
        print(f"  {result}")
    err = env.get("error")
    if err:
        print(f"  错误 [{err.get('code')}]: {err.get('message')}", file=sys.stderr)
        details = err.get("details")
        if details:
            print("  " + json.dumps(details, ensure_ascii=False)[:1200], file=sys.stderr)
    metrics = env.get("metrics") or {}
    extras = []
    for k in ("jevRequests", "plannerRequests", "actions"):
        if metrics.get(k):
            extras.append(f"{k}={metrics[k]}")
    tok = metrics.get("tokens") or {}
    if tok.get("input") or tok.get("output"):
        extras.append(f"tokens={tok.get('input')}/{tok.get('output')}")
    if extras:
        print("  [" + " ".join(extras) + "]")


def main() -> None:
    ns = build_parser().parse_args()
    if not ns.tool or ns.tool == "list":
        print_tools()
        return
    tool = get_tool(ns.tool) or get_tool("desktop_" + ns.tool)
    if tool is None:
        print(f"[{SERVER_NAME}-cli] 未知工具 {ns.tool}", file=sys.stderr)
        sys.exit(2)
    args = _collect_args(tool, ns)

    global _CANCEL_EVENT
    _CANCEL_EVENT = core_api.register_cancel(f"cli:{ns.tool}:{id(args)}")
    try:
        signal.signal(signal.SIGINT, _sigint_handler)
    except ValueError:
        pass  # 非 main 线程环境

    env_out = core_api.run_tool(
        tool["name"], args,
        config_file=getattr(ns, "config", None), session_id=getattr(ns, "session", None),
        dry_run=bool(getattr(ns, "dry_run", False)), timeout_ms=getattr(ns, "timeout", None),
        cancel=_CANCEL_EVENT, return_image=False,
    )
    if getattr(ns, "json", False):
        print(json.dumps(env_out, ensure_ascii=False, indent=2))
    else:
        _print_human(env_out)

    status = env_out.get("status")
    if status == "done":
        sys.exit(0)
    if status == "cancelled":
        sys.exit(130)
    code = (env_out.get("error") or {}).get("code", "")
    sys.exit(2 if code in ("INVALID_PARAMS", "CONFIG_INVALID", "INVALID_STEP") else 4)


if __name__ == "__main__":
    main()
