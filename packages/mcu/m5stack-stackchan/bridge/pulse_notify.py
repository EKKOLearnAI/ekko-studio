#!/usr/bin/env python3
"""Send one task notice to the paired Pulse StackChan (firmware 2.8+). Stdlib only.

    pulse_notify.py done "周报写好了"
    pulse_notify.py failed "构建失败" --id build-1042
    pulse_notify.py remind "三点开会"
    pulse_notify.py praise "今天写了好多代码"
    pulse_notify.py --status

The robot plays the notice when it sees you (a soft "ding-dong" first if it
does not; lights only at night); touching it means "got it". Success here only
means the robot queued the notice, not that you have seen it.

Reads the same owner-only (0600) pulse-connection.json as pulse_mcp.py. Never
prints the device token, never follows redirects, ignores proxy settings and
only talks to a local-network endpoint.

Exit codes: 0 queued/duplicate, 2 usage, 3 connection file, 4 device refused
(task notices off, too many, invalid, old firmware), 5 network error/timeout.
"""
from __future__ import annotations

import argparse
import ipaddress
import json
import os
from pathlib import Path
import re
import stat
import sys
import urllib.error
import urllib.request
from urllib.parse import urlsplit

DEFAULT_CONNECTION = Path.home() / ".hermes/profiles/stackchan/pulse-connection.json"
KINDS = {"done": "task_done", "task_done": "task_done", "ok": "task_done", "success": "task_done",
         "failed": "task_failed", "fail": "task_failed", "error": "task_failed", "task_failed": "task_failed",
         "remind": "reminder", "reminder": "reminder",
         "praise": "praise"}
NAMES = {"task_done": "任务完成", "task_failed": "任务没成功", "reminder": "提醒", "praise": "夸夸"}
REFUSED = {
    400: "提醒内容无效（id 最多 40 个字母 / 数字 / ._:-）",
    403: "设备凭据不对（重新配对后更新 pulse-connection.json）",
    404: "设备固件不支持任务提醒（需要 2.8 陪伴版或更新）",
    409: "机器人上的「任务提醒」关着（设置 → 任务提醒，或串口 notify on）",
    429: "提醒太频繁（设备每分钟最多收 20 条）",
    503: "设备固件不支持任务提醒（需要 2.8 陪伴版或更新）",
}


class Refused(Exception):
    pass


class BadConnection(Exception):
    pass


def load_connection(path: Path) -> tuple[str, str]:
    """Same rules as pulse_mcp.load_connection; errors never include the token."""
    try:
        fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
        with os.fdopen(fd, "rb") as handle:
            info = os.fstat(handle.fileno())
            if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid()
                    or stat.S_IMODE(info.st_mode) != 0o600 or info.st_size > 4096):
                raise ValueError("private file required")
            content = handle.read(4097)
        if len(content) > 4096:
            raise ValueError("oversized")
        data = json.loads(content)
        endpoint, token = data["endpoint"], data["control_token"]
        if not isinstance(endpoint, str) or not isinstance(token, str):
            raise ValueError("fields")
        parsed = urlsplit(endpoint)
        if (parsed.scheme not in {"http", "https"} or not parsed.hostname
                or parsed.username or parsed.password or parsed.query or parsed.fragment
                or parsed.path not in {"", "/"}):
            raise ValueError("endpoint")
        if parsed.port is not None and not 1 <= parsed.port <= 65535:
            raise ValueError("port")
        try:
            address = ipaddress.ip_address(parsed.hostname)
            local = address.is_private or address.is_loopback or address.is_link_local
        except ValueError:
            local = parsed.hostname == "localhost" or parsed.hostname.endswith(".local")
        if not local or not re.fullmatch(r"[0-9a-fA-F]{64}", token):
            raise ValueError("local endpoint and token required")
        return endpoint.rstrip("/"), token
    except (OSError, ValueError, KeyError, TypeError):
        raise BadConnection() from None


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # never forward the token
        return None


def _opener():
    return urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirect())


def call(endpoint: str, token: str, method: str, path: str, body: dict | None, timeout: float) -> tuple[int, dict]:
    data = None if body is None else json.dumps(body, ensure_ascii=False).encode("utf-8")
    request = urllib.request.Request(endpoint + path, data=data, method=method, headers={
        "Authorization": "Bearer " + token, "Content-Type": "application/json", "Accept": "application/json"})
    try:
        with _opener().open(request, timeout=timeout) as response:
            code, raw = response.status, response.read(65537)
    except urllib.error.HTTPError as error:
        code, raw = error.code, b""
        try:
            raw = error.read(4097)
        except OSError:
            pass
        finally:
            error.close()
    if len(raw) > 65536:
        raise ValueError("oversized response")
    try:
        document = json.loads(raw.decode("utf-8")) if raw else {}
    except (UnicodeDecodeError, ValueError):
        document = {}
    if not isinstance(document, dict):
        document = {}
    return code, document


