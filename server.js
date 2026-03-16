const http = require("http");
const { WebSocketServer } = require("ws");

const PORT = Number(process.env.PORT) || 3000;
const TICK_MS = 33;

const clients = { player0: null, player1: null };
const nicknames = { player0: "P1", player1: "P2" };
const inputs = {
  player0: { up: false, down: false, left: false, right: false, aimX: 480, aimY: 270, shoot: false },
  player1: { up: false, down: false, left: false, right: false, aimX: 480, aimY: 270, shoot: false }
};

let state = null;

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
  return { x, y, w: 38, h: 26, angle, hp: 3, speed: 170, fireCd: 0 };
}

function resetMatch() {
  state = {
    players: [createTank(120, 270, 0), createTank(840, 270, Math.PI)],
    walls: baseWalls(),
    bullets: []
  };
}

function bothConnected() {
  return clients.player0 && clients.player1;
}

function send(ws, payload) {
  if (!ws || ws.readyState !== 1) return;
  ws.send(JSON.stringify(payload));
}

function broadcast(payload) {
  send(clients.player0, payload);
  send(clients.player1, payload);
}

function startIfReady() {
  if (!bothConnected()) return;
  resetMatch();
  broadcast({ type: "start", state: { ...state, nicknames: [nicknames.player0, nicknames.player1] } });
}

function queueNotice() {
  broadcast({ type: "queue" });
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

function updateTank(id, dt) {
  const idx = id === "player0" ? 0 : 1;
  const tank = state.players[idx];
  const inp = inputs[id];

  let dx = 0;
  let dy = 0;
  if (inp.up) dy -= 1;
  if (inp.down) dy += 1;
  if (inp.left) dx -= 1;
  if (inp.right) dx += 1;

  if (dx || dy) {
    const len = Math.hypot(dx, dy);
    dx /= len;
    dy /= len;
    const nx = tank.x + dx * tank.speed * dt;
    const ny = tank.y + dy * tank.speed * dt;
    if (canMoveTo(tank, nx, tank.y)) tank.x = nx;
    if (canMoveTo(tank, tank.x, ny)) tank.y = ny;
  }

  tank.angle = Math.atan2(inp.aimY - tank.y, inp.aimX - tank.x);
  tank.fireCd = Math.max(0, tank.fireCd - dt);

  if (inp.shoot && tank.fireCd <= 0) {
    tank.fireCd = 0.45;
    state.bullets.push({
      x: tank.x + Math.cos(tank.angle) * 24,
      y: tank.y + Math.sin(tank.angle) * 24,
      vx: Math.cos(tank.angle) * 380,
      vy: Math.sin(tank.angle) * 380,
      r: 4,
      owner: id
    });
  }

  inputs[id].shoot = false;
}

function endMatch(winnerId) {
  broadcast({ type: "end", winnerId });
  // Stop auto-rematch: finish the current match and require explicit rejoin.
  const closingSockets = [clients.player0, clients.player1].filter(Boolean);
  for (const ws of closingSockets) ws._closingForMatchEnd = true;
  setTimeout(() => {
    for (const ws of closingSockets) {
      if (ws.readyState === 1) ws.close(1000, "match-ended");
    }
    resetMatch();
  }, 120);
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
          endMatch(winnerId);
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

const wss = new WebSocketServer({ server: httpServer });

wss.on("connection", (ws) => {
  let myId = null;

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (msg.type === "join" && !myId) {
      if (!clients.player0) myId = "player0";
      else if (!clients.player1) myId = "player1";
      else {
        ws.close();
        return;
      }

      clients[myId] = ws;
      if (typeof msg.nickname === "string" && msg.nickname.trim()) {
        nicknames[myId] = msg.nickname.trim().slice(0, 12);
      }

      send(ws, { type: "welcome", playerId: myId });

      if (bothConnected()) startIfReady();
      else queueNotice();
      return;
    }

    if (msg.type === "input" && myId) {
      inputs[myId] = {
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
    if (!myId) return;
    clients[myId] = null;
    if (myId === "player0") nicknames.player0 = "P1";
    if (myId === "player1") nicknames.player1 = "P2";
    inputs[myId] = { up: false, down: false, left: false, right: false, aimX: 480, aimY: 270, shoot: false };
    if (!ws._closingForMatchEnd) queueNotice();
  });
});

resetMatch();
setInterval(() => {
  if (!bothConnected()) return;
  updateTank("player0", TICK_MS / 1000);
  updateTank("player1", TICK_MS / 1000);
  updateBullets(TICK_MS / 1000);
  broadcast({ type: "state", state: { ...state, nicknames: [nicknames.player0, nicknames.player1] } });
}, TICK_MS);

httpServer.listen(PORT, () => {
  console.log(`Tank server listening on port ${PORT}`);
});
