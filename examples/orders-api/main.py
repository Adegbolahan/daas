"""Minimal service that satisfies the DAAS contract: listens on $PORT, answers /healthz and /ready,
and reads its secrets from env vars (injected by DAAS from GCP or AWS)."""
import json
import os
from http.server import BaseHTTPRequestHandler, HTTPServer

PORT = int(os.getenv("PORT", "8080"))
REQUIRED = ["DATABASE_URL", "PAYMENTS_API_KEY"]  # must match `secrets` in daas.yaml


class Handler(BaseHTTPRequestHandler):
    def _send(self, code: int, body: dict) -> None:
        data = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path == "/healthz":
            return self._send(200, {"ok": True})
        if self.path == "/ready":
            missing = [k for k in REQUIRED if not os.getenv(k)]
            return self._send(503 if missing else 200, {"ready": not missing, "missingSecrets": missing})
        if self.path == "/":
            return self._send(200, {"service": "orders-api", "env": os.getenv("APP_ENV", "unknown")})
        self._send(404, {"error": "not found"})

    def log_message(self, fmt, *args):  # one JSON line per request
        print(json.dumps({"path": self.path, "status": args[1] if len(args) > 1 else None}), flush=True)


if __name__ == "__main__":
    HTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
