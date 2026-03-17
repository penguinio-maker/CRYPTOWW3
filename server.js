const http = require("http");
const { WebSocketServer } = require("ws");

const PORT = Number(process.env.PORT) || 3000;
const TICK_MS = 33;
const totalRounds = 3;
const roundTime = 60;

const maxForwardSpeed = 190;
const maxReverseSpeed = 115;
const acceleration = 520;
const braking = 780;
const friction = 5.2;
const turnSpeed = 3.4;
const recoilStrength = 18;
const LOBBY_MODE_LIMITS = {
  "1v1": 2,
  "2v2": 4,
  "3v3": 6,
  "4v4": 8
};

const clients = { player0: null, player1: null };
const nicknames = { player0: "P1", player1: "P2" };
const camos = { player0: "classic", player1: "classic" };
const inputs = {
  player0: { up: false, down: false, left: false, right: false, aimX: 480, aimY: 270, shoot: false },
  player1: { up: false, down: false, left: false, right: false, aimX: 480, aimY: 270, shoot: false }
};

const waitingRandom = [];
const lobbies = new Map();
let wss = null;

let state = null;
let matchState = null;

function baseWalls() {
  return [
    { x: 300, y: 180, w: 100, h: 60, hp: 3 },
    { x: 300, y: 300, w: 100, h: 60, hp: 3 },
    { x: 560, y: 180, w: 100, h: 60, hp: 3 },
    { x: 560, y: 300, w: 100, h: 60, hp: 3 },
    { x: 440, y: 240, w: 80, h: 60, hp: 3 }
  ];
}

function createTank(x, y, angle) {
  return { x, y, w: 38, h: 26, angle, hp: 3, driveSpeed: 0, angularVelocity: 0, fireCd: 0 };
}

function normalizeNickname(name, fallback) {
  const clean = (typeof name === "string" ? name : "").trim() || fallback;
  return clean.slice(0, 12);
}

function normalizeLobbyName(name, fallback) {
  const clean = (typeof name === "string" ? name : "").trim() || fallback;
  return clean.slice(0, 24);
}

function normalizeLobbyPassword(password) {
  return (typeof password === "string" ? password : "").trim().slice(0, 24);
}

function normalizeLobbyMode(mode) {
  const value = typeof mode === "string" ? mode.trim() : "";
  return LOBBY_MODE_LIMITS[value] ? value : "1v1";
}

function normalizeCamo(camo) {
  const value = typeof camo === "string" ? camo.trim() : "";
  return value || "classic";
}

function resetArena() {
  state = {
    players: [createTank(120, 270, 0), createTank(840, 270, Math.PI)],
    walls: baseWalls(),
    bullets: []
  };
}

function resetMatchState() {
  matchState = {
    totalRounds,
    roundTime,
    currentRound: 1,
    roundTimeLeft: roundTime,
    roundWinners: [],
    roundEnded: false,
    roundResult: "draw",
    roundPauseLeft: 0,
    matchEnded: false
  };
}

function makePublicState() {
  return {
    ...state,
    nicknames: [nicknames.player0, nicknames.player1],
    camos: [camos.player0, camos.player1],
    match: {
      totalRounds,
      roundTime,
      currentRound: matchState.currentRound,
      roundTimeLeft: matchState.roundTimeLeft,
      roundWinners: [...matchState.roundWinners],
      roundEnded: matchState.roundEnded,
      roundResult: matchState.roundResult
    }
  };
}

function send(ws, payload) {
  if (!ws || ws.readyState !== 1) return;
  ws.send(JSON.stringify(payload));
}

function broadcast(payload) {
  send(clients.player0, payload);
  send(clients.player1, payload);
}

function bothConnected() {
  return clients.player0 && clients.player1;
}

function arenaBusy() {
  return !!clients.player0 || !!clients.player1;
}

function clearPlayerSlot(playerId) {
  clients[playerId] = null;
  nicknames[playerId] = playerId === "player0" ? "P1" : "P2";
  camos[playerId] = "classic";
  inputs[playerId] = { up: false, down: false, left: false, right: false, aimX: 480, aimY: 270, shoot: false };
}

function removeFromRandomQueue(ws) {
  const idx = waitingRandom.indexOf(ws);
  if (idx >= 0) waitingRandom.splice(idx, 1);
}

