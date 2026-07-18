const APP_VERSION = "v1.0.2-display";

// 展示モードの固定あいことば。つながる2台の端末で同じ値にする
const DISPLAY_ROOM = "display";

/* =========================================================
   WebSocket Transport
   ========================================================= */
function wsServerUrl(room) {
  const base = location.protocol === "http:"
    ? `ws://${location.hostname}:8787`
    : "wss://vanishment-chat-worker.crazy-music-man.workers.dev";
  return `${base}/ws?room=${encodeURIComponent(room)}`;
}

class WSTransport {
  constructor(onMessage) {
    this.ws = null;
    this.onMessage = onMessage;
    this.queue = [];
    this.intentionalClose = false;
    this.onFull = null;
    this.onClose = null; // 予期しない切断時のコールバック（自動再接続に使う）
  }

  connect(room, clientId, onJoined) {
    this.intentionalClose = false;
    this.ws = new WebSocket(wsServerUrl(room));

    this.ws.addEventListener("open", () => {
      // clientId を載せ、同一端末の古い接続をサーバー側で奪還できるようにする（fix A）
      this.ws.send(JSON.stringify({ type: "join", room, clientId }));
    });

    this.ws.addEventListener("message", (e) => {
      let data;
      try { data = JSON.parse(e.data); } catch { return; }

      if (data.type === "joined") {
        for (const obj of this.queue) this.ws.send(JSON.stringify(obj));
        this.queue = [];
        if (onJoined) onJoined();
        return;
      }
      if (data.type === "full") {
        if (this.onFull) this.onFull();
        return;
      }
      this.onMessage(data);
    });

    this.ws.addEventListener("close", () => {
      if (!this.intentionalClose && this.onClose) this.onClose();
    });

    this.ws.addEventListener("error", () => {
      // error の直後に close が発火するので、再接続は close 側でまとめて処理する
    });
  }

  send(obj) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(obj));
    } else {
      this.queue.push(obj);
    }
  }

  close() {
    this.intentionalClose = true;
    if (this.ws) this.ws.close();
  }
}

/* =========================================================
   状態
   ========================================================= */
const STAMPS = ["👍","❤️","😂","🙏","😮","😢","✨","👀"];
let myId = null;
let room = "";
let transport = null;

let history = [];
let pendingMessages = [];
let fadeIds = new Set();
let startedAt = null;
let updatedAt = null;

const storeKey = () => `kieru_remote_v2::${room}::${myId}`;

function save() {
  localStorage.setItem(storeKey(), JSON.stringify({ history, startedAt, updatedAt }));
}
function loadLocal() {
  try {
    const s = JSON.parse(localStorage.getItem(storeKey()));
    if (s && Array.isArray(s.history)) {
      history = s.history;
      startedAt = s.startedAt || null;
      updatedAt = s.updatedAt || null;
    }
  } catch (e) {}
}
function now() {
  const d = new Date();
  return ("0"+d.getHours()).slice(-2) + ":" + ("0"+d.getMinutes()).slice(-2);
}

/* =========================================================
   DOM helpers
   ========================================================= */
const $ = (id) => document.getElementById(id);

function setStatus(msg) {
  const el = $("displayStatus");
  if (el) el.textContent = msg;
}

/* =========================================================
   展示モード：あいことばなしで固定ルームに自動接続
   ========================================================= */
let reconnectTimer = null;
let reconnectDelay = 1000; // 再接続の待ち時間(ms) 指数バックオフ

function startDisplay() {
  room = DISPLAY_ROOM;

  $("chatHeader").classList.remove("hidden");
  $("thread").classList.remove("hidden");
  $("composer").classList.remove("hidden");

  myId = sessionStorage.getItem("kieru_wid");
  if (!myId) {
    myId = "w-" + Math.random().toString(36).slice(2, 10);
    sessionStorage.setItem("kieru_wid", myId);
  }
  loadLocal();
  render();

  connectRoom();
}

