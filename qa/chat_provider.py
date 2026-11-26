"""Deterministic OpenAI-compatible HTTP test provider for Folio's real Peri agent.

The fixture never receives a browser handle or a database connection. Its only
outputs are streaming assistant text and normal OpenAI function tool calls.
"""

from contextlib import contextmanager
from chat_endpoint import completion_endpoint
import json
import secrets
import threading

CREATE_PROMPT = "请在画布左侧添加一张蓝色便签，写上「设备同步检查」。"
UPDATE_PROMPT = "请读一下刚才的画布，再把那张便签改成「同步验证完成」。"
CANCEL_PROMPT = "请稍候再回答，我会按停止。"
DENIED_PROMPT = "尝试在当前只读画板添加一张写着「只读检查」的便签。"
READ_PROMPT = "请告诉我当前画板上的便签内容。"
FAIL_PROMPT = "测试模型服务暂时拒绝请求时如何显示错误。"
CREATED = "已添加「设备同步检查」便签。"
UPDATED = "已把便签改为「同步验证完成」。"
READ = "我在共享画板读到了「同步验证完成」。"
DENIED = "当前会话只有查看权限，画布没有改动。"
COLOR = "#2986d6"
MODEL = "folio-regression-model"


def as_text(value):
    if isinstance(value, str):
        return value
    return json.dumps(value, ensure_ascii=False)


