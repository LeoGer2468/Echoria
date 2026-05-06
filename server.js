require("dotenv").config();

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const mongoose = require("mongoose");
const path = require("path");

const authRoutes = require("./SERVER/routes/auth");
const authMiddleware = require("./SERVER/middleware/auth");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "CLIENT")));

// 🌐 Routes
app.use("/api/auth", authRoutes);

// 🔒 Protected test route
app.get("/api/me", authMiddleware, (req, res) => {
  res.json({ user: req.user });
});

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

// 🗺️ Room manager
const rooms = {};
const MAX_PLAYERS = 30;

function findOrCreateRoom(region) {
  if (!rooms[region]) rooms[region] = {};

  for (let roomId in rooms[region]) {
    if (rooms[region][roomId].players.length < MAX_PLAYERS) {
      return roomId;
    }
  }

  const roomId = `${region}-${Date.now()}`;
  rooms[region][roomId] = { players: [] };
  return roomId;
}

let notes = [];
let players = {};

io.on("connection", (socket) => {
  console.log("Socket connected:", socket.id);

  // 🟢 JOIN
  socket.on("join", (data) => {
    const region = data.region || "AS";
    const roomId = findOrCreateRoom(region);
    const gameArea = data.room || "lobby";
    const subRoom = `${roomId}:${gameArea}`;

    socket.join(roomId);    // main room for capacity management
    socket.join(subRoom);   // sub-room for game area scoped events
    socket.roomId = roomId;
    socket.subRoom = subRoom;
    socket.region = region;

    players[socket.id] = {
      x: 400,
      y: 300,
      username: data.username || "Stranger",
      region,
      roomId,
      gameArea
    };

    rooms[region][roomId].players.push(socket.id);

    // Only send players in the same game area
    const areaPlayers = {};
    for (let id of rooms[region][roomId].players) {
      if (id !== socket.id && players[id] && players[id].gameArea === gameArea) {
        areaPlayers[id] = players[id];
      }
    }

    socket.emit("currentPlayers", areaPlayers);
    socket.emit("existingNotes", notes.filter(n => n.gameArea === gameArea));

    socket.to(subRoom).emit("newPlayer", {
      id: socket.id,
      ...players[socket.id]
    });

    console.log(`${data.username} joined ${roomId} (${gameArea})`);
  });

  // 🔁 CHANGE GAME AREA
  socket.on("changeRoom", (data) => {
    const player = players[socket.id];
    if (!player) return;

    const oldSubRoom = socket.subRoom;
    const newArea = data.gameArea;
    const newSubRoom = `${player.roomId}:${newArea}`;

    // Leave old sub-room, join new one (stay in main room for capacity)
    socket.leave(oldSubRoom);
    socket.join(newSubRoom);
    socket.subRoom = newSubRoom;
    player.gameArea = newArea;

    // Notify old sub-room that this player left
    socket.to(oldSubRoom).emit("playerDisconnected", socket.id);

    // Get players already in the new area
    const areaPlayers = {};
    if (rooms[player.region]?.[player.roomId]) {
      for (let id of rooms[player.region][player.roomId].players) {
        if (id !== socket.id && players[id] && players[id].gameArea === newArea) {
          areaPlayers[id] = players[id];
        }
      }
    }

    socket.emit("currentPlayers", areaPlayers);
    socket.emit("existingNotes", notes.filter(n => n.gameArea === newArea));

    // Notify new sub-room
    socket.to(newSubRoom).emit("newPlayer", {
      id: socket.id,
      ...player
    });
  });

  // 🏃 MOVE
  socket.on("move", (data) => {
    if (!players[socket.id]) return;

    players[socket.id].x = data.x;
    players[socket.id].y = data.y;

    socket.to(socket.subRoom).emit("playerMoved", {
      id: socket.id,
      x: data.x,
      y: data.y,
      anim: data.anim
    });
  });

  // 💬 CHAT
  socket.on("chat", (msg) => {
    if (!players[socket.id]) return;

    io.to(socket.subRoom).emit("chat", {
      id: socket.id,
      username: players[socket.id].username,
      msg
    });
  });

  // ✍️ TYPING
  socket.on("typing", (isTyping) => {
    if (!players[socket.id]) return;
    socket.to(socket.subRoom).emit("typing", players[socket.id].username);
  });

  // 📝 NOTES
  socket.on("placeNote", (data) => {
    if (!players[socket.id]) return;

    const note = {
      x: data.x,
      y: data.y,
      text: data.text,
      author: players[socket.id].username,
      gameArea: players[socket.id].gameArea
    };

    notes.push(note);
    io.to(socket.subRoom).emit("newNote", note);
  });

  // ❌ DISCONNECT
  socket.on("disconnect", () => {
    const p = players[socket.id];

    if (p && rooms[p.region]?.[p.roomId]) {
      rooms[p.region][p.roomId].players =
        rooms[p.region][p.roomId].players.filter(id => id !== socket.id);

      if (rooms[p.region][p.roomId].players.length === 0) {
        delete rooms[p.region][p.roomId];
      }
    }

    delete players[socket.id];

    if (socket.subRoom) {
      socket.to(socket.subRoom).emit("playerDisconnected", socket.id);
    }
    console.log("Disconnected:", socket.id);
  });
});

// 🍃 MongoDB + start
mongoose.connect(process.env.MONGO_URI)
  .then(() => {
    console.log("✅ Connected to MongoDB");
    server.listen(process.env.PORT || 3000, () => {
      console.log(`✅ Echoria running on http://localhost:${process.env.PORT || 3000}`);
    });
  })
  .catch((err) => {
    console.error("❌ MongoDB connection failed:", err.message);
  });
  