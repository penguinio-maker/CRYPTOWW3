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
const turretTurnSpeed = 6.4;
const recoilStrength = 18;
const maxTankHp = 3;
const airdropSpawnMin = 11;
const airdropSpawnMax = 18;
const airdropFallSpeed = 88;
const airdropPickupSize = 18;
const totalDropWaves = 3;
const dropsPerWave = 3;
const dropWaveTimes = [0.2, roundTime * totalRounds * 0.5, roundTime * totalRounds * 0.82];
const LOBBY_START_COUNTDOWN_SECONDS = 5;
const MAP_IDS = ["grass", "desert", "winter"];
const LOBBY_MODE_LIMITS = {
  "1v1": 2,
  "2v2": 4,
  "3v3": 6,
  "4v4": 8
};
const MODE_MAP_SIZE = {
  "1v1": { w: 960, h: 540 },
  "2v2": { w: 960, h: 540 },
  "3v3": { w: 1100, h: 620 },
  "4v4": { w: 1240, h: 700 }
};
const clients = { player0: [], player1: [] };
const nicknames = { player0: "P1", player1: "P2" };
const camos = { player0: "classic", player1: "classic" };
const teamMembers = { player0: [], player1: [] };
const inputs = Object.create(null);
let matchPlayers = [];

const waitingRandom = [];
const lobbies = new Map();
let wss = null;

let state = null;
let matchState = null;
let currentMapId = "grass";
let currentModeId = "1v1";
let currentArenaSizeId = "standard";

function normalizeArenaSizeId(modeId = currentModeId) {
  if (modeId === "3v3") return "large";
  if (modeId === "4v4") return "xl";
  return "standard";
}

function getArenaSize(modeId = currentModeId) {
  return MODE_MAP_SIZE[modeId] || MODE_MAP_SIZE["1v1"];
}

function getLargeModeProfile(modeId = currentModeId) {
  if (modeId === "4v4") return "4v4";
  if (modeId === "3v3") return "3v3";
  return "small";
}

function isLargeTeamMode(modeId = currentModeId) {
  return getLargeModeProfile(modeId) !== "small";
}

function getModeTankScale(modeId = currentModeId) {
  const profile = getLargeModeProfile(modeId);
  if (profile === "4v4") return 1.18;
  if (profile === "3v3") return 1.12;
  return 1;
}

function getModeBulletRadius(modeId = currentModeId) {
  const profile = getLargeModeProfile(modeId);
  if (profile === "4v4") return 5.2;
  if (profile === "3v3") return 4.7;
  return 4;
}

function coverStylesForMap(mapId) {
  if (mapId === "desert") return ["rock", "crate", "sandbag", "crate", "rock"];
  if (mapId === "winter") return ["ice", "crate", "barrier", "crate", "ice"];
  return ["rock", "crate", "log", "crate", "rock"];
}

function coverHpForStyle(style) {
  if (style === "rock" || style === "ice") return Infinity;
  if (style === "sandbag") return 4;
  return 3;
}

