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

    socket.join(roomId);
    socket.roomId = roomId;
    socket.region = region;

    players[socket.id] = {
      x: 400,
      y: 300,
      username: data.username || "Stranger",
      region,
      roomId
    };

    rooms[region][roomId].players.push(socket.id);

    const roomPlayers = {};
    for (let id of rooms[region][roomId].players) {
      if (id !== socket.id && players[id]) {
        roomPlayers[id] = players[id];
      }
    }

    socket.emit("currentPlayers", roomPlayers);
    socket.emit("existingNotes", notes.filter(n => n.roomId === roomId));

    socket.to(roomId).emit("newPlayer", {
      id: socket.id,
      ...players[socket.id]
    });

    console.log(`${data.username} joined ${roomId}`);
  });

  // 🔁 CHANGE ROOM (FIXED)
  socket.on("changeRoom", (data) => {
    const player = players[socket.id];
    if (!player) return;

    const oldRoom = player.roomId;
    const newRoom = data.roomId;

    // Leave old room
    socket.leave(oldRoom);

    // Remove from old room
    if (rooms[player.region]?.[oldRoom]) {
      rooms[player.region][oldRoom].players =
        rooms[player.region][oldRoom].players.filter(id => id !== socket.id);

      if (rooms[player.region][oldRoom].players.length === 0) {
        delete rooms[player.region][oldRoom];
      }
    }

    // Create new room if needed
    if (!rooms[player.region][newRoom]) {
      rooms[player.region][newRoom] = { players: [] };
    }

    // Join new room
    socket.join(newRoom);
    rooms[player.region][newRoom].players.push(socket.id);

    // Update player
    player.roomId = newRoom;
    socket.roomId = newRoom;

    // Notify old room
    socket.to(oldRoom).emit("playerDisconnected", socket.id);

    // Send new room state
    const roomPlayers = {};
    for (let id of rooms[player.region][newRoom].players) {
      if (id !== socket.id && players[id]) {
        roomPlayers[id] = players[id];
      }
    }

    socket.emit("currentPlayers", roomPlayers);
    socket.emit("existingNotes", notes.filter(n => n.roomId === newRoom));

    // Notify new room
    socket.to(newRoom).emit("newPlayer", {
      id: socket.id,
      ...player
    });
  });

  // 🏃 MOVE
  socket.on("move", (data) => {
    if (!players[socket.id]) return;

    players[socket.id].x = data.x;
    players[socket.id].y = data.y;

    socket.to(socket.roomId).emit("playerMoved", {
      id: socket.id,
      x: data.x,
      y: data.y,
      anim: data.anim
    });
  });

  // 💬 CHAT
  socket.on("chat", (msg) => {
    if (!players[socket.id]) return;

    io.to(socket.roomId).emit("chat", {
      id: socket.id,
      username: players[socket.id].username,
      msg
    });
  });
  // ✍️ ADD THIS RIGHT HERE
socket.on("typing", (isTyping) => {
  if (!players[socket.id]) return;

  socket.to(socket.roomId).emit("typing", players[socket.id].username);
});

  // 📝 NOTES
  socket.on("placeNote", (data) => {
    if (!players[socket.id]) return;

    const note = {
      x: data.x,
      y: data.y,
      text: data.text,
      author: players[socket.id].username,
      roomId: socket.roomId
    };

    notes.push(note);
    io.to(socket.roomId).emit("newNote", note);
  });

  // ❌ DISCONNECT (FIXED)
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

    socket.to(socket.roomId).emit("playerDisconnected", socket.id);
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
  