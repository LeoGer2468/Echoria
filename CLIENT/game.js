const W = window.innerWidth;
const H = window.innerHeight;

const config = {
  type: Phaser.AUTO,
  width: W,
  height: H,
  physics: {
    default: "arcade",
    arcade: { debug: false }
  },
  scene: {
    preload,
    create,
    update
  }
};

const game = new Phaser.Game(config);

const socket = io("http://localhost:3000");

let player;
let cursors;
let otherPlayers = {};
let playerLabel;
let playerUsername = "";
let lastX = null;
let lastY = null;
let lastAnim = null;
let currentRoom = "lobby";
let doors = [];
let doorLabels = [];
let lastRoomSwitch = 0;
let buildingColliders = [];

// ─── ROOM DEFINITIONS ───────────────────────────────────────────────
const ROOMS = {
  lobby: {
    bgColor: 0x2d5a1b,
    label: "🌿 Town Square"
  },
  cafe: {
    bgColor: 0x3b1f0a,
    label: "☕ Echoria Cafe"
  },
  arcade: {
    bgColor: 0x0a0a2e,
    label: "🕹️ Arcade"
  },
  park: {
    bgColor: 0x1a3d0f,
    label: "🌸 The Park"
  }
};

function preload() {
  this.load.spritesheet("player",
    "https://labs.phaser.io/assets/sprites/dude.png",
    { frameWidth: 32, frameHeight: 48 }
  );
  this.load.image("grass", "assets/grass.png");
  this.load.image("path", "assets/sand.png");
  this.load.image("tree", "assets/tree.png");
  this.load.image("cafe", "assets/cafe.png");
this.load.image("arcade", "assets/arcade.png");
this.load.image("park", "assets/park.png");
}

function create() {
  const scene = this;
   

  // Animations
  scene.anims.create({
    key: "left",
    frames: scene.anims.generateFrameNumbers("player", { start: 0, end: 3 }),
    frameRate: 10, repeat: -1
  });
  scene.anims.create({
    key: "turn",
    frames: [{ key: "player", frame: 4 }]
  });
  scene.anims.create({
    key: "right",
    frames: scene.anims.generateFrameNumbers("player", { start: 5, end: 8 }),
    frameRate: 10, repeat: -1
  });

  buildRoom(scene, "lobby");

  // Player
  player = scene.physics.add.sprite(W / 2, H / 2, "player");
  scene.physics.world.setBounds(0, 0, W, H);
  scene.cameras.main.setBounds(0, 0, W, H);
  scene.cameras.main.startFollow(player);
  scene.cameras.main.setZoom(1.5);
  buildingColliders.forEach(collider => {
  scene.physics.add.collider(player, collider);
 });
  player.setCollideWorldBounds(true);
  player.setDepth(5);

  cursors = scene.input.keyboard.createCursorKeys();
  playerUsername = window._username || "You";

  playerLabel = scene.add.text(0, 0, playerUsername, {
    fontSize: "12px", fill: "#ffffff",
    stroke: "#000000", strokeThickness: 3
  }).setDepth(6);

  socket.emit("join", { username: playerUsername, room: "lobby" });

  // Socket events
  socket.on("currentPlayers", (players) => {
    for (let id in players) {
      if (id === socket.id) continue;
      if (!otherPlayers[id]) addOtherPlayer(scene, { id, ...players[id] });
    }
  });

  socket.on("newPlayer", (data) => {
    if (!otherPlayers[data.id]) addOtherPlayer(scene, data);
  });

  socket.on("playerMoved", (data) => {
    const other = otherPlayers[data.id];
    if (!other) return;
    other.sprite.setPosition(data.x, data.y);
    other.label.setPosition(data.x - 20, data.y - 44);
    if (data.anim) other.sprite.anims.play(data.anim, true);
  });

  socket.on("playerDisconnected", (id) => {
    if (otherPlayers[id]) {
      otherPlayers[id].sprite.destroy();
      otherPlayers[id].label.destroy();
      if (otherPlayers[id].chatBubble) otherPlayers[id].chatBubble.destroy();
      delete otherPlayers[id];
    }
  });

  socket.on("playerChangedRoom", (data) => {
    if (data.id === socket.id) return;
    if (data.room !== currentRoom) {
      // Remove player from view if they left this room
      if (otherPlayers[data.id]) {
        otherPlayers[data.id].sprite.destroy();
        otherPlayers[data.id].label.destroy();
        delete otherPlayers[data.id];
      }
    }
  });

  socket.on("chat", (data) => {
    if (data.id === socket.id) {
      showChatBubble(scene, null, data.msg, player, playerLabel);
      return;
    }
    const other = otherPlayers[data.id];
    if (!other) return;
    showChatBubble(scene, data.id, data.msg, other.sprite, other.label);
  });

  socket.on("existingNotes", (noteList) => {
    noteList.forEach(note => spawnNote(scene, note));
  });

  socket.on("newNote", (data) => {
    spawnNote(scene, data);
  });

  // Chat input
  const chatInput = document.getElementById("chatInput");
  chatInput.addEventListener("keydown", (e) => {
    if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.key)) {
      e.stopPropagation();
    }
    if (e.key === "Enter") {
      const msg = chatInput.value.trim();
      if (!msg) return;
      socket.emit("chat", msg);
      chatInput.value = "";
      chatInput.blur();
    }
    if (e.key === "Escape") chatInput.blur();
  });
  this.fadeRect = this.add.rectangle(0, 0, W, H, 0x000000)
  .setOrigin(0)
  .setDepth(100)
  .setAlpha(0);
}

