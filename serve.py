#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
本地静态服务器 —— 战地上海

为什么需要它：
    Windows 注册表常把 .js 关联为 text/plain，Python 自带的 http.server 会因此
    把 game/src/*.js 以 text/plain 返回，浏览器会拒绝加载 ES module
    （报错：Expected a JavaScript-or-Wasm module script but the server responded
      with a MIME type of "text/plain"）。
    本脚本显式注册正确的 MIME 类型，规避该问题。

用法：
    python serve.py            # 默认 8811 端口
    python serve.py 9000       # 指定端口
然后浏览器访问：  http://localhost:8811/game/index.html
"""
import http.server
import mimetypes
import os
import socketserver
import sys

mimetypes.add_type('text/javascript', '.js')
mimetypes.add_type('text/javascript', '.mjs')
mimetypes.add_type('text/css', '.css')
mimetypes.add_type('application/json', '.json')
mimetypes.add_type('image/png', '.png')
mimetypes.add_type('image/jpeg', '.jpg')
mimetypes.add_type('text/plain', '.obj')
mimetypes.add_type('text/plain', '.mtl')
mimetypes.add_type('text/plain', '.bin')

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8811
ROOT = os.path.dirname(os.path.abspath(__file__))


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def end_headers(self):
        self.send_header('Cache-Control', 'no-cache')
        super().end_headers()

    def log_message(self, fmt, *args):
        pass


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


if __name__ == '__main__':
    with Server(('0.0.0.0', PORT), Handler) as httpd:
        print('=' * 62)
        print('  战地上海   本地服务器已启动')
        print('  根目录 : %s' % ROOT)
        print('  地址   : http://localhost:%d/game/index.html' % PORT)
        print('=' * 62)
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print('\n已停止')
