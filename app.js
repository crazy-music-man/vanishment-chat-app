const APP_VERSION = "v1.0.1";

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
  }

  connect(room, onJoined) {
    this.ws = new WebSocket(wsServerUrl(room));

    this.ws.addEventListener("open", () => {
      this.ws.send(JSON.stringify({ type: "join", room }));
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
      if (!this.intentionalClose) setStatus("サーバーとの接続が切れました");
    });

    this.ws.addEventListener("error", () => {
      if (!this.intentionalClose) setStatus("サーバーに接続できません。しばらくしてからもう一度お試しください。");
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
  $("lobbyStatus").textContent = msg;
}

/* =========================================================
   ロビー
   ========================================================= */
$("startBtn").addEventListener("click", () => {
  room = ($("roomInput").value || "").trim();
  if (!room) { setStatus("あいことばを入力してください"); return; }

  $("startBtn").disabled = true;
  setStatus("接続しています…");

  myId = sessionStorage.getItem("kieru_wid");
  if (!myId) {
    myId = "w-" + Math.random().toString(36).slice(2, 10);
    sessionStorage.setItem("kieru_wid", myId);
  }
  loadLocal();

  transport = new WSTransport(onMessage);
  transport.onFull = () => {
    setStatus("ごめんなさい。このルームにはすでに二人います。");
    $("startBtn").disabled = false;
    transport.close();
  };
  transport.connect(room, () => {
    setStatus("");
    $("lobby").classList.add("hidden");
    $("chatHeader").classList.remove("hidden");
    $("thread").classList.remove("hidden");
    $("composer").classList.remove("hidden");

    transport.send({ type: "hello", from: myId });
    render();
  });
});

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
  return Math.min(4 + dt / 10_000, 60);
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
  row.className = "row " + (mine ? "right" : "left");

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

  row.appendChild(wrap);

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

  return row;
}

/* =========================================================
   入力まわり
   ========================================================= */
document.addEventListener("input", (e) => {
  if (e.target.id !== "input") return;
  $("sendBtn").disabled = e.target.value.trim() === "";
  e.target.style.height = "auto";
  e.target.style.height = Math.min(e.target.scrollHeight, 120) + "px";
});

function submitText() {
  const inp = $("input");
  const v = inp.value.trim();
  if (!v) return;
  sendMessage(v);
  inp.value = ""; inp.style.height = "auto"; $("sendBtn").disabled = true;
}
$("sendBtn").addEventListener("click", submitText);

$("input").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submitText(); }
});

/* =========================================================
   退出・終了
   ========================================================= */
function resetToLobby() {
  history = []; pendingMessages = []; fadeIds = new Set();
  startedAt = null; updatedAt = null; room = "";
  $("chatHeader").classList.add("hidden");
  $("thread").classList.add("hidden");
  $("composer").classList.add("hidden");
  $("lobby").classList.remove("hidden");
  $("roomInput").value = "";
  $("startBtn").disabled = false;
  setStatus("");
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

function leaveRoom() {
  if (transport) transport.close();
  transport = null;
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

  const roomInfo = document.createElement("div");
  roomInfo.className = "menu-item";
  roomInfo.innerHTML = `<b>あいことば</b>　${room || "—"}`;
  panel.appendChild(roomInfo);

  const leaveBtn = document.createElement("button");
  leaveBtn.className = "menu-action";
  leaveBtn.textContent = "↺ 一時退出";
  leaveBtn.addEventListener("click", () => {
    if (!confirm("一時退出しますか？（相手はそのまま残ります）")) return;
    leaveRoom();
  });
  panel.appendChild(leaveBtn);

  const endBtn = document.createElement("button");
  endBtn.className = "menu-action";
  endBtn.style.color = "#c0392b";
  endBtn.textContent = "✕ 終了";
  endBtn.addEventListener("click", () => {
    if (!confirm("会話を終了しますか？（相手にも通知され、ルームが閉じます）")) return;
    endRoom();
  });
  panel.appendChild(endBtn);

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
   キャプチャ
   ========================================================= */
$("captureBtn").addEventListener("click", async () => {
  const btn = $("captureBtn");
  btn.disabled = true;
  btn.style.opacity = ".4";

  try {
    if (!window.html2canvas) {
      await new Promise((resolve, reject) => {
        const s = document.createElement("script");
        s.src = "https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js";
        s.onload = resolve;
        s.onerror = () => reject(new Error("html2canvas の読み込みに失敗しました"));
        document.head.appendChild(s);
      });
    }

    const th = $("thread");
    const header = $("chatHeader");
    const origHeight = th.style.height;
    const origOverflow = th.style.overflow;
    const origFlex = th.style.flex;
    const origBodyOverflow = document.body.style.overflow;
    const origBodyHeight = document.body.style.height;

    th.style.height = th.scrollHeight + "px";
    th.style.overflow = "visible";
    th.style.flex = "none";
    header.style.display = "none";
    document.body.style.overflow = "visible";
    document.body.style.height = "auto";

    const canvas = await html2canvas(document.body, {
      scale: 2,
      useCORS: true,
    });

    th.style.height = origHeight;
    th.style.overflow = origOverflow;
    th.style.flex = origFlex;
    header.style.display = "";
    document.body.style.overflow = origBodyOverflow;
    document.body.style.height = origBodyHeight;

    const dataUrl = canvas.toDataURL("image/png");

    const overlay = document.createElement("div");
    overlay.className = "capture-overlay";

    const img = document.createElement("img");
    img.src = dataUrl;
    overlay.appendChild(img);

    const hint = document.createElement("div");
    hint.className = "capture-hint";
    hint.textContent = "画像を長押しして保存できます";
    overlay.appendChild(hint);

    const closeBtn = document.createElement("button");
    closeBtn.className = "capture-close";
    closeBtn.textContent = "閉じる";
    closeBtn.addEventListener("click", () => overlay.remove());
    overlay.appendChild(closeBtn);

    document.body.appendChild(overlay);
  } catch (e) {
    alert("キャプチャに失敗しました: " + e.message);
  } finally {
    btn.disabled = false;
    btn.style.opacity = "";
  }
});
