"""Instant Math Evaluator and Quick System Actions for LocalMind."""
from __future__ import annotations

import math
import os
import re
import socket
import subprocess
from typing import Any

# Safe math functions mapping
_MATH_NAMES: dict[str, Any] = {
    "abs": abs,
    "round": round,
    "min": min,
    "max": max,
    "sum": sum,
    "pow": pow,
    "sqrt": math.sqrt,
    "sin": math.sin,
    "cos": math.cos,
    "tan": math.tan,
    "asin": math.asin,
    "acos": math.acos,
    "atan": math.atan,
    "sinh": math.sinh,
    "cosh": math.cosh,
    "tanh": math.tanh,
    "ceil": math.ceil,
    "floor": math.floor,
    "trunc": math.trunc,
    "log": math.log,
    "log10": math.log10,
    "log2": math.log2,
    "exp": math.exp,
    "pi": math.pi,
    "e": math.e,
    "tau": math.tau,
}


def _eval_math_expression(expr: str) -> str | None:
    """Safely evaluates basic mathematical expressions."""
    cleaned = expr.strip()
    # Check for percentage pattern like "20% of 500" or "15% of 80"
    pct_match = re.match(r"^(\d+(?:\.\d+)?)\s*%\s*(?:of|\*)\s*(\d+(?:\.\d+)?)$", cleaned, re.IGNORECASE)
    if pct_match:
        pct = float(pct_match.group(1))
        val = float(pct_match.group(2))
        res = (pct / 100.0) * val
        return f"{res:g}"

    # Hex to Dec (e.g. "0xff to dec" or "hex 255" or "0x1a")
    hex_match = re.match(r"^0x([0-9a-fA-F]+)$", cleaned)
    if hex_match:
        try:
            return str(int(cleaned, 16))
        except ValueError:
            pass

    # Check for valid math characters
    # Allowed: digits, ., +, -, *, /, %, ^, (, ), comma, spaces, and math func names
    if not re.match(r"^[0-9\.\+\-\*\/\%\^\(\)\,\s_a-zA-Z]+$", cleaned):
        return None

    # Must contain at least one operator or digit
    if not re.search(r"[0-9]", cleaned):
        return None

    # Replace ^ with ** for power
    py_expr = cleaned.replace("^", "**")

    # Reject dangerous keywords
    for bad in ("import", "exec", "eval", "os", "sys", "open", "read", "write", "lambda", "class", "def", "__"):
        if bad in py_expr.lower():
            return None

    # Only evaluate if it contains operators or known math names
    has_operator = any(op in py_expr for op in ("+", "-", "*", "/", "%", "**"))
    has_math_func = any(fn in py_expr for fn in _MATH_NAMES)
    if not has_operator and not has_math_func:
        return None

    try:
        # Compile code object in eval mode with strict whitelist
        code = compile(py_expr, "<string>", "eval")
        for name in code.co_names:
            if name not in _MATH_NAMES:
                return None

        result = eval(code, {"__builtins__": {}}, _MATH_NAMES)
        if isinstance(result, (int, float)):
            if math.isnan(result) or math.isinf(result):
                return None
            return f"{result:g}"
    except Exception:
        return None
    return None


def _get_local_ip() -> str:
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.settimeout(0.5)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return "127.0.0.1"


def evaluate_quick_query(query: str) -> list[dict]:
    """Check if query is a quick calculation or system command."""
    q = query.strip()
    if not q:
        return []

    results = []

    # 1. Math calculation
    math_res = _eval_math_expression(q)
    if math_res is not None:
        results.append({
            "fileName": f"= {math_res}",
            "filePath": math_res,
            "snippet": f"Calculation: {q} = {math_res}",
            "score": 1.0,
            "category": "calc",
            "action": "copy",
            "actionTitle": "Copy Result",
        })

    # 2. Quick System Commands
    q_lower = q.lower()
    system_commands = {
        "lock": {
            "title": "Lock Workstation",
            "desc": "Lock current Windows session (Win + L)",
            "cmd": "lock",
        },
        "sleep": {
            "title": "Sleep PC",
            "desc": "Put computer into sleep mode",
            "cmd": "sleep",
        },
        "restart": {
            "title": "Restart Computer",
            "desc": "Reboot Windows operating system",
            "cmd": "restart",
        },
        "shutdown": {
            "title": "Shut Down Computer",
            "desc": "Turn off Windows computer",
            "cmd": "shutdown",
        },
        "empty trash": {
            "title": "Empty Recycle Bin",
            "desc": "Permanently delete items in Recycle Bin",
            "cmd": "empty_trash",
        },
        "recycle bin": {
            "title": "Empty Recycle Bin",
            "desc": "Permanently delete items in Recycle Bin",
            "cmd": "empty_trash",
        },
        "calc": {
            "title": "Calculator",
            "desc": "Open Windows Calculator",
            "cmd": "calc",
            "category": "app",
            "action": "open",
            "actionTitle": "Open Calculator",
        },
        "calculator": {
            "title": "Calculator",
            "desc": "Open Windows Calculator",
            "cmd": "calc",
            "category": "app",
            "action": "open",
            "actionTitle": "Open Calculator",
        },
        "ip": {
            "title": f"Local IP: {_get_local_ip()}",
            "desc": "Copy your local network IPv4 address",
            "cmd": _get_local_ip(),
            "action": "copy",
            "actionTitle": "Copy IP Address",
        },
        "my ip": {
            "title": f"Local IP: {_get_local_ip()}",
            "desc": "Copy your local network IPv4 address",
            "cmd": _get_local_ip(),
            "action": "copy",
            "actionTitle": "Copy IP Address",
        },
    }

    for key, info in system_commands.items():
        if q_lower == key or (len(q_lower) >= 3 and key.startswith(q_lower)):
            results.append({
                "fileName": info["title"],
                "filePath": info["cmd"],
                "snippet": info["desc"],
                "score": 0.98 if q_lower == key else 0.85,
                "category": info.get("category", "action"),
                "action": info.get("action", "system_command"),
                "actionTitle": info.get("actionTitle", "Execute Action" if info.get("action") != "copy" else "Copy IP Address"),
            })

    return results
