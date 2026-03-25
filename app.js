// Peer-to-peer (no backend) version.
// WebRTC data channels + QR signaling (manual) per participant.
// Limitations: host must stay online; no persistence; host bandwidth limits.

/* global QRCode */

// ---- UI helpers ----
const $ = (sel) => document.querySelector(sel);
const el = (tag, attrs = {}, children = []) => {
  const n = document.createElement(tag);
  Object.entries(attrs).forEach(([k, v]) => {
    if (k === "class") n.className = v;
    else if (k === "text") n.textContent = v;
    else if (k.startsWith("on") && typeof v === "function") n.addEventListener(k.slice(2), v);
    else if (v === false || v === null || v === undefined) return;
    else n.setAttribute(k, v);
  });
  children.forEach((c) => n.appendChild(typeof c === "string" ? document.createTextNode(c) : c));
  return n;
};

let state = {
  role: null, // 'host' | 'participant'
  roomId: null,
  roomName: null,
  phase: "collecting", // collecting | voting | closed
  images: [], // {id,url,originalName,uploadedBy,votes:{peerId:number}}
  peerId: crypto.randomUUID(),

  // host side
  peers: new Map(), // peerId -> {pc,dc}
  pendingInvite: null, // { pc, dc, offerText, inviteId }

  // participant side
  pc: null,
  dc: null,
};

function toast(title, detail = "") {
  const t = $("#toast");
  $("#toastTitle").textContent = title;
  $("#toastDetail").textContent = detail;
  t.classList.add("show");
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => t.classList.remove("show"), 4200);
}

function setStatusBadge(phase) {
  const badge = $("#phaseBadge");
  badge.classList.remove("live", "wait", "vote", "closed");
  const map = {
    collecting: { cls: "wait", label: "Collecting images" },
    voting: { cls: "vote", label: "Voting open" },
    closed: { cls: "closed", label: "Voting closed" },
  };
  const m = map[phase] ?? { cls: "wait", label: phase ?? "—" };
  badge.classList.add(m.cls);
  badge.textContent = m.label;
}

function mustBeInRoom() {
  if (!state.roomId) throw new Error("Not in a room");
}

function isHost() {
  return state.role === "host";
}

function renderRoomInfo() {
  const inRoom = Boolean(state.roomId);
  $("#roomArea").classList.toggle("hidden", !inRoom);
  $("#authArea").classList.toggle("hidden", inRoom);

  if (!inRoom) return;

  $("#roomName").textContent = state.roomName || "Untitled";
  $("#roomId").textContent = state.roomId || "—";
  $("#role").textContent = isHost() ? "Host" : "Participant";

  setStatusBadge(state.phase);

  // Host controls + invite UI
  $("#hostControls").classList.toggle("hidden", !isHost());
  $("#p2pHostInvite").classList.toggle("hidden", !isHost());
  $("#btnStartVoting").disabled = state.phase !== "collecting";
  $("#btnCloseVoting").disabled = state.phase !== "voting";

  // Upload allowed only when collecting
  $("#uploadArea").classList.toggle("hidden", state.phase !== "collecting");

  // Voting allowed only when voting or closed (still show ratings; disable when closed)
  $("#votingArea").classList.toggle("hidden", !(state.phase === "voting" || state.phase === "closed"));
  $("#votingLocked").classList.toggle("hidden", state.phase !== "closed");

  $("#resultsArea").classList.toggle("hidden", state.phase === "collecting");
}

function calcImageStats(img) {
  const votes = img.votes || {};
  const values = Object.values(votes);
  const count = values.length;
  const avg = count ? values.reduce((a, b) => a + b, 0) / count : 0;
  return { count, avg };
}

function renderImages() {
  const g = $("#gallery");
  g.innerHTML = "";

  if (!state.images.length) {
    g.appendChild(el("div", { class: "notice" }, [
      el("strong", { text: "No images yet." }),
      "\nAsk participants to upload images.",
    ]));
    return;
  }

  for (const img of state.images) {
    const { count, avg } = calcImageStats(img);

    const tile = el("div", { class: "tile" }, [
      el("img", { src: img.url, alt: img.originalName || "Uploaded image" }),
      el("div", { class: "meta" }, [
        el("div", {}, [
          el("div", { class: "mono", text: (img.originalName || "image").slice(0, 30) }),
          el("div", { class: "sub", text: `Avg ${avg.toFixed(2)} • ${count} vote${count === 1 ? "" : "s"}` }),
        ]),
        renderRateControls(img),
      ]),
    ]);

    g.appendChild(tile);
  }
}