function getLobbyMemberNames(lobby) {
  return (lobby.members || []).map((member) => member.nickname);
}

function getLobbyMemberCamos(lobby) {
  return (lobby.members || []).map((member) => member.camo);
}

function lobbyPublicView(lobby) {
  return {
    code: lobby.code,
    lobbyName: lobby.lobbyName,
    creatorNickname: lobby.hostNick,
    joinedNickname: getLobbyMemberNames(lobby)[1] || "",
    memberNicknames: getLobbyMemberNames(lobby),
    memberCamos: getLobbyMemberCamos(lobby),
    playerCount: (lobby.members || []).length,
    mode: lobby.mode,
    maxPlayers: lobby.maxPlayers,
    hasPassword: !!lobby.password
  };
}

function sendLobbyList(ws) {
  if (!ws || ws.readyState !== 1) return;
  const items = [];
  for (const lobby of lobbies.values()) {
    if (!lobby.host || lobby.host.readyState !== 1) continue;
    items.push(lobbyPublicView(lobby));
  }
  send(ws, { type: "lobby_list", lobbies: items });
}

function broadcastLobbyList() {
  if (!wss) return;
  for (const client of wss.clients) sendLobbyList(client);
}

function sendLobbyState(ws) {
  if (!ws || ws.readyState !== 1) return;
  const code = ws._lobbyCode;
  if (!code) {
    send(ws, { type: "lobby_state", lobby: null });
    return;
  }

  const lobby = lobbies.get(code);
  if (!lobby || !lobby.host || lobby.host.readyState !== 1) {
    ws._lobbyCode = null;
    send(ws, { type: "lobby_state", lobby: null });
    return;
  }

  send(ws, {
    type: "lobby_state",
    lobby: {
      code: lobby.code,
      lobbyName: lobby.lobbyName,
      creatorNickname: lobby.hostNick,
      joinedNickname: getLobbyMemberNames(lobby)[1] || "",
      memberNicknames: getLobbyMemberNames(lobby),
      memberCamos: getLobbyMemberCamos(lobby),
      playerCount: (lobby.members || []).length,
      mode: lobby.mode,
      maxPlayers: lobby.maxPlayers,
      isCreator: lobby.host === ws,
      canStart: lobby.host === ws && (lobby.members || []).length >= lobby.maxPlayers,
      hasPassword: !!lobby.password
    }
  });
}

function refreshLobbyState(lobby) {
  if (!lobby) return;
  for (const member of lobby.members || []) sendLobbyState(member.ws);
}

function removeFromLobbies(ws, notify = true) {
  for (const [code, lobby] of lobbies.entries()) {
    if (lobby.host === ws) {
      for (const member of lobby.members || []) {
        if (member.ws === ws) continue;
        member.ws._lobbyCode = null;
        if (notify) send(member.ws, { type: "error", message: "Lobby closed by host" });
        sendLobbyState(member.ws);
      }
      lobbies.delete(code);
      ws._lobbyCode = null;
      sendLobbyState(ws);
      broadcastLobbyList();
      return true;
    }
    const memberIndex = (lobby.members || []).findIndex((member) => member.ws === ws);
    if (memberIndex >= 0) {
      lobby.members.splice(memberIndex, 1);
      ws._lobbyCode = null;
      if (notify) send(lobby.host, { type: "lobby_waiting", code, message: "Player left the lobby." });
      refreshLobbyState(lobby);
      sendLobbyState(ws);
      broadcastLobbyList();
      return true;
    }
  }
  return false;
}

function leavePending(ws, notify = true) {
  removeFromRandomQueue(ws);
  removeFromLobbies(ws, notify);
}

function generateLobbyCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  for (let attempt = 0; attempt < 20; attempt++) {
    let code = "";
    for (let i = 0; i < 5; i++) code += chars[Math.floor(Math.random() * chars.length)];
    if (!lobbies.has(code)) return code;
  }
  return `${Date.now().toString(36).slice(-5).toUpperCase()}`;
}

