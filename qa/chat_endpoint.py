"""Minimal local OpenAI Chat Completions transport for the browser acceptance tests."""

from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import secrets
import threading
import time
from urllib.parse import urlsplit


@contextmanager
def completion_endpoint(model, key, respond, errors):
    """Wrap a completion callback in the JSON and SSE wire formats understood by Peri."""

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *_args):
            pass

        def json_response(self, status, value):
            wire = json.dumps(value, ensure_ascii=False).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(wire)))
            self.end_headers()
            self.wfile.write(wire)

        def do_POST(self):
            if urlsplit(self.path).path != "/v1/chat/completions":
                self.json_response(404, {"error": {"message": "Unknown provider route"}})
                return
            try:
                request = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                if (
                    self.headers.get("Authorization") != "Bearer " + key
                    or request.get("model") != model
                ):
                    errors.append("Model or API key mismatch")
                    self.json_response(401, {"error": {"message": "Invalid provider credentials"}})
                    return
                reply = respond(request)
                if "status" in reply:
                    self.json_response(
                        reply["status"], {"error": {"message": "Fixture request refused"}}
                    )
                    return
                tools = [
                    {
                        "id": "call_" + secrets.token_hex(6),
                        "type": "function",
                        "function": {
                            "name": call["name"],
                            "arguments": json.dumps(call["arguments"], ensure_ascii=False),
                        },
                    }
                    for call in reply.get("tool_calls", [])
                ]
                text = reply.get("text", "")
                packet = {
                    "id": "chatcmpl-" + secrets.token_hex(5),
                    "created": int(time.time()),
                    "model": model,
                }
                stop = "tool_calls" if tools else "stop"
                if not request.get("stream"):
                    message = {"role": "assistant", "content": text or None}
                    if tools:
                        message["tool_calls"] = tools
                    self.json_response(
                        200,
                        {
                            **packet,
                            "object": "chat.completion",
                            "choices": [
                                {"index": 0, "message": message, "finish_reason": stop},
                            ],
                        },
                    )
                    return
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Cache-Control", "no-store")
                self.send_header("Connection", "close")
                self.end_headers()
                self.close_connection = True

                def chunk(delta, reason=None):
                    obj = {
                        **packet,
                        "object": "chat.completion.chunk",
                        "choices": [
                            {"index": 0, "delta": delta, "finish_reason": reason},
                        ],
                    }
                    self.wfile.write(
                        ("data: " + json.dumps(obj, ensure_ascii=False) + "\n\n").encode()
                    )
                    self.wfile.flush()

                chunk({"role": "assistant"})
                if text:
                    split = max(1, len(text) // 2)
                    chunk({"content": text[:split]})
                    chunk({"content": text[split:]})
                if tools:
                    chunk(
                        {
                            "tool_calls": [
                                {"index": index, **tool} for index, tool in enumerate(tools)
                            ]
                        }
                    )
                chunk({}, stop)
                self.wfile.write(b"data: [DONE]\n\n")
                self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError):
                pass
            except Exception as exc:
                errors.append(f"{type(exc).__name__}: {str(exc)[:400]}")
                try:
                    self.json_response(
                        500, {"error": {"message": "Acceptance adapter rejected the request"}}
                    )
                except (BrokenPipeError, ConnectionResetError):
                    pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}"
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)