function buildLightCover(width, height, mapId) {
  const cx = width / 2;
  const cy = height / 2;
  let items;
  if (mapId === "desert") {
    items = [
      { x: cx - 240, y: cy - 150, w: 46, h: 24, style: "dune-grass" },
      { x: cx + 224, y: cy + 138, w: 42, h: 18, style: "scrap" },
      { x: cx - 24, y: cy + 184, w: 54, h: 20, style: "sand-debris" }
    ];
  } else if (mapId === "winter") {
    items = [
      { x: cx - 228, y: cy - 146, w: 44, h: 26, style: "snowpile" },
      { x: cx + 236, y: cy + 136, w: 38, h: 22, style: "snowpile" },
      { x: cx + 10, y: cy - 196, w: 48, h: 18, style: "frost-shard" }
    ];
  } else {
    items = [
      { x: cx - 232, y: cy - 146, w: 42, h: 24, style: "bush" },
      { x: cx + 228, y: cy + 138, w: 40, h: 22, style: "bush" },
      { x: cx + 12, y: cy - 192, w: 34, h: 20, style: "stump" }
    ];
  }
  const profile = getLargeModeProfile();
  if (profile === "small") return items;
  const extra = mapId === "desert"
    ? [
        { x: width * 0.14, y: height * 0.18, w: 46, h: 18, style: "sand-debris" },
        { x: width * 0.86, y: height * 0.18, w: 46, h: 18, style: "scrap" },
        { x: width * 0.14, y: height * 0.82, w: 44, h: 18, style: "dune-grass" },
        { x: width * 0.86, y: height * 0.82, w: 44, h: 18, style: "sand-debris" },
        { x: width * 0.50, y: height * 0.10, w: 54, h: 18, style: "scrap" },
        { x: width * 0.50, y: height * 0.90, w: 54, h: 18, style: "dune-grass" }
      ]
    : mapId === "winter"
      ? [
          { x: width * 0.14, y: height * 0.18, w: 44, h: 24, style: "snowpile" },
          { x: width * 0.86, y: height * 0.18, w: 44, h: 24, style: "frost-shard" },
          { x: width * 0.14, y: height * 0.82, w: 44, h: 24, style: "snowpile" },
          { x: width * 0.86, y: height * 0.82, w: 44, h: 24, style: "snowpile" },
          { x: width * 0.50, y: height * 0.10, w: 52, h: 18, style: "frost-shard" },
          { x: width * 0.50, y: height * 0.90, w: 52, h: 18, style: "snowpile" }
        ]
      : [
          { x: width * 0.14, y: height * 0.18, w: 40, h: 22, style: "bush" },
          { x: width * 0.86, y: height * 0.18, w: 40, h: 22, style: "stump" },
          { x: width * 0.14, y: height * 0.82, w: 40, h: 22, style: "bush" },
          { x: width * 0.86, y: height * 0.82, w: 40, h: 22, style: "bush" },
          { x: width * 0.50, y: height * 0.10, w: 48, h: 18, style: "stump" },
          { x: width * 0.50, y: height * 0.90, w: 48, h: 18, style: "bush" }
        ];
  return [...items, ...extra];
}

function baseWalls(width, height, mapId) {
  const cx = width / 2;
  const cy = height / 2;
  const sideWallW = 100;
  const sideWallH = 60;
  const centerWallW = 80;
  const centerWallH = 60;
  const xOffset = Math.min(180, Math.max(120, width * 0.17));
  const yOffset = Math.min(96, Math.max(60, height * 0.11));
  const styles = coverStylesForMap(mapId);
  const walls = [
    { x: cx - xOffset - sideWallW / 2, y: cy - yOffset - sideWallH / 2, w: sideWallW, h: sideWallH, hp: coverHpForStyle(styles[0]), style: styles[0] },
    { x: cx - xOffset - sideWallW / 2, y: cy + yOffset - sideWallH / 2, w: sideWallW, h: sideWallH, hp: coverHpForStyle(styles[1]), style: styles[1] },
    { x: cx + xOffset - sideWallW / 2, y: cy - yOffset - sideWallH / 2, w: sideWallW, h: sideWallH, hp: coverHpForStyle(styles[2]), style: styles[2] },
    { x: cx + xOffset - sideWallW / 2, y: cy + yOffset - sideWallH / 2, w: sideWallW, h: sideWallH, hp: coverHpForStyle(styles[3]), style: styles[3] },
    { x: cx - centerWallW / 2, y: cy - centerWallH / 2, w: centerWallW, h: centerWallH, hp: coverHpForStyle(styles[4]), style: styles[4] }
  ];
  const profile = getLargeModeProfile();
  if (profile === "small") return walls;
  const extraTemplates = [
    { x: width * 0.22, y: height * 0.22, w: 88, h: 42, style: styles[1] },
    { x: width * 0.78, y: height * 0.22, w: 88, h: 42, style: styles[2] },
    { x: width * 0.22, y: height * 0.78, w: 88, h: 42, style: styles[3] },
    { x: width * 0.78, y: height * 0.78, w: 88, h: 42, style: styles[0] },
    { x: width * 0.50, y: height * 0.16, w: 76, h: 34, style: styles[4] },
    { x: width * 0.50, y: height * 0.84, w: 76, h: 34, style: styles[4] }
  ];
  if (profile === "4v4") {
    extraTemplates.push(
      { x: width * 0.10, y: height * 0.34, w: 70, h: 32, style: styles[1] },
      { x: width * 0.90, y: height * 0.34, w: 70, h: 32, style: styles[2] },
      { x: width * 0.10, y: height * 0.66, w: 70, h: 32, style: styles[3] },
      { x: width * 0.90, y: height * 0.66, w: 70, h: 32, style: styles[0] }
    );
  }
  return [
    ...walls,
    ...extraTemplates.map((item) => ({
      x: item.x - item.w / 2,
      y: item.y - item.h / 2,
      w: item.w,
      h: item.h,
      hp: coverHpForStyle(item.style),
      style: item.style
    }))
  ];
}

