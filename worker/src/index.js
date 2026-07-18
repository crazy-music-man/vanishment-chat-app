/**
 * Van!shment chat — Cloudflare Workers WebSocket中継サーバー
 *
 * server.py の移植版。
 * あいことば（room）ごとに1つのDurable Objectインスタンスが割り当てられ、
 * 2人までの参加者間でメッセージを中継する。
 *
 * クライアントは wss://<worker>/ws?room=<あいことば> に接続し、
 * server.py と同じプロトコル（join / joined / full / msg / reaction / end）で通信する。
 */

// ブラウザ以外(Origin無し)・ローカル開発(http)・GitHub Pages のみ許可
function isAllowedOrigin(origin) {
  if (!origin) return true;
  if (origin.startsWith("http://")) return true; // ローカル開発 (wrangler dev / LAN)
  return origin === "https://crazy-music-man.github.io";
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/ws") {
      if ((request.headers.get("Upgrade") || "").toLowerCase() !== "websocket") {
        return new Response("Expected WebSocket", { status: 426 });
      }
      if (!isAllowedOrigin(request.headers.get("Origin") || "")) {
        return new Response("Forbidden", { status: 403 });
      }
      const room = (url.searchParams.get("room") || "").trim();
      if (!room) {
        return new Response("room required", { status: 400 });
      }
      // 同じあいことば → 同じDOインスタンス
      const id = env.ROOMS.idFromName(room);
      return env.ROOMS.get(id).fetch(request);
    }

    return new Response("Van!shment chat relay server", { status: 200 });
  },
};

export class Room {
  constructor(ctx, env) {
    this.ctx = ctx;
  }

  async fetch(request) {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    // Hibernation API: DOがアイドル時に休止してもソケットは維持される
    this.ctx.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  // 参加済み(joinを受理した)ソケットの一覧
  joinedSockets() {
    return this.ctx.getWebSockets().filter((s) => {
      try {
        return s.deserializeAttachment()?.joined;
      } catch {
        return false;
      }
    });
  }

  webSocketMessage(ws, raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    if (msg.type === "join") {
      const roomName = (msg.room || "").trim();
      if (!roomName) return;
      const clientId = (msg.clientId || "").toString();

      // fix A: 同じ端末(clientId)の古い接続が残っていたら閉じて枠を返す。
      // リロード・復帰・ネットワーク瞬断のあとでも、自分の枠を確実に奪還できる。
      const evicted = new Set();
      if (clientId) {
        for (const s of this.joinedSockets()) {
          if (s === ws) continue;
          let att = null;
          try { att = s.deserializeAttachment(); } catch {}
          if (att?.clientId && att.clientId === clientId) {
            evicted.add(s);
            try { s.close(1000, "replaced by same client"); } catch {}
          }
        }
      }

      // close() は非同期なので、いま閉じたソケットは数に入れないよう除外する
      const others = this.joinedSockets().filter((s) => s !== ws && !evicted.has(s));
      if (others.length >= 2) {
        ws.send(JSON.stringify({ type: "full", room: roomName }));
        return;
      }
      ws.serializeAttachment({ joined: true, room: roomName, clientId });
      ws.send(JSON.stringify({ type: "joined", room: roomName }));
      console.log(`[${roomName}] 参加 (clientId=${clientId || "-"}) 現在${others.length + 1}人`);
      return;
    }

    const me = (() => {
      try {
        return ws.deserializeAttachment();
      } catch {
        return null;
      }
    })();
    if (!me?.joined) return;

    if (msg.type === "end") {
      for (const peer of this.joinedSockets()) {
        if (peer === ws) continue;
        try {
          peer.send(JSON.stringify({ type: "end" }));
        } catch {}
        try {
          peer.close(1000, "room ended");
        } catch {}
      }
      try {
        ws.close(1000, "room ended");
      } catch {}
      console.log(`[${me.room}] ルーム終了`);
      return;
    }

    // それ以外(msg / reaction / hello)は相手にそのまま中継
    const data = typeof raw === "string" ? raw : JSON.stringify(msg);
    for (const peer of this.joinedSockets()) {
      if (peer === ws) continue;
      try {
        peer.send(data);
      } catch {}
    }
  }

  webSocketClose(ws) {
    try {
      const me = ws.deserializeAttachment();
      if (me?.joined) {
        const remaining = this.joinedSockets().filter((s) => s !== ws).length;
        console.log(`[${me.room}] 一時退出（残り${remaining}人）`);
      }
    } catch {}
  }
}