function renderRateControls(img) {
  const canVote = state.phase === "voting";
  const locked = state.phase === "closed";

  const wrap = el("div", { class: "rate" });
  const my = (img.votes || {})[state.peerId] ?? null;

  for (let v = 1; v <= 5; v++) {
    const b = el("button", {
      type: "button",
      class: my === v ? "active" : "",
      disabled: !canVote,
      title: locked ? "Voting is closed" : (canVote ? `Rate ${v}` : "Voting not started"),
      onClick: async () => {
        try {
          await submitVote(img.id, v);
        } catch (e) {
          toast("Could not submit vote", e?.message || String(e));
        }
      },
      text: String(v),
    });
    wrap.appendChild(b);
  }

  return wrap;
}

function renderResults() {
  const list = $("#resultsList");
  list.innerHTML = "";

  if (!state.roomId || state.phase === "collecting") return;

  if (!state.images.length) {
    list.appendChild(el("div", { class: "notice" }, ["No images to score."]));
    return;
  }

  const scored = state.images
    .map((img) => {
      const { count, avg } = calcImageStats(img);
      return { img, count, avg };
    })
    .sort((a, b) => b.avg - a.avg || b.count - a.count);

  for (let i = 0; i < scored.length; i++) {
    const s = scored[i];
    const row = el("div", { class: "notice" }, [
      el("strong", { text: `#${i + 1} • ${s.img.originalName || "image"}` }),
      el("div", { class: "small", text: `Average: ${s.avg.toFixed(2)} • Votes: ${s.count}` }),
    ]);
    list.appendChild(row);
  }
}

function randomRoomId() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

function rtcConfig() {
  // STUN is required for most NATs; not a backend you manage.
  return {
    iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
  };
}

function encodeSignal(obj) {
  return btoa(unescape(encodeURIComponent(JSON.stringify(obj))));
}

function decodeSignal(text) {
  try {
    return JSON.parse(decodeURIComponent(escape(atob(String(text).trim()))));
  } catch {
    throw new Error("Invalid QR / pasted text");
  }
}

async function waitIceGatheringComplete(pc) {
  if (pc.iceGatheringState === "complete") return;
  await new Promise((resolve) => {
    const onChange = () => {
      if (pc.iceGatheringState === "complete") {
        pc.removeEventListener("icegatheringstatechange", onChange);
        resolve();
      }
    };
    pc.addEventListener("icegatheringstatechange", onChange);
  });
}

function renderQR(containerSel, text) {
  const box = $(containerSel);
  box.innerHTML = "";
  if (!text) return;

  if (typeof QRCode === "undefined") {
    box.textContent = "QR library not loaded";
    throw new Error("QRCode library not loaded. Ensure the qrcode script tag is included before app.js.");
  }

  QRCode.toCanvas(text, { width: 220, margin: 1 }, (err, canvas) => {
    if (err) {
      box.textContent = "QR error";
      return;
    }
    box.appendChild(canvas);
  });
}

function getRoomSnapshot() {
  return {
    roomId: state.roomId,
    roomName: state.roomName,
    phase: state.phase,
    images: state.images,
  };
}

function broadcast(msg) {
  if (!isHost()) return;
  const payload = JSON.stringify(msg);
  for (const { dc } of state.peers.values()) {
    if (dc?.readyState === "open") dc.send(payload);
  }
}

function sendToHost(msg) {
  if (isHost()) return;
  if (state.dc?.readyState === "open") state.dc.send(JSON.stringify(msg));
}

function applyRoomSnapshot(snapshot) {
  state.roomId = snapshot.roomId;
  state.roomName = snapshot.roomName;
  state.phase = snapshot.phase;
  state.images = snapshot.images || [];
  $("#imageCount").textContent = String(state.images.length);
  renderRoomInfo();
  renderImages();
  renderResults();
}

function attachDataChannelHandlers(dc) {
  dc.addEventListener("message", (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }

    if (isHost()) {
      if (msg.type === "upload_image") {
        state.images.push(msg.image);
        $("#imageCount").textContent = String(state.images.length);
        renderImages();
        renderResults();
        broadcast({ type: "room_snapshot", snapshot: getRoomSnapshot() });
        return;
      }

      if (msg.type === "vote") {
        const img = state.images.find((x) => x.id === msg.imageId);
        if (img) {
          img.votes = img.votes || {};
          img.votes[msg.from] = Number(msg.value);
          renderImages();
          renderResults();
          broadcast({ type: "room_snapshot", snapshot: getRoomSnapshot() });
        }
        return;
      }
    } else {
      if (msg.type === "room_snapshot") {
        applyRoomSnapshot(msg.snapshot);
      }
    }
  });
}