function createTank(x, y, angle, camoId = "classic", meta = {}) {
  const scale = getModeTankScale();
  return {
    x,
    y,
    w: 38 * scale,
    h: 26 * scale,
    angle,
    turretAngle: angle,
    hp: maxTankHp,
    driveSpeed: 0,
    angularVelocity: 0,
    fireCd: 0,
    camoId,
    hasArmor: false,
    armorPop: 0,
    id: meta.id || "",
    team: meta.team || "blue",
    nickname: meta.nickname || ""
  };
}

function normalizeNickname(name, fallback) {
  const clean = (typeof name === "string" ? name : "").trim() || fallback;
  return clean.slice(0, 18);
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

function pickRandomMapId() {
  return MAP_IDS[Math.floor(Math.random() * MAP_IDS.length)] || "grass";
}

function normalizeMapId(mapId) {
  const value = typeof mapId === "string" ? mapId.trim() : "";
  return MAP_IDS.includes(value) ? value : "grass";
}

function makeDefaultInput(aimX = 480, aimY = 270) {
  return { up: false, down: false, left: false, right: false, aimX, aimY, shoot: false };
}

function clearInputState() {
  for (const key of Object.keys(inputs)) delete inputs[key];
}

function getTeamSide(team) {
  return team === "red" ? "player1" : "player0";
}

function buildTeamSpawns(team, count, width, height) {
  const inset = Math.max(120, width * 0.13);
  const x = team === "red" ? width - inset : inset;
  const angle = team === "red" ? Math.PI : 0;
  const margin = 78;
  if (count <= 1) return [{ x, y: height / 2, angle }];

  const usable = Math.max(1, height - margin * 2);
  const step = usable / (count - 1);
  const out = [];
  for (let i = 0; i < count; i++) {
    out.push({ x, y: margin + i * step, angle });
  }
  return out;
}

function randomBetween(min, max) {
  return min + Math.random() * (max - min);
}

function pickAirdropSpot(existingDrops = []) {
  const arenaW = state?.mapWidth || 960;
  const arenaH = state?.mapHeight || 540;
  const size = 24;
  for (let i = 0; i < 18; i++) {
    const x = randomBetween(78, arenaW - 78);
    const y = randomBetween(78, arenaH - 78);
    const rect = { x: x - size / 2, y: y - size / 2, w: size, h: size };
    const nearOtherDrop = existingDrops.some((drop) => Math.hypot((drop.targetX ?? drop.x) - x, (drop.targetY ?? drop.y) - y) < 90);
    if (!(state?.walls || []).some((wall) => rectsOverlap(rect, wall)) && !nearOtherDrop) {
      return { x, y };
    }
  }
  return { x: arenaW / 2, y: arenaH / 2 };
}

function makeAirdrop(existingDrops, delay = 0) {
  const spot = pickAirdropSpot(existingDrops);
  return {
    phase: delay > 0 ? "queued" : "falling",
    pickupType: Math.random() < 0.5 ? "armor" : "medkit",
    x: spot.x,
    y: -36,
    targetX: spot.x,
    targetY: spot.y,
    drift: randomBetween(-10, 10),
    vy: airdropFallSpeed,
    timer: delay
  };
}

function spawnDropWave() {
  if (!state || !matchState) return;
  const planned = [...(state.airdrops || [])];
  for (let i = 0; i < dropsPerWave; i++) {
    const drop = makeAirdrop(planned, i * 0.22);
    planned.push(drop);
    state.airdrops.push(drop);
  }
}

function resetArena(mapId = currentMapId, modeId = currentModeId) {
  currentMapId = normalizeMapId(mapId);
  currentModeId = normalizeLobbyMode(modeId);
  currentArenaSizeId = normalizeArenaSizeId(currentModeId);
  const size = getArenaSize(currentModeId);
  const roster = matchPlayers.length > 0
    ? matchPlayers
    : [
        { id: "player0", team: "blue", nickname: nicknames.player0, camo: camos.player0 },
        { id: "player1", team: "red", nickname: nicknames.player1, camo: camos.player1 }
      ];
  const blueRoster = roster.filter((player) => player.team === "blue");
  const redRoster = roster.filter((player) => player.team === "red");
  const blueSpawns = buildTeamSpawns("blue", blueRoster.length || 1, size.w, size.h);
  const redSpawns = buildTeamSpawns("red", redRoster.length || 1, size.w, size.h);
  const spawnedPlayers = [];

  for (let i = 0; i < blueRoster.length; i++) {
    const member = blueRoster[i];
    const spawn = blueSpawns[i] || blueSpawns[blueSpawns.length - 1];
    spawnedPlayers.push(createTank(spawn.x, spawn.y, spawn.angle, member.camo, member));
  }
  for (let i = 0; i < redRoster.length; i++) {
    const member = redRoster[i];
    const spawn = redSpawns[i] || redSpawns[redSpawns.length - 1];
    spawnedPlayers.push(createTank(spawn.x, spawn.y, spawn.angle, member.camo, member));
  }

  state = {
    players: spawnedPlayers,
    walls: baseWalls(size.w, size.h, currentMapId),
    lightCover: buildLightCover(size.w, size.h, currentMapId),
    bullets: [],
    mapId: currentMapId,
    airdrops: []
  };
  state.mode = currentModeId;
  state.arenaSizeId = currentArenaSizeId;
  state.mapWidth = size.w;
  state.mapHeight = size.h;
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
    matchEnded: false,
    dropWaveIndex: 0,
    matchElapsed: 0
  };
}