// ─── BUILD ROOM ──────────────────────────────────────────────────────
function buildRoom(scene, roomName) {
  buildingColliders = [];
  // Clear existing map objects
  scene.children.list
    .filter(c => c.getData && c.getData("mapObject"))
    .forEach(c => c.destroy());

  doors = [];
  doorLabels = [];
  currentRoom = roomName;

  if (roomName === "lobby") buildLobby(scene);
  else if (roomName === "cafe") buildCafe(scene);
  else if (roomName === "arcade") buildArcade(scene);
  else if (roomName === "park") buildPark(scene);
}

function tag(obj) {
  obj.setData("mapObject", true);
  return obj;
}

// ─── LOBBY ───────────────────────────────────────────────────────────
function buildLobby(scene) {
  // Grass tiles
  for (let x = 0; x < W; x += 32)
    for (let y = 0; y < H; y += 32)
      tag(scene.add.image(x, y, "grass").setOrigin(0).setDepth(0));

  // Cross paths
  for (let x = 0; x < W; x += 32)
    tag(scene.add.image(x, H / 2 - 16, "path").setOrigin(0).setDepth(1));
  for (let y = 0; y < H; y += 32)
    tag(scene.add.image(W / 2 - 16, y, "path").setOrigin(0).setDepth(1));

  // Trees around the edges
  const treePositions = [
    [80, 80], [W-80, 80], [80, H-80], [W-80, H-80],
    [W/4, 80], [W*3/4, 80], [W/4, H-80], [W*3/4, H-80],
    [80, H/4], [80, H*3/4], [W-80, H/4], [W-80, H*3/4]
  ];
  treePositions.forEach(([x, y]) =>
    tag(scene.add.image(x, y, "tree").setDepth(2))
  );

  // Town sign
  tag(scene.add.text(W/2, 40, "🌿 Echoria Town Square", {
    fontSize: "20px", fill: "#ffffff",
    stroke: "#000000", strokeThickness: 4,
    backgroundColor: "#00000066", padding: { x: 12, y: 6 }
  }).setOrigin(0.5, 0).setDepth(10));

  // Buildings + doors
  addBuilding(scene, W/2 - 300, 160, 160, 120, "cafe", "Cafe", "cafe");
addBuilding(scene, W/2 + 140, 160, 160, 120, "arcade", "Arcade", "arcade");
addBuilding(scene, W/2 - 80, H - 160, 160, 100, "park", "Park", "park");
}

// ─── CAFE ────────────────────────────────────────────────────────────
function buildCafe(scene) {
  // Warm floor
  const floorColor = scene.add.rectangle(0, 0, W, H, 0x3b1f0a).setOrigin(0).setDepth(0);
  tag(floorColor);

  // Tables
  const tablePositions = [
    [W/4, H/3], [W/2, H/3], [W*3/4, H/3],
    [W/4, H*2/3], [W/2, H*2/3], [W*3/4, H*2/3]
  ];
  tablePositions.forEach(([x, y]) => {
    tag(scene.add.rectangle(x, y, 60, 40, 0x5c3317).setDepth(2));
    tag(scene.add.text(x, y, "🪑", { fontSize: "20px" }).setOrigin(0.5).setDepth(3));
  });

  // Counter
  tag(scene.add.rectangle(W/2, 80, 300, 40, 0x4a2508).setDepth(2));
  tag(scene.add.text(W/2, 80, "☕ ORDER HERE", {
    fontSize: "14px", fill: "#ffddaa", stroke: "#000", strokeThickness: 2
  }).setOrigin(0.5).setDepth(3));

  // Room label
  tag(scene.add.text(W/2, 30, "☕ Echoria Cafe", {
    fontSize: "20px", fill: "#ffddaa",
    stroke: "#000000", strokeThickness: 4,
    backgroundColor: "#00000066", padding: { x: 12, y: 6 }
  }).setOrigin(0.5, 0).setDepth(10));

  // Back door
  addDoor(scene, W/2, H - 60, "🚪 Exit", "lobby");
}