function connectRoom() {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (transport) { transport.close(); transport = null; }

  setStatus("接続しています…");
  transport = new WSTransport(onMessage);
  transport.onFull = () => {
    // fix A により自分の枠は奪還される。ここに来るのは他に2台いる正当なケース
    transport.close();
    transport = null;
    scheduleReconnect("接続の空きを待っています…");
  };
  transport.onClose = () => {
    // ネットワーク切断など予期しない切断 → 自動再接続（fix C）
    transport = null;
    scheduleReconnect("再接続しています…");
  };
  transport.connect(room, myId, () => {
    reconnectDelay = 1000; // 接続成功でバックオフをリセット
    setStatus("");
    transport.send({ type: "hello", from: myId });
    render();
  });
}

function scheduleReconnect(message) {
  if (reconnectTimer) return;                          // 二重予約しない
  if (document.visibilityState === "hidden") return;   // 非表示中は再接続しない（fix B）
  setStatus(message || "再接続しています…");
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectRoom();
  }, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, 15000); // 最大15秒
}

// 枠をすぐ解放するため、非表示・離脱時は明示的に切断する（fix B）
function disconnectForHidden() {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (transport) { transport.close(); transport = null; }
  setStatus("");
}

// 表示に戻ったら、未接続のときだけ再接続する（fix C）
function ensureConnected() {
  if (transport || reconnectTimer) return;
  reconnectDelay = 1000;
  connectRoom();
}

/* =========================================================
   受信
   ========================================================= */
function onMessage(obj) {
  if (!obj || obj.from === myId) return;

  if (obj.type === "hello") {
    const lastMine = [...history].reverse().find(e => e.side === "me");
    if (lastMine) {
      transport.send({ type:"msg", from: myId, kind: lastMine.kind,
                       content: lastMine.content, time: lastMine.time, id: lastMine.id });
    }
    return;
  }

  if (obj.type === "msg") {
    if (pendingMessages.some(p => p.id === obj.id)) return;
    if (history.some(e => e.id === obj.id)) return;

    if (!startedAt) startedAt = new Date().toISOString();
    updatedAt = new Date().toISOString();
    pendingMessages.push({ kind: obj.kind, content: obj.content, time: obj.time, id: obj.id });
    save();
    render();
  }

  if (obj.type === "end") {
    endedByPeer();
    return;
  }

  if (obj.type === "reaction") {
    const target = history.find(e => e.id === obj.targetId && e.side === "me");
    if (target) target.stamp = obj.stamp;
    save();
    render();
  }
}

/* =========================================================
   送信
   ========================================================= */
function sendMessage(content) {
  fadeIds = new Set();
  for (const p of pendingMessages) {
    fadeIds.add("fade-" + p.id);
    const entry = { side: "them", ghost: true, time: p.time, id: p.id, len: p.content.length };
    if (p.stamp) entry.stamp = p.stamp;
    history.push(entry);
  }
  pendingMessages = [];

  const id = Date.now() + "-" + Math.random().toString(36).slice(2,6);
  const t = now();
  if (!startedAt) startedAt = new Date().toISOString();
  updatedAt = new Date().toISOString();
  history.push({ side: "me", kind: "text", content, time: t, id });
  transport.send({ type: "msg", from: myId, kind: "text", content, time: t, id });

  save();
  render();
  fadeIds = new Set();
}

function sendReaction(targetId, stamp) {
  const inPending = pendingMessages.find(p => p.id === targetId);
  if (inPending) {
    inPending.stamp = stamp;
  } else {
    const inHistory = history.find(e => e.id === targetId && e.side === "them");
    if (inHistory) inHistory.stamp = stamp;
  }
  transport.send({ type: "reaction", from: myId, stamp, targetId });
  save();
  render();
}

/* =========================================================
   描画
   ========================================================= */
function formatTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  const mo = d.getMonth() + 1, da = d.getDate();
  const h = ("0"+d.getHours()).slice(-2), m = ("0"+d.getMinutes()).slice(-2);
  return `${mo}/${da} ${h}:${m}`;
}

function tsFromId(id) {
  if (!id) return 0;
  const n = parseInt(id.split("-")[0], 10);
  return isNaN(n) ? 0 : n;
}