async function hostCreateInvite() {
  if (!isHost()) throw new Error("Only host can invite");

  if (state.pendingInvite?.pc) {
    try {
      state.pendingInvite.pc.close();
    } catch {}
  }

  const pc = new RTCPeerConnection(rtcConfig());
  const dc = pc.createDataChannel("room");
  attachDataChannelHandlers(dc);

  const inviteId = crypto.randomUUID();

  pc.addEventListener("connectionstatechange", () => {
    if (pc.connectionState === "connected") toast("Participant connected");
    if (pc.connectionState === "failed") toast("Connection failed", "Try a new invite.");
  });

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  await waitIceGatheringComplete(pc);

  const payload = {
    t: "offer",
    roomId: state.roomId,
    roomName: state.roomName,
    inviteId,
    sdp: pc.localDescription,
  };

  const text = encodeSignal(payload);
  state.pendingInvite = { pc, dc, offerText: text, inviteId };

  $("#hostOfferText").value = text;
  renderQR("#hostOfferQR", text);
}

async function hostAcceptAnswer(answerText) {
  if (!isHost()) throw new Error("Only host can accept answers");
  if (!state.pendingInvite?.pc) throw new Error("Generate an invite first");

  const payload = decodeSignal(answerText);
  if (payload.t !== "answer") throw new Error("Not an answer payload");
  if (payload.roomId !== state.roomId) throw new Error("Answer is for a different room");
  if (payload.inviteId !== state.pendingInvite.inviteId) throw new Error("Answer does not match current invite");

  const pc = state.pendingInvite.pc;
  const dc = state.pendingInvite.dc;
  const peerId = payload.peerId;

  await pc.setRemoteDescription(payload.sdp);

  dc.addEventListener("open", () => {
    state.peers.set(peerId, { pc, dc });
    // Immediately push snapshot
    dc.send(JSON.stringify({ type: "room_snapshot", snapshot: getRoomSnapshot() }));
  });

  state.pendingInvite = null;
  $("#hostAnswerIn").value = "";
  toast("Connected", "Participant added.");
}

async function participantGenerateAnswer(offerText) {
  state.role = "participant";

  const offerPayload = decodeSignal(offerText);
  if (offerPayload.t !== "offer") throw new Error("Not an offer payload");

  const pc = new RTCPeerConnection(rtcConfig());
  state.pc = pc;

  pc.addEventListener("datachannel", (ev) => {
    state.dc = ev.channel;
    attachDataChannelHandlers(state.dc);
    state.dc.addEventListener("open", () => {
      toast("Connected to host");
    });
  });

  await pc.setRemoteDescription(offerPayload.sdp);
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  await waitIceGatheringComplete(pc);

  // room identity immediately
  state.roomId = offerPayload.roomId;
  state.roomName = offerPayload.roomName;
  renderRoomInfo();

  const answerPayload = {
    t: "answer",
    roomId: offerPayload.roomId,
    inviteId: offerPayload.inviteId,
    peerId: state.peerId,
    sdp: pc.localDescription,
  };

  const text = encodeSignal(answerPayload);
  $("#participantAnswerText").value = text;
  $("#participantAnswerBox").classList.remove("hidden");
  renderQR("#participantAnswerQR", text);
}

async function fileToDataUrl(file) {
  return await new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onerror = () => reject(new Error("File read error"));
    r.onload = () => resolve(String(r.result));
    r.readAsDataURL(file);
  });
}

async function uploadImage(file) {
  mustBeInRoom();

  if (!file) throw new Error("No file selected");
  if (!file.type.startsWith("image/")) throw new Error("File must be an image");
  if (file.size > 2 * 1024 * 1024) throw new Error("Max file size is 2MB for P2P mode");

  $("#btnUpload").disabled = true;
  try {
    const url = await fileToDataUrl(file);
    const img = {
      id: crypto.randomUUID(),
      url,
      originalName: file.name,
      uploadedBy: state.peerId,
      votes: {},
    };

    if (isHost()) {
      state.images.push(img);
      $("#imageCount").textContent = String(state.images.length);
      renderImages();
      renderResults();
      broadcast({ type: "room_snapshot", snapshot: getRoomSnapshot() });
    } else {
      sendToHost({ type: "upload_image", image: img });
    }

    toast("Image sent", file.name);
  } finally {
    $("#btnUpload").disabled = false;
    $("#file").value = "";
  }
}