function startMatch(ws0, ws1, nick0, nick1, camo0, camo1) {
  if (arenaBusy()) return false;
  clients.player0 = ws0;
  clients.player1 = ws1;
  nicknames.player0 = nick0;
  nicknames.player1 = nick1;
  camos.player0 = normalizeCamo(camo0);
  camos.player1 = normalizeCamo(camo1);

  ws0._playerId = "player0";
  ws1._playerId = "player1";
  ws0._closingForMatchEnd = false;
  ws1._closingForMatchEnd = false;

  resetArena();
  resetMatchState();
  send(ws0, { type: "welcome", playerId: "player0" });
  send(ws1, { type: "welcome", playerId: "player1" });
  broadcast({ type: "start", state: makePublicState() });
  return true;
}

function tryStartPendingMatch() {
  if (arenaBusy()) return;

  while (waitingRandom.length > 0 && waitingRandom[0].readyState !== 1) waitingRandom.shift();
  while (waitingRandom.length > 1 && waitingRandom[1].readyState !== 1) waitingRandom.splice(1, 1);

  if (waitingRandom.length >= 2) {
    const a = waitingRandom.shift();
    const b = waitingRandom.shift();
    startMatch(
      a,
      b,
      normalizeNickname(a._nick, "P1"),
      normalizeNickname(b._nick, "P2"),
      normalizeCamo(a._camo),
      normalizeCamo(b._camo)
    );
  }
}

function queueRandom(ws, nickname, camoRaw) {
  ws._nick = normalizeNickname(nickname, ws._nick || "PLAYER");
  ws._camo = normalizeCamo(camoRaw || ws._camo);
  leavePending(ws, false);
  if (!waitingRandom.includes(ws)) waitingRandom.push(ws);
  send(ws, { type: "queue", message: "Searching for player..." });
  tryStartPendingMatch();
}

function createLobby(ws, nickname, lobbyNameRaw, passwordRaw, modeRaw, camoRaw) {
  ws._nick = normalizeNickname(nickname, ws._nick || "PLAYER");
  ws._camo = normalizeCamo(camoRaw || ws._camo);
  const lobbyNameInput = (typeof lobbyNameRaw === "string" ? lobbyNameRaw : "").trim();
  if (!lobbyNameInput) {
    send(ws, { type: "error", message: "Lobby name is required." });
    return;
  }
  leavePending(ws, false);
  const code = generateLobbyCode();
  const lobbyName = normalizeLobbyName(lobbyNameInput, `${ws._nick}'s Lobby`);
  const password = normalizeLobbyPassword(passwordRaw);
  const mode = normalizeLobbyMode(modeRaw);
  const maxPlayers = LOBBY_MODE_LIMITS[mode];
  lobbies.set(code, {
    code,
    lobbyName,
    password,
    mode,
    maxPlayers,
    host: ws,
    hostNick: ws._nick,
    members: [{ ws, nickname: ws._nick, camo: ws._camo }]
  });
  ws._lobbyCode = code;
  send(ws, { type: "lobby_created", code, lobbyName, mode, maxPlayers, hasPassword: !!password });
  send(ws, { type: "lobby_waiting", code, message: `Waiting for players (${1}/${maxPlayers})...` });
  sendLobbyState(ws);
  broadcastLobbyList();
}

function joinLobby(ws, codeRaw, nickname, passwordRaw, camoRaw) {
  const code = String(codeRaw || "").trim().toUpperCase();
  if (!code) {
    send(ws, { type: "error", message: "Enter lobby code" });
    return;
  }

  const lobby = lobbies.get(code);
  if (!lobby || !lobby.host || lobby.host.readyState !== 1) {
    send(ws, { type: "error", message: "Lobby not found" });
    return;
  }
  if ((lobby.members || []).length >= lobby.maxPlayers) {
    send(ws, { type: "error", message: "Lobby is full" });
    return;
  }
  if (lobby.host === ws) {
    send(ws, { type: "error", message: "You are already host of this lobby" });
    return;
  }
  const password = normalizeLobbyPassword(passwordRaw);
  if (lobby.password && password !== lobby.password) {
    send(ws, {
      type: "join_password_required",
      code,
      lobbyName: lobby.lobbyName,
      message: password ? "Wrong password. Try again." : "Enter password"
    });
    return;
  }

  ws._nick = normalizeNickname(nickname, ws._nick || "PLAYER");
  ws._camo = normalizeCamo(camoRaw || ws._camo);
  leavePending(ws, false);
  ws._lobbyCode = code;
  lobby.members.push({ ws, nickname: ws._nick, camo: ws._camo });

  const playerCount = lobby.members.length;
  const lobbyMessage = playerCount >= lobby.maxPlayers
    ? "Lobby is ready to start."
    : `Waiting for players (${playerCount}/${lobby.maxPlayers})...`;
  send(ws, { type: "lobby_waiting", code, message: lobbyMessage });
  send(lobby.host, { type: "lobby_waiting", code, message: lobbyMessage });
  refreshLobbyState(lobby);
  broadcastLobbyList();
}