def notify(endpoint: str, token: str, kind: str, title: str, source: str, notice_id: str | None,
           timeout: float) -> dict:
    body = {"kind": kind, "title": title, "source": source}
    if notice_id:
        body["id"] = notice_id
    code, document = call(endpoint, token, "POST", "/api/notify", body, timeout)
    if code in REFUSED:
        raise Refused(REFUSED[code])
    if code not in (200, 202) or document.get("ok") is not True or document.get("status") not in {
            "queued", "replaced", "duplicate"}:
        raise Refused(f"设备没有确认收到（HTTP {code}）")
    return document


def _text_problem(value: str, limit_bytes: int, what: str) -> str | None:
    if any(ord(c) < 32 or ord(c) == 127 for c in value):
        return f"{what}不能包含控制字符"
    if len(value.encode("utf-8")) > limit_bytes:
        return f"{what}太长（最多 {limit_bytes} 字节）"
    return None


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="给 Pulse StackChan 送一条任务提醒（2.8+）")
    parser.add_argument("kind", nargs="?", help="done / failed / remind / praise")
    parser.add_argument("title", nargs="*", help="很短的标题，例如「周报写好了」（设备只显示一行，超过 64 字节会截断）")
    parser.add_argument("--id", dest="notice_id", help="同一件事用同一个 id，防止重复提醒（1–40 个字母 / 数字 / ._:-）")
    parser.add_argument("--source", default="Ekko Studio", help="来源（最多 24 字节，默认 Ekko Studio）")
    parser.add_argument("--connection", type=Path,
                        default=Path(os.environ.get("PULSE_CONNECTION_FILE", str(DEFAULT_CONNECTION))).expanduser())
    parser.add_argument("--timeout", type=float, default=5.0)
    parser.add_argument("--status", action="store_true", help="看看机器人的关心提醒 / 任务提醒状态")
    parser.add_argument("--quiet", action="store_true")
    args = parser.parse_args(argv)
    if not 0.5 <= args.timeout <= 30:
        parser.error("--timeout 须在 0.5–30 秒之间")
    if not args.status:
        if not args.kind or args.kind.lower() not in KINDS:
            parser.error("种类须为 done / failed / remind / praise")
        if args.notice_id is not None and not re.fullmatch(r"[A-Za-z0-9._:-]{1,40}", args.notice_id):
            parser.error("--id 须为 1–40 个字母 / 数字 / ._:-")
        title, source = " ".join(args.title).strip(), args.source.strip()
        problem = _text_problem(title, 512, "标题") or _text_problem(source, 24, "来源")
        if problem:
            parser.error(problem)
    try:
        endpoint, token = load_connection(args.connection)
    except BadConnection:
        print("设备连接文件缺失或无效（需要所有者持有的 0600 私有 JSON：endpoint + control_token）", file=sys.stderr)
        return 3
    try:
        if args.status:
            code, state = call(endpoint, token, "GET", "/api/status", None, args.timeout)
            if code != 200 or state.get("ok") is not True:
                print(f"设备没有返回状态（HTTP {code}）", file=sys.stderr)
                return 4
            out = {"version": state.get("version"), "care": state.get("care"), "notify": state.get("notify")}
            print(json.dumps(out, ensure_ascii=False, indent=2).replace(token, "[redacted]"))
            return 0
        kind = KINDS[args.kind.lower()]
        result = notify(endpoint, token, kind, title, source, args.notice_id, args.timeout)
    except Refused as refused:
        print(f"没有送出：{refused}", file=sys.stderr)
        return 4
    except (urllib.error.URLError, OSError, ValueError):
        # Never print the exception: it can include the request URL or headers.
        print("连不上机器人（超时或网络错误）；结果未知，没有自动重试", file=sys.stderr)
        return 5
    if not args.quiet:
        status = result.get("status")
        note = {"queued": "已送到", "replaced": "已送到（队列满了，挤掉了一条最旧的）", "duplicate": "这条之前已经送过了"}[status]
        extra = "（标题太长，已截断）" if result.get("truncated") is True else ""
        shown = f"「{title}」" if title else ""
        print(f"{note} StackChan：{NAMES[kind]}{shown}{extra}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