async function submitVote(imageId, value) {
  mustBeInRoom();
  if (state.phase !== "voting") throw new Error("Voting is not open");

  const v = Number(value);
  if (![1, 2, 3, 4, 5].includes(v)) throw new Error("Vote must be 1-5");

  if (isHost()) {
    const img = state.images.find((x) => x.id === imageId);
    if (!img) throw new Error("Image not found");
    img.votes = img.votes || {};
    img.votes[state.peerId] = v;
    renderImages();
    renderResults();
    broadcast({ type: "room_snapshot", snapshot: getRoomSnapshot() });
  } else {
    sendToHost({ type: "vote", imageId, value: v, from: state.peerId });
  }
}

async function setPhase(nextPhase) {
  mustBeInRoom();
  if (!isHost()) throw new Error("Only host can change phase");
  if (!["collecting", "voting", "closed"].includes(nextPhase)) throw new Error("Invalid phase");

  state.phase = nextPhase;
  renderRoomInfo();
  broadcast({ type: "room_snapshot", snapshot: getRoomSnapshot() });
}

function leaveRoom() {
  // Close peer connections
  if (isHost()) {
    for (const { pc, dc } of state.peers.values()) {
      try {
        dc?.close();
      } catch {}
      try {
        pc?.close();
      } catch {}
    }
    state.peers.clear();
    if (state.pendingInvite?.pc) {
      try {
        state.pendingInvite.pc.close();
      } catch {}
    }
    state.pendingInvite = null;
  } else {
    try {
      state.dc?.close();
    } catch {}
    try {
      state.pc?.close();
    } catch {}
  }

  state.role = null;
  state.roomId = null;
  state.roomName = null;
  state.phase = "collecting";
  state.images = [];
  state.pc = null;
  state.dc = null;

  $("#participantAnswerBox").classList.add("hidden");
  $("#participantAnswerText").value = "";
  renderQR("#participantAnswerQR", "");
  $("#hostOfferText").value = "";
  $("#hostAnswerIn").value = "";
  renderQR("#hostOfferQR", "");

  $("#imageCount").textContent = "0";
  renderRoomInfo();
  renderImages();
  renderResults();
}

function bindUI() {
  $("#btnCreate").addEventListener("click", async () => {
    try {
      const name = $("#newRoomName").value.trim() || "Room";
      state.role = "host";
      state.roomName = name;
      state.roomId = randomRoomId();
      state.phase = "collecting";
      state.images = [];
      $("#imageCount").textContent = "0";
      renderRoomInfo();
      renderImages();
      renderResults();
      await hostCreateInvite();
      toast("Room created", "Generate an invite for each participant.");
    } catch (e) {
      toast("Could not create room", e?.message || String(e));
    }
  });

  $("#btnJoin").addEventListener("click", async () => {
    try {
      const offerText = $("#joinOffer").value.trim();
      await participantGenerateAnswer(offerText);
    } catch (e) {
      toast("Could not join", e?.message || String(e));
    }
  });

  $("#btnLeave").addEventListener("click", () => leaveRoom());

  $("#btnUpload").addEventListener("click", async () => {
    try {
      const f = $("#file").files?.[0];
      await uploadImage(f);
    } catch (e) {
      toast("Upload failed", e?.message || String(e));
    }
  });

  $("#btnStartVoting").addEventListener("click", async () => {
    try {
      if (!state.images.length) {
        toast("Add images first", "At least one image is needed to vote.");
        return;
      }
      await setPhase("voting");
    } catch (e) {
      toast("Could not start voting", e?.message || String(e));
    }
  });

  $("#btnCloseVoting").addEventListener("click", async () => {
    try {
      await setPhase("closed");
    } catch (e) {
      toast("Could not close voting", e?.message || String(e));
    }
  });

  $("#btnNewInvite").addEventListener("click", async () => {
    try {
      await hostCreateInvite();
    } catch (e) {
      toast("Invite error", e?.message || String(e));
    }
  });

  $("#btnAcceptAnswer").addEventListener("click", async () => {
    try {
      await hostAcceptAnswer($("#hostAnswerIn").value);
      await hostCreateInvite();
    } catch (e) {
      toast("Connect error", e?.message || String(e));
    }
  });

  $("#btnCopyOffer").addEventListener("click", async () => {
    const t = $("#hostOfferText").value;
    if (!t) return;
    try {
      await navigator.clipboard.writeText(t);
      toast("Copied", "Offer copied");
    } catch {
      toast("Copy failed");
    }
  });

  $("#btnCopyParticipantAnswer").addEventListener("click", async () => {
    const t = $("#participantAnswerText").value;
    if (!t) return;
    try {
      await navigator.clipboard.writeText(t);
      toast("Copied", "Answer copied");
    } catch {
      toast("Copy failed");
    }
  });
}

function main() {
  bindUI();
  $("#userId").textContent = state.peerId.slice(0, 8);
  renderRoomInfo();
  renderImages();
  renderResults();
}

main();