function timeGap(prevId, curId) {
  const dt = Math.abs(tsFromId(curId) - tsFromId(prevId));
  const MIN_GAP = 4;      // 返信がほぼ瞬時のときの隙間(px)
  const MAX_GAP = 140;    // 時間が空いたときに漸近する上限(px)
  const HALF = 30_000;    // 隙間が中間値に達するまでの時間(ms) 小さいほど早く飽和
  // 双曲線飽和: 短い時間ほど大きく開き、長い時間ほど変化が鈍る
  return MIN_GAP + (MAX_GAP - MIN_GAP) * dt / (dt + HALF);
}

function render() {
  $("input").placeholder = "メッセージを入力…";

  const th = $("thread");
  th.innerHTML = "";

  if (history.length === 0 && pendingMessages.length === 0) {
    const e = document.createElement("div");
    e.className = "empty";
    e.textContent = "最初のひとことを送ってみてください。";
    th.appendChild(e);
    return;
  }

  const all = [
    ...history,
    ...pendingMessages.map(p => ({ side:"them", kind: p.kind, content: p.content, time: p.time, id: p.id, stamp: p.stamp }))
  ];
  let prevId = null;
  for (const m of all) {
    const row = renderBubble(m);
    row.style.marginTop = (prevId ? timeGap(prevId, m.id) : 0) + "px";
    th.appendChild(row);
    prevId = m.id;
  }

  th.scrollTop = th.scrollHeight;
}