function makePublicState() {
  return {
    ...state,
    mapId: state.mapId || currentMapId,
    mode: state.mode || currentModeId,
    arenaSizeId: state.arenaSizeId || currentArenaSizeId,
    mapWidth: state.mapWidth || getArenaSize(currentModeId).w,
    mapHeight: state.mapHeight || getArenaSize(currentModeId).h,
    nicknames: [nicknames.player0, nicknames.player1],
    camos: [camos.player0, camos.player1],
    teams: {
      player0: [...teamMembers.player0],
      player1: [...teamMembers.player1]
    },
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

function activeSockets(playerId) {
  return (clients[playerId] || []).filter((ws) => ws && ws.readyState === 1);
}

function broadcast(payload) {
  const sockets = [...activeSockets("player0"), ...activeSockets("player1")];
  const unique = new Set(sockets);
  for (const ws of unique) send(ws, payload);
}

function bothConnected() {
  return activeSockets("player0").length > 0 && activeSockets("player1").length > 0;
}

function arenaBusy() {
  return activeSockets("player0").length > 0 || activeSockets("player1").length > 0;
}

function clearPlayerSlot(playerId) {
  clients[playerId] = [];
  nicknames[playerId] = playerId === "player0" ? "P1" : "P2";
  camos[playerId] = "classic";
  teamMembers[playerId] = [];
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
    arenaSizeId: lobby.arenaSizeId,
    mapId: lobby.mapId,
    maxPlayers: lobby.maxPlayers,
    countdownActive: !!lobby.countdownActive,
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
      arenaSizeId: lobby.arenaSizeId,
      mapId: lobby.mapId,
      maxPlayers: lobby.maxPlayers,
      isCreator: lobby.host === ws,
      canStart: lobby.host === ws && (lobby.members || []).length >= lobby.maxPlayers && !lobby.countdownActive,
      countdownActive: !!lobby.countdownActive,
      countdownValue: lobby.countdownValue || 0,
      hasPassword: !!lobby.password
    }
  });
}

function refreshLobbyState(lobby) {
  if (!lobby) return;
  for (const member of lobby.members || []) sendLobbyState(member.ws);
}

function sendLobbyUpdateToMembers(lobby, payload) {
  if (!lobby) return;
  for (const member of lobby.members || []) send(member.ws, payload);
}

function clearLobbyCountdown(lobby, notify = false, message = "Countdown cancelled.") {
  if (!lobby) return;
  const hadCountdown = !!lobby.countdownActive || (lobby.countdownValue || 0) > 0;
  if (lobby.countdownTickTimer) {
    clearInterval(lobby.countdownTickTimer);
    lobby.countdownTickTimer = null;
  }
  if (lobby.countdownStartTimer) {
    clearTimeout(lobby.countdownStartTimer);
    lobby.countdownStartTimer = null;
  }
  lobby.countdownActive = false;
  lobby.countdownValue = 0;
  if (notify && hadCountdown) {
    sendLobbyUpdateToMembers(lobby, {
      type: "lobby_countdown_cancelled",
      code: lobby.code,
      message
    });
  }
}