function startLobbyGame(ws) {
  const code = ws._lobbyCode;
  if (!code) {
    send(ws, { type: "error", message: "You are not in a lobby" });
    return;
  }

  const lobby = lobbies.get(code);
  if (!lobby || !lobby.host || lobby.host.readyState !== 1) {
    ws._lobbyCode = null;
    send(ws, { type: "error", message: "Lobby not found" });
    sendLobbyState(ws);
    broadcastLobbyList();
    return;
  }

  if (lobby.host !== ws) {
    send(ws, { type: "error", message: "Only creator can start the game" });
    return;
  }
  if ((lobby.members || []).length < lobby.maxPlayers) {
    send(ws, { type: "error", message: `Need ${lobby.maxPlayers} players to start ${lobby.mode}` });
    refreshLobbyState(lobby);
    return;
  }
  if (lobby.mode !== "1v1") {
    send(ws, { type: "error", message: `${lobby.mode} battles are not available yet` });
    refreshLobbyState(lobby);
    return;
  }
  if (arenaBusy()) {
    send(ws, { type: "error", message: "Arena busy. Try again." });
    return;
  }

  lobbies.delete(code);
  const [hostMember, guestMember] = lobby.members;
  hostMember.ws._lobbyCode = null;
  guestMember.ws._lobbyCode = null;
  broadcastLobbyList();
  startMatch(hostMember.ws, guestMember.ws, hostMember.nickname, guestMember.nickname, hostMember.camo, guestMember.camo);
}

function cancelQueue(ws) {
  const wasInRandom = waitingRandom.includes(ws);
  const wasInLobby = removeFromLobbies(ws, true);
  removeFromRandomQueue(ws);

  if (wasInRandom || wasInLobby) {
    send(ws, { type: "cancelled", message: "Search cancelled" });
  } else {
    send(ws, { type: "cancelled", message: "Nothing to cancel" });
  }
  sendLobbyState(ws);
  sendLobbyList(ws);
}

