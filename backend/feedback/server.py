"""Runs this service in a container (ECS Fargate) instead of as a Lambda.

A small web server that turns each HTTP request into the event a Lambda Function URL
would send, calls the same handler(), and writes its answer back. One request at a time,
exactly like a Lambda, so the shared database connection needs no locking.
"""

import os
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlsplit

from function import handler


class Adapter(BaseHTTPRequestHandler):
    timeout = 10  # seconds a silent client may hold the one thread before it is dropped

    def body(self):
        """The request body. A client that knows its length says so; one that streams (the
        local proxy does, and so may a load balancer) sends it in chunks, each led by its size."""
        if "chunked" not in self.headers.get("Transfer-Encoding", "").lower():
            return self.rfile.read(int(self.headers.get("Content-Length") or 0))
        body = b""
        while size := int(self.rfile.readline().split(b";")[0].strip() or b"0", 16):
            body += self.rfile.read(size)
            self.rfile.readline()  # the line break that ends each chunk
        self.rfile.readline()  # the empty line after the last, zero-sized chunk
        return body

    def answer(self):
        url = urlsplit(self.path)
        event = {
            "requestContext": {"http": {"method": self.command}},
            "rawPath": url.path,
            "rawQueryString": url.query,
            "headers": dict(self.headers.items()),
            "body": self.body().decode("utf-8", "replace") or None,
            "isBase64Encoded": False,
        }
        response = handler(event, None)
        body = response["body"].encode("utf-8")
        self.send_response(response["statusCode"])
        for name, value in response["headers"].items():
            self.send_header(name, value)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    do_GET = do_POST = do_PATCH = do_DELETE = answer


if __name__ == "__main__":  # pragma: no cover  (the container's entry point)
    HTTPServer(("0.0.0.0", int(os.getenv("PORT", "8080"))), Adapter).serve_forever()