function removeFromLobbies(ws, notify = true) {
  for (const [code, lobby] of lobbies.entries()) {
    if (lobby.host === ws) {
      clearLobbyCountdown(lobby, false);
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
      if (lobby.countdownActive && (lobby.members || []).length < lobby.maxPlayers) {
        clearLobbyCountdown(lobby, true, `Countdown cancelled: need ${lobby.maxPlayers} players.`);
      }
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

function startMatch(
  ws0,
  ws1,
  nick0,
  nick1,
  camo0,
  camo1,
  mapId = "",
  modeId = "1v1",
  team0Roster = null,
  team1Roster = null
) {
  if (arenaBusy()) return false;
  const baseTeam0 = Array.isArray(team0Roster) && team0Roster.length > 0
    ? team0Roster
    : [{ ws: ws0, nickname: nick0, camo: camo0 }];
  const baseTeam1 = Array.isArray(team1Roster) && team1Roster.length > 0
    ? team1Roster
    : [{ ws: ws1, nickname: nick1, camo: camo1 }];

  const roster0 = baseTeam0.filter((member) => member?.ws?.readyState === 1);
  const roster1 = baseTeam1.filter((member) => member?.ws?.readyState === 1);
  if (roster0.length === 0 || roster1.length === 0) return false;
  if (modeId === "1v1" && (roster0.length !== 1 || roster1.length !== 1)) return false;
  if (modeId === "2v2" && (roster0.length !== 2 || roster1.length !== 2)) return false;
  if (modeId === "3v3" && (roster0.length !== 3 || roster1.length !== 3)) return false;
  if (modeId === "4v4" && (roster0.length !== 4 || roster1.length !== 4)) return false;

  clients.player0 = roster0.map((member) => member.ws);
  clients.player1 = roster1.map((member) => member.ws);
  teamMembers.player0 = roster0.map((member) => normalizeNickname(member.nickname, "BLUE"));
  teamMembers.player1 = roster1.map((member) => normalizeNickname(member.nickname, "RED"));
  nicknames.player0 = teamMembers.player0.length > 1 ? `Team A (${teamMembers.player0.length})` : teamMembers.player0[0];
  nicknames.player1 = teamMembers.player1.length > 1 ? `Team B (${teamMembers.player1.length})` : teamMembers.player1[0];
  camos.player0 = normalizeCamo(roster0[0].camo || camo0);
  camos.player1 = normalizeCamo(roster1[0].camo || camo1);

  clearInputState();
  matchPlayers = [];

  for (let i = 0; i < roster0.length; i++) {
    const member = roster0[i];
    const playerId = `blue_${i}`;
    const nickname = normalizeNickname(member.nickname, `BLUE${i + 1}`);
    const camo = normalizeCamo(member.camo || camo0);
    matchPlayers.push({ id: playerId, team: "blue", nickname, camo, ws: member.ws });
    inputs[playerId] = makeDefaultInput();
    member.ws._playerId = playerId;
    member.ws._team = "blue";
    member.ws._closingForMatchEnd = false;
  }
  for (let i = 0; i < roster1.length; i++) {
    const member = roster1[i];
    const playerId = `red_${i}`;
    const nickname = normalizeNickname(member.nickname, `RED${i + 1}`);
    const camo = normalizeCamo(member.camo || camo1);
    matchPlayers.push({ id: playerId, team: "red", nickname, camo, ws: member.ws });
    inputs[playerId] = makeDefaultInput();
    member.ws._playerId = playerId;
    member.ws._team = "red";
    member.ws._closingForMatchEnd = false;
  }

  currentMapId = mapId ? normalizeMapId(mapId) : pickRandomMapId();
  currentModeId = normalizeLobbyMode(modeId);
  currentArenaSizeId = normalizeArenaSizeId(currentModeId);
  resetArena(currentMapId, currentModeId);
  resetMatchState();
  for (const player of matchPlayers) {
    send(player.ws, { type: "welcome", playerId: player.id, team: player.team });
  }
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
      normalizeCamo(b._camo),
      "",
      "1v1"
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

function createLobby(ws, nickname, lobbyNameRaw, passwordRaw, modeRaw, camoRaw, mapRaw) {
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
  const mapId = normalizeMapId(mapRaw);
  const arenaSizeId = mode === "3v3" ? "large" : mode === "4v4" ? "xl" : "standard";
  const maxPlayers = LOBBY_MODE_LIMITS[mode];
  lobbies.set(code, {
    code,
    lobbyName,
    password,
    mode,
    arenaSizeId,
    mapId,
    maxPlayers,
    host: ws,
    hostNick: ws._nick,
    members: [{ ws, nickname: ws._nick, camo: ws._camo }],
    countdownActive: false,
    countdownValue: 0,
    countdownTickTimer: null,
    countdownStartTimer: null
  });
  ws._lobbyCode = code;
  send(ws, { type: "lobby_created", code, lobbyName, mode, arenaSizeId, mapId, maxPlayers, hasPassword: !!password });
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
  if (lobby.countdownActive) {
    send(ws, { type: "error", message: "Countdown already in progress" });
    return;
  }
  if (arenaBusy()) {
    send(ws, { type: "error", message: "Arena busy. Try again." });
    return;
  }

  lobby.countdownActive = true;
  lobby.countdownValue = LOBBY_START_COUNTDOWN_SECONDS;
  sendLobbyUpdateToMembers(lobby, {
    type: "lobby_countdown",
    code,
    secondsLeft: lobby.countdownValue
  });
  refreshLobbyState(lobby);
  broadcastLobbyList();

  lobby.countdownTickTimer = setInterval(() => {
    const activeLobby = lobbies.get(code);
    if (!activeLobby || !activeLobby.countdownActive) return;
    if ((activeLobby.members || []).length < activeLobby.maxPlayers) {
      clearLobbyCountdown(activeLobby, true, `Countdown cancelled: need ${activeLobby.maxPlayers} players.`);
      refreshLobbyState(activeLobby);
      broadcastLobbyList();
      return;
    }
    if (arenaBusy()) {
      clearLobbyCountdown(activeLobby, true, "Arena busy. Try again.");
      refreshLobbyState(activeLobby);
      return;
    }
    if ((activeLobby.countdownValue || 0) <= 1) return;
    activeLobby.countdownValue -= 1;
    sendLobbyUpdateToMembers(activeLobby, {
      type: "lobby_countdown",
      code,
      secondsLeft: activeLobby.countdownValue
    });
    refreshLobbyState(activeLobby);
  }, 1000);

  lobby.countdownStartTimer = setTimeout(() => {
    const activeLobby = lobbies.get(code);
    if (!activeLobby || !activeLobby.countdownActive) return;

    if ((activeLobby.members || []).length < activeLobby.maxPlayers) {
      clearLobbyCountdown(activeLobby, true, `Countdown cancelled: need ${activeLobby.maxPlayers} players.`);
      refreshLobbyState(activeLobby);
      broadcastLobbyList();
      return;
    }
    if (arenaBusy()) {
      clearLobbyCountdown(activeLobby, true, "Arena busy. Try again.");
      refreshLobbyState(activeLobby);
      return;
    }

    clearLobbyCountdown(activeLobby, false);
    const members = activeLobby.members || [];
    const connectedMembers = members.filter((member) => member?.ws?.readyState === 1);
    if (connectedMembers.length < activeLobby.maxPlayers) {
      clearLobbyCountdown(activeLobby, true, `Countdown cancelled: need ${activeLobby.maxPlayers} connected players.`);
      refreshLobbyState(activeLobby);
      broadcastLobbyList();
      return;
    }
    if (connectedMembers.length % 2 !== 0) {
      clearLobbyCountdown(activeLobby, true, "Teams must be even.");
      refreshLobbyState(activeLobby);
      broadcastLobbyList();
      return;
    }
    if (connectedMembers.length < 2) {
      clearLobbyCountdown(activeLobby, true, "Not enough connected players.");
      refreshLobbyState(activeLobby);
      broadcastLobbyList();
      return;
    }

    const teamA = [];
    const teamB = [];
    for (let i = 0; i < connectedMembers.length; i++) {
      if (i % 2 === 0) teamA.push(connectedMembers[i]);
      else teamB.push(connectedMembers[i]);
    }
    if (teamA.length === 0 || teamB.length === 0) {
      clearLobbyCountdown(activeLobby, true, "Unable to build teams.");
      refreshLobbyState(activeLobby);
      broadcastLobbyList();
      return;
    }

    for (const member of connectedMembers) {
      member.ws._lobbyCode = null;
      sendLobbyState(member.ws);
    }

    lobbies.delete(code);

    broadcastLobbyList();
    const started = startMatch(
      teamA[0].ws,
      teamB[0].ws,
      teamA[0].nickname,
      teamB[0].nickname,
      teamA[0].camo,
      teamB[0].camo,
      activeLobby.mapId,
      activeLobby.mode,
      teamA,
      teamB
    );
    if (!started) {
      for (const member of connectedMembers) {
        send(member.ws, { type: "error", message: `Failed to start ${activeLobby.mode}. Team setup invalid.` });
      }
    }
  }, LOBBY_START_COUNTDOWN_SECONDS * 1000);
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
  const arenaW = state?.mapWidth || 960;
  const arenaH = state?.mapHeight || 540;
  if (next.x < 0 || next.y < 0 || next.x + next.w > arenaW || next.y + next.h > arenaH) return false;
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
  tank.armorPop = Math.max(0, (tank.armorPop || 0) - dt);
}

function updateTank(playerId, dt) {
  const tank = state.players.find((item) => item.id === playerId);
  if (!tank) return;
  const inp = inputs[playerId] || makeDefaultInput(tank.x, tank.y);
  if (!inputs[playerId]) inputs[playerId] = inp;

  const throttleInput = (inp.up ? 1 : 0) + (inp.down ? -1 : 0);
  const turnInput = (inp.right ? 1 : 0) + (inp.left ? -1 : 0);
  updateTankDrive(tank, dt, throttleInput, turnInput);

  const targetTurretAngle = Math.atan2(inp.aimY - tank.y, inp.aimX - tank.x);
  const turretDiff = normalizeAngleDiff(tank.turretAngle ?? tank.angle, targetTurretAngle);
  const turretStep = clamp(turretDiff, -turretTurnSpeed * dt, turretTurnSpeed * dt);
  tank.turretAngle = (tank.turretAngle ?? tank.angle) + turretStep;

  if (inp.shoot && tank.fireCd <= 0) {
    const fireAngle = tank.turretAngle ?? tank.angle;
    const muzzle = Math.max(24, tank.w * 0.64);
    tank.fireCd = 0.45;
    state.bullets.push({
      x: tank.x + Math.cos(fireAngle) * muzzle,
      y: tank.y + Math.sin(fireAngle) * muzzle,
      vx: Math.cos(fireAngle) * 380,
      vy: Math.sin(fireAngle) * 380,
      r: getModeBulletRadius(),
      owner: playerId,
      ownerTeam: tank.team || ""
    });
    tank.driveSpeed -= recoilStrength;
  }

  inp.shoot = false;
}

function teamHp(team) {
  return (state?.players || [])
    .filter((tank) => tank.team === team)
    .reduce((sum, tank) => sum + Math.max(0, tank.hp || 0), 0);
}

function isTeamAlive(team) {
  return (state?.players || []).some((tank) => tank.team === team && tank.hp > 0);
}

function decideRoundWinnerByHp() {
  const blueHp = teamHp("blue");
  const redHp = teamHp("red");
  if (blueHp > redHp) return "blue";
  if (redHp > blueHp) return "red";
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

  const blueWins = matchState.roundWinners.filter((x) => x === "blue").length;
  const redWins = matchState.roundWinners.filter((x) => x === "red").length;
  const finalWinner = blueWins === redWins ? "draw" : blueWins > redWins ? "blue" : "red";

  broadcast({ type: "end", winnerId: finalWinner, roundWinners: [...matchState.roundWinners] });

  const closingSockets = [...activeSockets("player0"), ...activeSockets("player1")];
  const uniqueSockets = [...new Set(closingSockets)];
  for (const ws of uniqueSockets) ws._closingForMatchEnd = true;
  setTimeout(() => {
    for (const ws of uniqueSockets) {
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
  resetArena(currentMapId, currentModeId);
}

function updateBullets(dt) {
  for (let i = state.bullets.length - 1; i >= 0; i--) {
    const b = state.bullets[i];
    b.x += b.vx * dt;
    b.y += b.vy * dt;

    const arenaW = state?.mapWidth || 960;
    const arenaH = state?.mapHeight || 540;
    if (b.x < -10 || b.y < -10 || b.x > arenaW + 10 || b.y > arenaH + 10) {
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

    const ownerTank = state.players.find((tank) => tank.id === b.owner);
    const ownerTeam = b.ownerTeam || ownerTank?.team || "";
    for (let p = 0; p < state.players.length; p++) {
      const tank = state.players[p];
      if (!tank || tank.hp <= 0) continue;
      if (ownerTeam && tank.team === ownerTeam) continue;
      const rect = tankRect(tank);
      if (b.x > rect.x && b.x < rect.x + rect.w && b.y > rect.y && b.y < rect.y + rect.h) {
        state.bullets.splice(i, 1);
        if (tank.hasArmor) {
          tank.hasArmor = false;
          tank.armorPop = 0.22;
        } else {
          tank.hp -= 1;
          if (tank.hp <= 0) {
            if (tank.id && inputs[tank.id]) delete inputs[tank.id];
            state.players.splice(p, 1);
            const blueAlive = isTeamAlive("blue");
            const redAlive = isTeamAlive("red");
            if (!blueAlive || !redAlive) {
              const winnerId = blueAlive && !redAlive ? "blue" : redAlive && !blueAlive ? "red" : "draw";
              finishRound(winnerId);
            }
          }
        }
        break;
      }
    }
  }
}

function updateAirdrop(dt) {
  if (!state || !matchState || matchState.roundEnded || matchState.matchEnded) return;
  matchState.matchElapsed += dt;
  while (matchState.dropWaveIndex < totalDropWaves && matchState.matchElapsed >= dropWaveTimes[matchState.dropWaveIndex]) {
    spawnDropWave();
    matchState.dropWaveIndex += 1;
  }

  for (let i = state.airdrops.length - 1; i >= 0; i--) {
    const drop = state.airdrops[i];
    if (drop.phase === "queued") {
      drop.timer -= dt;
      if (drop.timer <= 0) {
        drop.phase = "falling";
        drop.timer = 0;
      }
      continue;
    }

    if (drop.phase === "falling") {
      drop.x += drop.drift * dt;
      drop.y += drop.vy * dt;
      if (drop.y >= drop.targetY) {
        drop.y = drop.targetY;
        drop.phase = "landed";
        drop.timer = 0.28;
        drop.drift = 0;
      }
      continue;
    }

    if (drop.phase === "landed") {
      drop.timer -= dt;
      if (drop.timer <= 0) {
        drop.phase = "pickup";
        drop.timer = 0;
      }
      continue;
    }

    if (drop.phase !== "pickup") continue;

    let consumed = false;
    for (const tank of state.players) {
      if (Math.abs(tank.x - drop.x) <= tank.w / 2 + airdropPickupSize / 2 && Math.abs(tank.y - drop.y) <= tank.h / 2 + airdropPickupSize / 2) {
        if (drop.pickupType === "armor") {
          if (!tank.hasArmor) {
            tank.hasArmor = true;
            tank.armorPop = 0;
            consumed = true;
          }
        } else if (tank.hp < maxTankHp) {
          tank.hp = Math.min(maxTankHp, tank.hp + 1);
          consumed = true;
        }
      }
      if (consumed) break;
    }
    if (consumed) state.airdrops.splice(i, 1);
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
  ws._team = "";
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
      createLobby(ws, msg.nickname, msg.lobbyName, msg.password, msg.mode, msg.camo, msg.mapId);
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

    if (ws._team === "blue" || ws._team === "red") {
      const me = getTeamSide(ws._team);
      const other = me === "player0" ? "player1" : "player0";
      clients[me] = activeSockets(me).filter((sock) => sock !== ws);
      matchPlayers = matchPlayers.filter((player) => player.ws !== ws);
      if (ws._playerId && inputs[ws._playerId]) delete inputs[ws._playerId];

      if (clients[me].length === 0) {
        teamMembers[me] = [];
        nicknames[me] = me === "player0" ? "P1" : "P2";
        if (!ws._closingForMatchEnd) {
          const otherSockets = activeSockets(other);
          for (const otherWs of otherSockets) {
            send(otherWs, { type: "error", message: "Opponent disconnected" });
            otherWs._closingForMatchEnd = true;
            otherWs.close(1000, "opponent-disconnected");
          }
          clearPlayerSlot(other);
        }
      }

      if (!arenaBusy()) {
        clearPlayerSlot("player0");
        clearPlayerSlot("player1");
        matchPlayers = [];
        clearInputState();
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
      for (const tank of state.players || []) {
        updateTank(tank.id, dt);
      }
      updateBullets(dt);
      updateAirdrop(dt);

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