function rectsOverlap(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

function tankRect(t) {
  return { x: t.x - t.w / 2, y: t.y - t.h / 2, w: t.w, h: t.h };
}

function canMoveTo(tank, nx, ny) {
  const next = { x: nx - tank.w / 2, y: ny - tank.h / 2, w: tank.w, h: tank.h };
  if (next.x < 0 || next.y < 0 || next.x + next.w > 960 || next.y + next.h > 540) return false;
  for (const wall of state.walls) if (rectsOverlap(next, wall)) return false;
  return true;
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function normalizeAngleDiff(from, to) {
  return Math.atan2(Math.sin(to - from), Math.cos(to - from));
}

function moveTankWithSlide(tank, dt) {
  const vx = Math.cos(tank.angle) * tank.driveSpeed;
  const vy = Math.sin(tank.angle) * tank.driveSpeed;
  const nx = tank.x + vx * dt;
  const ny = tank.y + vy * dt;

  if (canMoveTo(tank, nx, ny)) {
    tank.x = nx;
    tank.y = ny;
    return;
  }

  let moved = false;
  if (canMoveTo(tank, nx, tank.y)) {
    tank.x = nx;
    moved = true;
  }
  if (canMoveTo(tank, tank.x, ny)) {
    tank.y = ny;
    moved = true;
  }

  if (moved) tank.driveSpeed *= 0.76;
  else tank.driveSpeed *= 0.2;
}

function updateTankDrive(tank, dt, throttleInput, turnInput) {
  const targetSpeed = throttleInput >= 0 ? throttleInput * maxForwardSpeed : throttleInput * maxReverseSpeed;
  const changingDirection = Math.sign(targetSpeed) !== Math.sign(tank.driveSpeed) && Math.abs(tank.driveSpeed) > 4 && Math.abs(targetSpeed) > 0;
  const accelRate = changingDirection ? braking : acceleration;

  if (Math.abs(targetSpeed) > 0.01) {
    tank.driveSpeed += clamp(targetSpeed - tank.driveSpeed, -accelRate * dt, accelRate * dt);
  } else {
    const stopMul = Math.exp(-friction * dt);
    tank.driveSpeed *= stopMul;
    if (Math.abs(tank.driveSpeed) < 1.5) tank.driveSpeed = 0;
  }

  const speedRatio = Math.min(Math.abs(tank.driveSpeed) / maxForwardSpeed, 1);
  const turnGrip = 1 - speedRatio * 0.4;
  const targetAngular = turnInput * turnSpeed * turnGrip;
  tank.angularVelocity += clamp(targetAngular - tank.angularVelocity, -14 * dt, 14 * dt);
  tank.angularVelocity *= Math.exp(-7 * dt);
  tank.angle += tank.angularVelocity * dt;

  moveTankWithSlide(tank, dt);
  tank.fireCd = Math.max(0, tank.fireCd - dt);
}

function updateTank(playerId, dt) {
  const idx = playerId === "player0" ? 0 : 1;
  const tank = state.players[idx];
  const inp = inputs[playerId];

  const throttleInput = (inp.up ? 1 : 0) + (inp.down ? -1 : 0);
  const turnInput = (inp.right ? 1 : 0) + (inp.left ? -1 : 0);
  updateTankDrive(tank, dt, throttleInput, turnInput);

  const aimAngle = Math.atan2(inp.aimY - tank.y, inp.aimX - tank.x);
  const align = normalizeAngleDiff(tank.angle, aimAngle);
  tank.angularVelocity += clamp(align * 3.1, -3.5, 3.5) * dt;

  if (inp.shoot && tank.fireCd <= 0) {
    tank.fireCd = 0.45;
    state.bullets.push({
      x: tank.x + Math.cos(tank.angle) * 24,
      y: tank.y + Math.sin(tank.angle) * 24,
      vx: Math.cos(tank.angle) * 380,
      vy: Math.sin(tank.angle) * 380,
      r: 4,
      owner: playerId
    });
    tank.driveSpeed -= recoilStrength;
  }

  inputs[playerId].shoot = false;
}

function decideRoundWinnerByHp() {
  const p0 = state.players[0].hp;
  const p1 = state.players[1].hp;
  if (p0 > p1) return "player0";
  if (p1 > p0) return "player1";
  return "draw";
}

function finishRound(winnerId) {
  if (!matchState || matchState.roundEnded || matchState.matchEnded) return;
  matchState.roundEnded = true;
  matchState.roundResult = winnerId;
  matchState.roundWinners.push(winnerId);
  matchState.roundPauseLeft = 1.05;
}

function finishMatch() {
  if (!matchState || matchState.matchEnded) return;
  matchState.matchEnded = true;

  const p0Wins = matchState.roundWinners.filter((x) => x === "player0").length;
  const p1Wins = matchState.roundWinners.filter((x) => x === "player1").length;
  const finalWinner = p0Wins === p1Wins ? "draw" : p0Wins > p1Wins ? "player0" : "player1";

  broadcast({ type: "end", winnerId: finalWinner, roundWinners: [...matchState.roundWinners] });

  const closingSockets = [clients.player0, clients.player1].filter(Boolean);
  for (const ws of closingSockets) ws._closingForMatchEnd = true;
  setTimeout(() => {
    for (const ws of closingSockets) {
      if (ws.readyState === 1) ws.close(1000, "match-ended");
    }
  }, 150);
}

function nextRoundOrFinish() {
  if (!matchState || !matchState.roundEnded || matchState.matchEnded) return;
  if (matchState.currentRound >= totalRounds) {
    finishMatch();
    return;
  }

  matchState.currentRound += 1;
  matchState.roundTimeLeft = roundTime;
  matchState.roundEnded = false;
  matchState.roundResult = "draw";
  matchState.roundPauseLeft = 0;
  resetArena();
}

function updateBullets(dt) {
  for (let i = state.bullets.length - 1; i >= 0; i--) {
    const b = state.bullets[i];
    b.x += b.vx * dt;
    b.y += b.vy * dt;

    if (b.x < -10 || b.y < -10 || b.x > 970 || b.y > 550) {
      state.bullets.splice(i, 1);
      continue;
    }

    let hitWall = false;
    for (let w = state.walls.length - 1; w >= 0; w--) {
      const wall = state.walls[w];
      if (b.x > wall.x && b.x < wall.x + wall.w && b.y > wall.y && b.y < wall.y + wall.h) {
        wall.hp -= 1;
        if (wall.hp <= 0) state.walls.splice(w, 1);
        state.bullets.splice(i, 1);
        hitWall = true;
        break;
      }
    }
    if (hitWall) continue;

    for (let p = 0; p < 2; p++) {
      const tank = state.players[p];
      const ownerIdx = b.owner === "player0" ? 0 : 1;
      if (ownerIdx === p) continue;
      const rect = tankRect(tank);
      if (b.x > rect.x && b.x < rect.x + rect.w && b.y > rect.y && b.y < rect.y + rect.h) {
        tank.hp -= 1;
        state.bullets.splice(i, 1);
        if (tank.hp <= 0) {
          const winnerId = p === 0 ? "player1" : "player0";
          finishRound(winnerId);
        }
        break;
      }
    }
  }
}

const httpServer = http.createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");

  if (req.method === "GET" && (req.url === "/" || req.url === "/health")) {
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Server is running");
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Not found");
});

wss = new WebSocketServer({ server: httpServer });

wss.on("connection", (ws) => {
  ws._nick = "PLAYER";
  ws._lobbyCode = null;
  ws._playerId = null;
  ws._closingForMatchEnd = false;

  sendLobbyList(ws);
  sendLobbyState(ws);

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (msg.type === "join_random" || msg.type === "join") {
      queueRandom(ws, msg.nickname, msg.camo);
      return;
    }

    if (msg.type === "create_lobby") {
      createLobby(ws, msg.nickname, msg.lobbyName, msg.password, msg.mode, msg.camo);
      return;
    }

    if (msg.type === "list_lobbies") {
      sendLobbyList(ws);
      sendLobbyState(ws);
      return;
    }

    if (msg.type === "join_lobby") {
      joinLobby(ws, msg.code, msg.nickname, msg.password, msg.camo);
      return;
    }

    if (msg.type === "start_lobby_game") {
      startLobbyGame(ws);
      return;
    }

    if (msg.type === "cancel_queue") {
      cancelQueue(ws);
      return;
    }

    if (msg.type === "input" && ws._playerId) {
      inputs[ws._playerId] = {
        up: !!msg.up,
        down: !!msg.down,
        left: !!msg.left,
        right: !!msg.right,
        aimX: Number(msg.aimX) || 0,
        aimY: Number(msg.aimY) || 0,
        shoot: !!msg.shoot
      };
    }
  });

  ws.on("close", () => {
    leavePending(ws, true);

    if (ws._playerId === "player0" || ws._playerId === "player1") {
      const me = ws._playerId;
      const other = me === "player0" ? "player1" : "player0";
      const otherWs = clients[other];
      clearPlayerSlot(me);

      if (!ws._closingForMatchEnd && otherWs && otherWs.readyState === 1) {
        send(otherWs, { type: "error", message: "Opponent disconnected" });
        otherWs._closingForMatchEnd = true;
        otherWs.close(1000, "opponent-disconnected");
      }

      if (!clients.player0 && !clients.player1) {
        resetArena();
        resetMatchState();
        tryStartPendingMatch();
      }
    }
  });
});

resetArena();
resetMatchState();
setInterval(() => {
  if (!bothConnected()) return;

  const dt = TICK_MS / 1000;
  if (!matchState.matchEnded) {
    if (!matchState.roundEnded) {
      updateTank("player0", dt);
      updateTank("player1", dt);
      updateBullets(dt);

      matchState.roundTimeLeft = Math.max(0, matchState.roundTimeLeft - dt);
      if (matchState.roundTimeLeft <= 0) {
        finishRound(decideRoundWinnerByHp());
      }
    } else {
      matchState.roundPauseLeft -= dt;
      if (matchState.roundPauseLeft <= 0) {
        nextRoundOrFinish();
      }
    }
  }

  broadcast({ type: "state", state: makePublicState() });
}, TICK_MS);

httpServer.listen(PORT, () => {
  console.log(`Tank server listening on port ${PORT}`);
});