// ─── ARCADE ──────────────────────────────────────────────────────────
function buildArcade(scene) {
  const floor = scene.add.rectangle(0, 0, W, H, 0x05051a).setOrigin(0).setDepth(0);
  tag(floor);

  // Neon grid lines
  for (let x = 0; x < W; x += 64)
    tag(scene.add.rectangle(x, H/2, 1, H, 0x220044).setDepth(1));
  for (let y = 0; y < H; y += 64)
    tag(scene.add.rectangle(W/2, y, W, 1, 0x220044).setDepth(1));

  // Arcade machines
  const machines = [
    [W/5, H/3, "🎮"], [W*2/5, H/3, "👾"],
    [W*3/5, H/3, "🕹️"], [W*4/5, H/3, "🎯"],
    [W/5, H*2/3, "🏆"], [W*2/5, H*2/3, "⭐"],
    [W*3/5, H*2/3, "🎪"], [W*4/5, H*2/3, "🎲"]
  ];
  machines.forEach(([x, y, emoji]) => {
    tag(scene.add.rectangle(x, y, 50, 70, 0x2a0a4a).setDepth(2));
    tag(scene.add.text(x, y, emoji, { fontSize: "24px" }).setOrigin(0.5).setDepth(3));
  });

  tag(scene.add.text(W/2, 30, "🕹️ Arcade", {
    fontSize: "20px", fill: "#cc44ff",
    stroke: "#000000", strokeThickness: 4,
    backgroundColor: "#00000066", padding: { x: 12, y: 6 }
  }).setOrigin(0.5, 0).setDepth(10));

  addDoor(scene, W/2, H - 60, "🚪 Exit", "lobby");
}

// ─── PARK ────────────────────────────────────────────────────────────
function buildPark(scene) {
  for (let x = 0; x < W; x += 32)
    for (let y = 0; y < H; y += 32)
      tag(scene.add.image(x, y, "grass").setOrigin(0).setDepth(0));

  // Pond
  tag(scene.add.ellipse(W/2, H/2, 200, 120, 0x1a6aaa).setDepth(1));
  tag(scene.add.text(W/2, H/2, "🦆", { fontSize: "28px" }).setOrigin(0.5).setDepth(2));

  // Flowers
  const flowers = ["🌸","🌼","🌺","🌻","🌹"];
  for (let i = 0; i < 20; i++) {
    const fx = Phaser.Math.Between(60, W - 60);
    const fy = Phaser.Math.Between(60, H - 60);
    const f = flowers[Phaser.Math.Between(0, flowers.length - 1)];
    tag(scene.add.text(fx, fy, f, { fontSize: "18px" }).setDepth(2));
  }

  // Trees
  [[100, 100],[W-100,100],[100,H-100],[W-100,H-100],[W/4,H/4],[W*3/4,H/4]].forEach(([x,y]) =>
    tag(scene.add.image(x, y, "tree").setDepth(2))
  );

  // Bench
  tag(scene.add.rectangle(W/2 - 150, H/2 + 100, 80, 20, 0x5c3317).setDepth(2));
  tag(scene.add.rectangle(W/2 + 150, H/2 + 100, 80, 20, 0x5c3317).setDepth(2));

  tag(scene.add.text(W/2, 30, "🌸 The Park", {
    fontSize: "20px", fill: "#aaffaa",
    stroke: "#000000", strokeThickness: 4,
    backgroundColor: "#00000066", padding: { x: 12, y: 6 }
  }).setOrigin(0.5, 0).setDepth(10));

  addDoor(scene, W/2, H - 60, "🚪 Exit", "lobby");
}

// ─── BUILDING (lobby) ─────────────────────────────────────────────
function addBuilding(scene, x, y, w, h, texture, label, targetRoom) {
  // Building image
  tag(scene.add.image(x + w/2, y + h, texture)
    .setOrigin(0.5, 1)   // bottom aligned
    .setDepth(2)
    .setScale(1.3));     // adjust if needed 
    // Invisible collision box (block player)
   const collider = scene.add.rectangle(x + w/2, y + h - 180, w - 40, 40, 0x000000, 0);
   scene.physics.add.existing(collider, true);

   // store it for later
   buildingColliders.push(collider);

   
   

    

  // Label
  tag(scene.add.text(x + w/2, y + h - 140, label, {
    fontSize: "14px",
    fill: "#ffffff",
    stroke: "#000000",
    strokeThickness: 3
  }).setOrigin(0.5).setDepth(3));

  // Door (center bottom)
  addDoor(scene, x + w/2, y + h - 10, "🚪", targetRoom);
}