class Scenario:
    def __init__(self):
        self.key = "test-only-" + secrets.token_urlsafe(18)
        self.read_ids = []
        self.turns = []
        self.errors = []
        self.create_acks = 0
        self.update_acks = 0
        self.failed_requests = 0
        self.denial_acks = 0
        self.read_acks = 0
        self.cancel_started = threading.Event()
        self.release = threading.Event()
        self.lock = threading.RLock()

    @staticmethod
    def _tool(tools, suffix):
        for name in tools:
            if name == suffix or name.endswith(suffix):
                return name
        raise ValueError(f"model did not receive {suffix}; advertised tools: {tools!r}")

    @staticmethod
    def _read_json(text):
        """JSON tool results can be wrapped in MCP's text content blocks."""

        def visit(node):
            if isinstance(node, str):
                try:
                    yield from visit(json.loads(node))
                except (ValueError, TypeError):
                    pass
            elif isinstance(node, list):
                for item in node:
                    yield from visit(item)
            elif isinstance(node, dict):
                yield node
                for entry in node.values():
                    yield from visit(entry)

        return list(visit(text))

    def next(self, req, authenticated):
        with self.lock:
            messages = req.get("messages", [])
            prompts = [
                CREATE_PROMPT,
                UPDATE_PROMPT,
                CANCEL_PROMPT,
                DENIED_PROMPT,
                READ_PROMPT,
                FAIL_PROMPT,
            ]
            matches = [
                (i, prompt)
                for i, message in enumerate(messages)
                for prompt in prompts
                if message.get("role") == "user" and prompt in as_text(message["content"])
            ]
            assert matches, "provider received no matching user request"
            last_user, prompt = matches[-1]
            tools = tuple(t.get("function", {}).get("name") for t in req.get("tools", []))
            recent = messages[last_user + 1 :]
            call_names = {
                call.get("id"): call.get("function", {}).get("name")
                for message in recent
                for call in message.get("tool_calls") or []
            }
            responses = [m for m in recent if m.get("role") == "tool"]
            replies = [
                m for m in responses if call_names.get(m.get("tool_call_id")) != "SearchExtraTools"
            ]

            def canvas(name, args):
                if "ExecuteExtraTool" in tools:
                    return "tool", (
                        "ExecuteExtraTool",
                        {"tool_name": "mcp__canvas__" + name, "params": args},
                    )
                return "tool", (self._tool(tools, name), args)

            previous = [m for m in messages[:last_user] if m.get("role") in ("user", "assistant")]
            turn = {
                "scenario": prompts.index(prompt),
                "authenticated": authenticated,
                "modelMatched": req.get("model") == MODEL,
                "advertised": list(tools),
                "resultCount": len(replies),
                "historyPresent": any(CREATE_PROMPT in as_text(m.get("content")) for m in previous),
            }
            self.turns.append(turn)
            assert (
                authenticated and turn["modelMatched"]
            ), "provider key/model configuration mismatch"
            if prompt == FAIL_PROMPT:
                self.failed_requests += 1
                return "error", 401
            if prompt == CANCEL_PROMPT:
                self.cancel_started.set()
                return "slow", None
            if "SearchExtraTools" in tools and not responses:
                target = (
                    "canvas_create" if prompt in (CREATE_PROMPT, DENIED_PROMPT) else "canvas_read"
                )
                return "tool", ("SearchExtraTools", {"query": target})
            if prompt == CREATE_PROMPT:
                if not replies:
                    return canvas(
                        "canvas_create",
                        {
                            "objects": [
                                {
                                    "kind": "note",
                                    "text": "设备同步检查",
                                    "x": 285,
                                    "y": 218,
                                    "color": COLOR,
                                }
                            ]
                        },
                    )
                body = as_text(replies[-1].get("content"))
                assert (
                    "设备同步检查" in body or '"created"' in body
                ), "no successful create result reached the model"
                self.create_acks += 1
                return "text", CREATED
            if prompt == DENIED_PROMPT:
                names = [name for name in tools if name.endswith("canvas_create")]
                if (names or "ExecuteExtraTool" in tools) and not replies:
                    return canvas(
                        "canvas_create",
                        {
                            "objects": [
                                {
                                    "kind": "note",
                                    "text": "只读检查",
                                    "x": 200,
                                    "y": 200,
                                    "color": COLOR,
                                }
                            ]
                        },
                    )
                if replies:
                    error_msg = as_text(replies[-1]["content"]).lower()
                    assert any(
                        word in error_msg
                        for word in (
                            "read-only",
                            "readonly",
                            "forbid",
                            "permission",
                            "not allowed",
                            "not available",
                            "denied",
                            "not found",
                            "unknown tool",
                            "read_only",
                            "只读",
                            "权限",
                        )
                    ), "write result was not a permission denial"
                self.denial_acks += 1
                return "text", DENIED
            if not replies:
                return canvas("canvas_read", {"scope": "all"})
            body = as_text(replies[-1]["content"])
            if prompt == READ_PROMPT:
                assert "同步验证完成" in body, "read result did not contain the rendered note"
                self.read_acks += 1
                return "text", READ
            if len(replies) == 1:
                records = self._read_json(replies[0]["content"])
                target = next(
                    (
                        o
                        for o in records
                        if o.get("text") == "设备同步检查" and isinstance(o.get("id"), str)
                    ),
                    None,
                )
                assert target, "could not find created note and real ID in MCP read result"
                self.read_ids.append(target["id"])
                return canvas(
                    "canvas_update",
                    {
                        "changes": [
                            {
                                "id": target["id"],
                                "text": "同步验证完成",
                                "x": 310,
                                "y": 235,
                            }
                        ]
                    },
                )
            assert (
                "同步验证完成" in body or "updated" in body
            ), "no successful update result reached the model"
            self.update_acks += 1
            return "text", UPDATED


@contextmanager
def provider():
    scenario = Scenario()

    def reply(request):
        action, result = scenario.next(request, authenticated=True)
        if action == "error":
            return {"status": result}
        if action == "slow":
            scenario.release.wait(timeout=30)
            return {"text": "延迟测试结束。"}
        if action == "tool":
            name, arguments = result
            return {"tool_calls": [{"name": name, "arguments": arguments}]}
        return {"text": result}

    with completion_endpoint(MODEL, scenario.key, reply, scenario.errors) as origin:
        try:
            yield scenario, origin
        finally:
            scenario.release.set()
