#!/usr/bin/env python3
"""
消えていく会話 — ローカルWebSocket中継サーバー

使い方:
  .venv/bin/python3 server.py

同じWiFi内の端末から http://<このPCのIP>:8000/remote.html を開く。
同じ「あいことば」を入力すると会話が始まる。
"""

import asyncio
import http.server
import json
import os
import socket
import threading
import websockets

PORT_HTTP = 8000
PORT_WS = 8001

# あいことば → 接続中のWebSocketのセット
rooms: dict[str, set[websockets.ServerConnection]] = {}


async def handler(ws: websockets.ServerConnection):
    room_name = None
    try:
        async for raw in ws:
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                continue

            if msg.get("type") == "join":
                room_name = msg.get("room", "").strip()
                if not room_name:
                    continue
                if room_name not in rooms:
                    rooms[room_name] = set()
                # 切断済みの接続を除去してからカウント
                alive = set()
                for c in rooms[room_name]:
                    try:
                        await c.ping()
                        alive.add(c)
                    except Exception:
                        pass
                rooms[room_name] = alive
                if len(rooms[room_name]) >= 2:
                    await ws.send(json.dumps({"type": "full", "room": room_name}))
                    room_name = None
                    continue
                rooms[room_name].add(ws)
                await ws.send(json.dumps({"type": "joined", "room": room_name}))
                print(f"  [{room_name}] {len(rooms[room_name])}人目が参加")
                continue

            if msg.get("type") == "end" and room_name and room_name in rooms:
                peers = [c for c in rooms[room_name] if c is not ws]
                for peer in peers:
                    try:
                        await peer.send(json.dumps({"type": "end"}))
                    except websockets.ConnectionClosed:
                        pass
                rooms[room_name].discard(ws)
                for peer in peers:
                    rooms[room_name].discard(peer)
                if not rooms[room_name]:
                    del rooms[room_name]
                print(f"  [{room_name}] ルーム終了")
                room_name = None
                continue

            if room_name and room_name in rooms:
                data = json.dumps(msg) if not isinstance(raw, str) else raw
                peers = [c for c in rooms[room_name] if c is not ws]
                for peer in peers:
                    try:
                        await peer.send(data)
                    except websockets.ConnectionClosed:
                        pass
    except websockets.ConnectionClosed:
        pass
    finally:
        if room_name and room_name in rooms:
            rooms[room_name].discard(ws)
            remaining = len(rooms[room_name])
            if not rooms[room_name]:
                del rooms[room_name]
            print(f"  [{room_name}] 一時退出（残り{remaining}人）")


def get_local_ip():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return "localhost"


class FastHTTPHandler(http.server.SimpleHTTPRequestHandler):
    def address_string(self):
        return self.client_address[0]

    def log_message(self, format, *args):
        pass


class QuietHTTPServer(http.server.ThreadingHTTPServer):
    def handle_error(self, request, client_address):
        # ブラウザ側の突然の切断（keep-alive切れ等）は無害なので黙殺する
        import sys
        exc = sys.exc_info()[1]
        if isinstance(exc, (ConnectionResetError, BrokenPipeError, TimeoutError)):
            return
        super().handle_error(request, client_address)


def run_http():
    os.chdir(os.path.dirname(os.path.abspath(__file__)))
    httpd = QuietHTTPServer(("0.0.0.0", PORT_HTTP), FastHTTPHandler)
    httpd.serve_forever()


async def main():
    threading.Thread(target=run_http, daemon=True).start()

    ip = get_local_ip()
    print(f"")
    print(f"  消えていく会話サーバーが起動しました")
    print(f"")
    print(f"  同じWiFi内の端末で以下のURLを開いてください:")
    print(f"  → http://{ip}:{PORT_HTTP}/remote.html")
    print(f"")
    print(f"  HTTP: ポート {PORT_HTTP}")
    print(f"  WebSocket: ポート {PORT_WS}")
    print(f"  停止するには Ctrl+C")
    print(f"")

    async with websockets.serve(handler, "0.0.0.0", PORT_WS):
        await asyncio.Future()


if __name__ == "__main__":
    asyncio.run(main())