function appendLinkified(el, text) {
  const urlRe = /(https?:\/\/[^\s<>"]+)/g;
  let last = 0, match;
  while ((match = urlRe.exec(text)) !== null) {
    if (match.index > last) {
      el.appendChild(document.createTextNode(text.slice(last, match.index)));
    }
    const a = document.createElement("a");
    a.href = match[0];
    a.textContent = match[0];
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    el.appendChild(a);
    last = match.index + match[0].length;
  }
  if (last < text.length) {
    el.appendChild(document.createTextNode(text.slice(last)));
  }
}

let openPickerId = null;

function closePicker() {
  openPickerId = null;
  document.querySelectorAll(".react-picker").forEach(el => el.remove());
}

function renderBubble(m) {
  const mine = m.side === "me";
  const row = document.createElement("div");
  row.className = "row";

  const wrap = document.createElement("div");
  wrap.className = "bubble-row-wrap";

  const b = document.createElement("div");
  let cls = "bubble " + (mine ? "mine" : "them");
  if (m.ghost) {
    cls += " ghost";
    if (fadeIds.has("fade-" + m.id)) cls += " ghost-fade";
  }
  b.className = cls;
  if (m.ghost) {
    b.textContent = Array(m.len || 3).fill("　").join("​");
  } else {
    appendLinkified(b, m.content || "");
  }
  wrap.appendChild(b);

  if (m.stamp) {
    const r = document.createElement("div");
    r.className = "reaction";
    r.textContent = m.stamp;
    wrap.appendChild(r);
  }

  if (!mine && m.id) {
    const trigger = document.createElement("button");
    trigger.className = "react-trigger";
    trigger.textContent = "☺";
    trigger.addEventListener("click", (e) => {
      e.stopPropagation();
      if (openPickerId === m.id) { closePicker(); return; }
      closePicker();
      openPickerId = m.id;
      const picker = document.createElement("div");
      picker.className = "react-picker";
      STAMPS.forEach(s => {
        const btn = document.createElement("button");
        btn.textContent = s;
        btn.addEventListener("click", (e2) => {
          e2.stopPropagation();
          sendReaction(m.id, s);
          closePicker();
        });
        picker.appendChild(btn);
      });
      wrap.appendChild(picker);
    });
    row.appendChild(trigger);
  }
  row.appendChild(wrap);

  return row;
}

/* =========================================================
   入力まわり
   ========================================================= */
const inputEl = $("input");
let composing = false; // IME変換中（ひらがなフリック入力などの未確定状態）フラグ

function resizeInput() {
  inputEl.style.height = "auto";
  inputEl.style.height = Math.min(inputEl.scrollHeight, 120) + "px";
}

// iOSのフリック入力では、変換中に高さ再計算(reflow)を走らせると
// 未確定文字が壊れる／消えるため、確定するまでリサイズを保留する
inputEl.addEventListener("compositionstart", () => { composing = true; });
inputEl.addEventListener("compositionend", () => {
  composing = false;
  $("sendBtn").disabled = inputEl.value.trim() === "";
  resizeInput();
});

inputEl.addEventListener("input", (e) => {
  $("sendBtn").disabled = inputEl.value.trim() === "";
  if (composing || e.isComposing) return; // 変換中は高さ調整しない
  resizeInput();
});

function submitText() {
  const v = inputEl.value.trim();
  if (!v) return;
  sendMessage(v);
  inputEl.value = ""; inputEl.style.height = "auto"; $("sendBtn").disabled = true;
}
$("sendBtn").addEventListener("click", submitText);

inputEl.addEventListener("keydown", (e) => {
  if (composing || e.isComposing) return; // 変換確定のEnterでは送信しない
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submitText(); }
});

/* =========================================================
   退出・終了
   ========================================================= */
function resetToLobby() {
  // 展示モードではロビーがないので、会話をクリアして同じルームへ再接続する
  history = []; pendingMessages = []; fadeIds = new Set();
  startedAt = null; updatedAt = null;
  setStatus("");
  render();
  connectRoom();
}

function endedByPeer() {
  if (transport) transport.close();
  transport = null;
  $("composer").classList.add("hidden");
  const th = $("thread");
  const notice = document.createElement("div");
  notice.className = "empty";
  notice.textContent = "相手が退出したようです";
  th.appendChild(notice);
  th.scrollTop = th.scrollHeight;

  setTimeout(() => {
    localStorage.removeItem(storeKey());
    resetToLobby();
  }, 3000);
}

function endRoom() {
  if (transport) {
    transport.send({ type: "end", from: myId });
    transport.close();
  }
  transport = null;
  localStorage.removeItem(storeKey());
  closeMenu();
  resetToLobby();
}

document.addEventListener("click", () => closePicker());

/* =========================================================
   メニュー
   ========================================================= */
function openMenu() {
  closeMenu();
  const overlay = document.createElement("div");
  overlay.className = "menu-overlay";
  overlay.id = "menuOverlay";
  overlay.addEventListener("click", closeMenu);

  const panel = document.createElement("div");
  panel.className = "menu-panel";
  panel.id = "menuPanel";

  const title = document.createElement("h3");
  title.textContent = "メニュー";
  panel.appendChild(title);

  const info = document.createElement("div");
  info.className = "menu-item";
  if (startedAt) {
    info.innerHTML = `<b>開始</b>　${formatTime(startedAt)}<br><b>最終更新</b>　${formatTime(updatedAt)}`;
  } else {
    info.textContent = "まだ会話は始まっていません";
  }
  panel.appendChild(info);

  const leaveBtn = document.createElement("button");
  leaveBtn.className = "menu-action";
  leaveBtn.textContent = "↺ 会話をリセット";
  leaveBtn.addEventListener("click", () => {
    if (!confirm("会話をリセットして最初からにしますか？")) return;
    endRoom();
  });
  panel.appendChild(leaveBtn);

  const ver = document.createElement("div");
  ver.className = "menu-item";
  ver.style.marginTop = "auto";
  ver.textContent = APP_VERSION;
  panel.appendChild(ver);

  document.body.appendChild(overlay);
  document.body.appendChild(panel);
}

function closeMenu() {
  const o = $("menuOverlay"); if (o) o.remove();
  const p = $("menuPanel"); if (p) p.remove();
}

$("menuBtn").addEventListener("click", openMenu);

/* =========================================================
   起動・接続維持
   ========================================================= */
// バックグラウンド/ロック/離脱で枠を解放し、復帰で再接続する（fix B / C）
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") disconnectForHidden();
  else ensureConnected();
});
window.addEventListener("pagehide", disconnectForHidden);
window.addEventListener("pageshow", (e) => { if (e.persisted) ensureConnected(); });

startDisplay();