// ─── DOOR ────────────────────────────────────────────────────────────
function addDoor(scene, x, y, label, targetRoom) {
  const door = scene.add.rectangle(x, y, 36, 48, 0x000000, 0)
    .setDepth(4).setData("mapObject", true).setData("targetRoom", targetRoom);

  const doorLabel = scene.add.text(x, y - 30, label, {
    fontSize: "12px", fill: "#ffffff",
    stroke: "#000000", strokeThickness: 3,
    backgroundColor: "#00000088", padding: { x: 4, y: 2 }
  }).setOrigin(0.5).setDepth(4).setData("mapObject", true);

  doors.push(door);
  doorLabels.push(doorLabel);
}

// ─── ROOM TRANSITION ─────────────────────────────────────────────────
function checkDoorCollision(scene) {
  const now = Date.now();

  for (let door of doors) {
    const target = door.getData("targetRoom");
    const bounds = door.getBounds();
    const playerBounds = player.getBounds();

    if (
      Phaser.Geom.Intersects.RectangleToRectangle(playerBounds, bounds) &&
      now - lastRoomSwitch > 1000
    ) {
      lastRoomSwitch = now;
      enterRoom(scene, target);
      return;
    }
  }
}

function enterRoom(scene, roomName) {
  if (roomName === currentRoom) return;

  const fade = scene.fadeRect;

  // Fade OUT
  scene.tweens.add({
    targets: fade,
    alpha: 1,
    duration: 300,
    onComplete: () => {

      // Clear players
      for (let id in otherPlayers) {
        otherPlayers[id].sprite.destroy();
        otherPlayers[id].label.destroy();
        if (otherPlayers[id].chatBubble) otherPlayers[id].chatBubble.destroy();
      }
      otherPlayers = {};

      // Build new room
      buildRoom(scene, roomName);

      // Move player
      player.setPosition(W / 2, H / 2);
      player.setDepth(5);
      playerLabel.setDepth(6);

      socket.emit("changeRoom", { roomId: roomName });

      // Fade IN
      scene.tweens.add({
        targets: fade,
        alpha: 0,
        duration: 300
      });
    }
  });
}

function update() {
  const speed = 160;
  let currentAnim = "turn";

  player.setVelocity(0);

  if (cursors.left.isDown) { player.setVelocityX(-speed); currentAnim = "left"; }
  else if (cursors.right.isDown) { player.setVelocityX(speed); currentAnim = "right"; }
  if (cursors.up.isDown) player.setVelocityY(-speed);
  else if (cursors.down.isDown) player.setVelocityY(speed);

  player.anims.play(currentAnim, true);
  playerLabel.setPosition(player.x - 20, player.y - 44);

  const moved = player.x !== lastX || player.y !== lastY || currentAnim !== lastAnim;
  if (moved) {
    socket.emit("move", { x: player.x, y: player.y, anim: currentAnim });
    lastX = player.x; lastY = player.y; lastAnim = currentAnim;
  }

  checkDoorCollision(this);
}

function addOtherPlayer(scene, data) {
  const sprite = scene.add.sprite(data.x, data.y, "player").setDepth(5);
  const label = scene.add.text(data.x - 20, data.y - 44, data.username || "?", {
    fontSize: "12px", fill: "#aaffaa",
    stroke: "#000000", strokeThickness: 3
  }).setDepth(6);
  otherPlayers[data.id] = { sprite, label, chatBubble: null };
}

function showChatBubble(scene, id, msg, sprite, label) {
  let target = id ? otherPlayers[id] : null;
  if (target && target.chatBubble) { target.chatBubble.destroy(); target.chatBubble = null; }

  const bubble = scene.add.text(sprite.x - 30, sprite.y - 64, msg, {
    fontSize: "13px", fill: "#ffffff",
    backgroundColor: "#222244", padding: { x: 6, y: 4 },
    stroke: "#000000", strokeThickness: 2,
    wordWrap: { width: 160 }
  }).setDepth(10);

  if (target) target.chatBubble = bubble;

  const tracker = scene.time.addEvent({
    delay: 16, repeat: Math.floor(3000 / 16),
    callback: () => { if (bubble.active) bubble.setPosition(sprite.x - 30, sprite.y - 64); }
  });

  scene.time.delayedCall(3000, () => {
    bubble.destroy(); tracker.remove();
    if (target) target.chatBubble = null;
  });
}

function spawnNote(scene, data) {
  const label = data.author ? `${data.text}\n— ${data.author}` : data.text;
  scene.add.text(data.x, data.y, label, {
    fontSize: "13px", fill: "#ffff88",
    backgroundColor: "#111111", padding: { x: 5, y: 3 },
    stroke: "#000000", strokeThickness: 2
  }).setDepth(8);
}