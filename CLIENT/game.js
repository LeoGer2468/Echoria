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
  scene: { preload, create, update }
};

const game = new Phaser.Game(config);
const socket = io("https://echoria.onrender.com");

let player;
let scene; // ← store scene reference here, fixes checkDoorCollision `this` bug
let cursors;
let otherPlayers = {};
let playerLabel;
let playerUsername = "";
let lastX = null, lastY = null, lastAnim = null;
let lastEmit = 0;
let currentRoom = "lobby";
let doors = [];
let doorLabels = [];
let lastRoomSwitch = 0;

let seated = false;
let cafeUpdateListeners = [];
let cafeEKey = null;
let localChatBubble = null;
let localChatTracker = null;

const INTERACT_DIST = 80;

const ROOMS = {
  lobby:  { label: "🌿 Town Square" },
  cafe:   { label: "☕ Echoria Cafe" },
  arcade: { label: "🕹️ Arcade" },
  park:   { label: "🌸 The Park" }
};

// Per-room spawn points — player appears near the entrance door
const SPAWN_POINTS = {
  lobby:  { x: W / 2,       y: H / 2 },
  cafe:   { x: W / 2,       y: H - 80 },
  arcade: { x: W / 2,       y: H - 80 },
  park:   { x: W / 2,       y: H - 80 }
};

// ─── PRELOAD ─────────────────────────────────────────────────────────
function preload() {
  this.load.spritesheet("player",
    "https://labs.phaser.io/assets/sprites/dude.png",
    { frameWidth: 32, frameHeight: 48 }
  );
  this.load.image("grass",    "assets/grass.png");
  this.load.image("path",     "assets/sand.png");
  this.load.image("tree",     "assets/tree.png");
  this.load.image("cafe",     "assets/cafe.png");
  this.load.image("cafetile", "assets/cafetile.png");
  this.load.image("arcade",   "assets/arcade.png");
  this.load.image("park",     "assets/park.png");
}

// ─── CREATE ──────────────────────────────────────────────────────────
function create() {
  scene = this; // ← fix: store for use in update() and checkDoorCollision()

  scene.anims.create({ key: "left",  frames: scene.anims.generateFrameNumbers("player", { start: 0, end: 3 }), frameRate: 10, repeat: -1 });
  scene.anims.create({ key: "turn",  frames: [{ key: "player", frame: 4 }] });
  scene.anims.create({ key: "right", frames: scene.anims.generateFrameNumbers("player", { start: 5, end: 8 }), frameRate: 10, repeat: -1 });

  player = scene.physics.add.sprite(W / 2, H / 2, "player");
  player.setCollideWorldBounds(true);
  player.setDepth(5);

  scene.physics.world.setBounds(0, 0, W, H);
  scene.cameras.main.setBounds(0, 0, W, H);
  scene.cameras.main.startFollow(player);
  scene.cameras.main.setLerp(0.08, 0.08);
  scene.cameras.main.setZoom(1.5);

  cursors = scene.input.keyboard.createCursorKeys();

  playerUsername = window._username || "You";
  playerLabel = scene.add.text(0, 0, playerUsername, {
    fontSize: "12px", fill: "#ffffff",
    stroke: "#000000", strokeThickness: 3
  }).setDepth(6);

  scene.fadeRect = scene.add.rectangle(0, 0, W, H, 0x000000)
    .setOrigin(0).setDepth(1000).setAlpha(0);

  buildRoom(scene, "lobby");

  // Chat
  const chatInput = document.getElementById("chatInput");
  const chatHint  = document.getElementById("chatHint");

  chatInput.addEventListener("focus", () => {
    scene.input.keyboard.enabled = false;
    chatHint.style.opacity = "0";
  });
  chatInput.addEventListener("blur", () => {
    scene.input.keyboard.enabled = true;
    chatHint.style.opacity = "1";
  });

  let justSent = false;
  chatInput.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") {
      e.preventDefault();
      const msg = chatInput.value.trim();
      if (!msg) return;
      socket.emit("chat", msg);
      chatInput.value = "";
      justSent = true;
      chatInput.blur();
      setTimeout(() => { justSent = false; }, 200);
    }
    if (e.key === "Escape") chatInput.blur();
  });
  document.addEventListener("keydown", (e) => {
    if (justSent || document.activeElement === chatInput) return;
    if (e.key === "Enter") { e.preventDefault(); chatInput.focus(); }
  });

  socket.emit("join", { username: playerUsername, room: "lobby" });

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
    other.sprite.setDepth(data.y); // ← fix: depth-sort other players too
    other.label.setPosition(data.x - 20, data.y - 44);
    other.label.setDepth(data.y + 1);
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

  socket.on("chat", (data) => {
    if (data.id === socket.id) {
      showChatBubble(scene, null, data.msg, player, playerLabel);
      return;
    }
    const other = otherPlayers[data.id];
    if (other) showChatBubble(scene, data.id, data.msg, other.sprite, other.label);
  });
  socket.on("existingNotes", (noteList) => {
    noteList
      .filter(n => !n.gameArea || n.gameArea === currentRoom)
      .forEach(n => spawnNote(scene, n));
  });
  socket.on("newNote", (data) => {
    if (!data.gameArea || data.gameArea === currentRoom) spawnNote(scene, data);
  });
}

// ─── OTHER PLAYERS ───────────────────────────────────────────────────
function addOtherPlayer(scene, data) {
  const sprite = scene.physics.add.sprite(data.x || W/2, data.y || H/2, "player");
  sprite.setTint(0x00ffcc).setDepth(data.y || H/2);

  // ← polish: pop-in spawn animation
  sprite.setScale(0);
  scene.tweens.add({
    targets: sprite, scaleX: 1, scaleY: 1,
    duration: 200, ease: "Back.easeOut"
  });

  const label = scene.add.text(sprite.x - 20, sprite.y - 44, data.username || "Player", {
    fontSize: "12px", fill: "#ffffff", stroke: "#000000", strokeThickness: 3
  }).setDepth((data.y || H/2) + 1);

  otherPlayers[data.id] = { sprite, label, chatBubble: null };
}

// ─── BUILD ROOM ──────────────────────────────────────────────────────
function buildRoom(scene, roomName) {
  cleanupCafe(scene);

  scene.children.list
    .filter(c => c.getData && c.getData("mapObject"))
    .forEach(c => c.destroy());

  doors = [];
  doorLabels = [];
  currentRoom = roomName;

  if (roomName === "lobby")       buildLobby(scene);
  else if (roomName === "cafe")   buildCafe(scene);
  else if (roomName === "arcade") buildArcade(scene);
  else if (roomName === "park")   buildPark(scene);
}

function tag(obj) {
  obj.setData("mapObject", true);
  return obj;
}

// ─── CAFE CLEANUP ────────────────────────────────────────────────────
function cleanupCafe(scene) {
  cafeUpdateListeners.forEach(fn => scene.events.off("update", fn));
  cafeUpdateListeners = [];
  if (cafeEKey) {
    scene.input.keyboard.removeKey(Phaser.Input.Keyboard.KeyCodes.E);
    cafeEKey = null;
  }
  seated = false;
  if (player) player.body.enable = true;
}

// ─── LOBBY ───────────────────────────────────────────────────────────
function buildLobby(scene) {
  scene.cameras.main.setZoom(1.5);
  // ← fix: single TileSprite instead of thousands of image objects
  tag(scene.add.tileSprite(0, 0, W, H, "grass").setOrigin(0).setDepth(0));

  // Paths
  tag(scene.add.tileSprite(0, H/2 - 16, W, 32, "path").setOrigin(0).setDepth(1));
  tag(scene.add.tileSprite(W/2 - 16, 0, 32, H, "path").setOrigin(0).setDepth(1));

  [[80,80],[W-80,80],[80,H-80],[W-80,H-80],
   [W/4,80],[W*3/4,80],[W/4,H-80],[W*3/4,H-80],
   [80,H/4],[80,H*3/4],[W-80,H/4],[W-80,H*3/4]]
    .forEach(([x,y]) => tag(scene.add.image(x, y, "tree").setDepth(2)));

  tag(scene.add.text(W/2, 40, "🌿 Echoria Town Square", {
    fontSize: "20px", fill: "#ffffff",
    stroke: "#000000", strokeThickness: 4,
    backgroundColor: "#00000066", padding: { x: 12, y: 6 }
  }).setOrigin(0.5, 0).setDepth(10));

  addBuilding(scene, W/2 - 300, 160, 160, 120, "cafe",   "Cafe",   "cafe");
  addBuilding(scene, W/2 + 140, 160, 160, 120, "arcade", "Arcade", "arcade");
  addBuilding(scene, W/2 - 80,  H - 160, 160, 100, "park", "Park", "park");
}

// ─── CAFE ────────────────────────────────────────────────────────────
function buildCafe(scene) {
  const cafeBg = scene.add.image(W / 2, H / 2, "cafetile")
  .setDepth(0)
  .setScale(1);

 tag(cafeBg);

  cafeEKey = scene.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.E);

  function solidBox(cx, cy, w, h) {
    const r = scene.add.rectangle(cx, cy, w, h, 0x000000, 0);
    scene.physics.add.existing(r, true);
    scene.physics.add.collider(player, r);
    tag(r);
  }

  solidBox(215, 212, 430, 110);
  solidBox(519, 176, 122, 177);
  solidBox(614, 320,  92, 124);
  solidBox(517, 348, 145,  80);
  solidBox(127, 432, 110,  88);
  solidBox(340, 532, 110,  88);
  solidBox(520, 522, 120, 100);
  solidBox(127, 595, 215, 125);
  solidBox(613, 610,  93, 104);

  const zones = [
    {
      cx: 165, cy: 278, w: 170, h: 45,
      label: "[E] Order Coffee",
      onInteract: () => showDialogue(scene, "Barista", [
        "Welcome to Echoria Cafe!",
        "What can I get you today?",
        "[ Order menu coming soon ]"
      ])
    },
    {
      cx: 480, cy: 173, w: 80, h: 50,
      label: "[E] Read Menu",
      onInteract: () => showDialogue(scene, "Menu", [
        "── ECHORIA CAFE ──",
        "Espresso   · 2g",
        "Latte      · 3g",
        "Croissant  · 2g",
        "Cake Slice · 4g",
      ])
    },
    { cx: 127, cy: 475, w: 110, h: 38, label: "[E] Sit Down", onInteract: () => sitPlayer(scene, 127, 460) },
    { cx: 517, cy: 404, w: 145, h: 38, label: "[E] Sit Down", onInteract: () => sitPlayer(scene, 500, 400) },
    { cx: 340, cy: 584, w: 110, h: 38, label: "[E] Sit Down", onInteract: () => sitPlayer(scene, 340, 570) },
    { cx: 520, cy: 587, w: 120, h: 38, label: "[E] Sit Down", onInteract: () => sitPlayer(scene, 520, 572) },
  ];

  setupInteractables(scene, zones);
  setupCafeAtmosphere(scene);

  tag(scene.add.text(W/2, 30, "☕ Echoria Cafe", {
    fontSize: "20px", fill: "#ffddaa",
    stroke: "#000000", strokeThickness: 4,
    backgroundColor: "#00000066", padding: { x: 12, y: 6 }
  }).setOrigin(0.5, 0).setDepth(100));

  addDoor(scene, W/2, H - 30, "🚪 Exit", "lobby");
}

// ─── INTERACTABLES ───────────────────────────────────────────────────
function setupInteractables(scene, zones) {
  const promptLabel = scene.add.text(0, 0, "", {
    fontSize: "13px", fill: "#fff",
    backgroundColor: "#00000099",
    padding: { x: 8, y: 4 },
    stroke: "#000", strokeThickness: 2
  }).setDepth(200).setVisible(false);
  tag(promptLabel);

  let activeZone = null;

  const listener = () => {
    if (seated) { promptLabel.setVisible(false); return; }

    activeZone = null;
    for (const z of zones) {
      if (Math.abs(player.x - z.cx) < z.w / 2 + INTERACT_DIST &&
          Math.abs(player.y - z.cy) < z.h / 2 + INTERACT_DIST) {
        activeZone = z;
        break;
      }
    }

    if (activeZone) {
      promptLabel
        .setPosition(player.x - promptLabel.width / 2, player.y - 48)
        .setText(activeZone.label)
        .setVisible(true);
    } else {
      promptLabel.setVisible(false);
    }

    if (cafeEKey && Phaser.Input.Keyboard.JustDown(cafeEKey) && activeZone) {
      activeZone.onInteract();
    }
  };

  scene.events.on("update", listener);
  cafeUpdateListeners.push(listener);
}

// ─── DIALOGUE ────────────────────────────────────────────────────────
function showDialogue(scene, speaker, lines) {
  seated = true;
  player.body.enable = false;

  // Use scroll-factor 0 so dialogue stays on screen regardless of camera position
  const z = scene.cameras.main.zoom;
  const vw = W / z;
  const vh = H / z;

  const box      = scene.add.rectangle(vw/2, vh - 60, vw - 40, 90, 0x1a0d00, 0.92)
    .setDepth(300).setScrollFactor(0);
  const nameTag  = scene.add.text(40, vh - 100, speaker, {
    fontSize: "13px", fill: "#ffddaa",
    backgroundColor: "#3d1f00cc", padding: { x: 8, y: 4 }
  }).setDepth(301).setScrollFactor(0);
  const bodyText = scene.add.text(40, vh - 85, lines[0], {
    fontSize: "14px", fill: "#fff", wordWrap: { width: vw - 80 }
  }).setDepth(301).setScrollFactor(0);
  const hint = scene.add.text(vw - 50, vh - 30, "[E] Next", {
    fontSize: "11px", fill: "#aaa"
  }).setDepth(301).setScrollFactor(0);

  [box, nameTag, bodyText, hint].forEach(tag);

  let idx = 0;

  const listener = () => {
    if (!cafeEKey || !Phaser.Input.Keyboard.JustDown(cafeEKey)) return;
    idx++;
    if (idx >= lines.length) {
      [box, nameTag, bodyText, hint].forEach(o => o.destroy());
      scene.events.off("update", listener);
      cafeUpdateListeners = cafeUpdateListeners.filter(l => l !== listener);
      scene.time.delayedCall(150, () => {
        seated = false;
        player.body.enable = true;
      });
    } else {
      bodyText.setText(lines[idx]);
      if (idx === lines.length - 1) hint.setText("[E] Close");
    }
  };

  scene.events.on("update", listener);
  cafeUpdateListeners.push(listener);
}

// ─── SIT ─────────────────────────────────────────────────────────────
function sitPlayer(scene, tx, ty) {
  seated = true;
  player.body.enable = false;
  player.setPosition(tx, ty);

  const hint = scene.add.text(tx, ty - 40, "[E] Stand up", {
    fontSize: "12px", fill: "#fff",
    backgroundColor: "#00000099", padding: { x: 6, y: 3 },
    stroke: "#000", strokeThickness: 2
  }).setOrigin(0.5, 1).setDepth(200);
  tag(hint);

  const listener = () => {
    if (!Phaser.Input.Keyboard.JustDown(cafeEKey)) return;
    seated = false;
    player.body.enable = true;
    hint.destroy();
    scene.events.off("update", listener);
    cafeUpdateListeners = cafeUpdateListeners.filter(l => l !== listener);
  };

  scene.events.on("update", listener);
  cafeUpdateListeners.push(listener);
}

// ─── ATMOSPHERE ──────────────────────────────────────────────────────
function setupCafeAtmosphere(scene) {
  if (!scene.textures.exists("pixel")) {
    const g = scene.make.graphics({ x: 0, y: 0, add: false });
    g.fillStyle(0xffffff);
    g.fillRect(0, 0, 2, 2);
    g.generateTexture("pixel", 2, 2);
    g.destroy();
  }

  const lampGlow = scene.add.circle(110, 190, 90, 0xffcc66, 0.10).setDepth(1);
  tag(lampGlow);
  scene.tweens.add({ targets: lampGlow, alpha: 0.16, duration: 2200, ease: "Sine.easeInOut", yoyo: true, repeat: -1 });

  const hangGlow = scene.add.circle(310, 220, 60, 0xffeeaa, 0.08).setDepth(1);
  tag(hangGlow);
  scene.tweens.add({ targets: hangGlow, alpha: 0.14, duration: 1800, ease: "Sine.easeInOut", yoyo: true, repeat: -1, delay: 400 });

  const shaft = scene.add.rectangle(600, 260, 90, 180, 0xd4f0ff, 0.07).setDepth(1);
  tag(shaft);
  scene.tweens.add({ targets: shaft, alpha: 0.12, duration: 4000, ease: "Sine.easeInOut", yoyo: true, repeat: -1 });

  tag(scene.add.particles(0, 0, "pixel", {
    x: { min: 565, max: 645 }, y: { min: 100, max: 240 },
    speedX: { min: -4, max: 4 }, speedY: { min: 6, max: 14 },
    alpha: { start: 0.5, end: 0 }, scale: { min: 0.4, max: 1.0 },
    lifespan: { min: 3000, max: 6000 }, frequency: 300,
    tint: 0xffffee, depth: 2
  }));

  tag(scene.add.particles(0, 0, "pixel", {
    x: { min: 535, max: 560 }, y: 330,
    speedX: { min: -3, max: 3 }, speedY: { min: -18, max: -8 },
    alpha: { start: 0.35, end: 0 }, scale: { min: 0.5, max: 1.2 },
    lifespan: { min: 800, max: 1400 }, frequency: 180,
    tint: 0xccddff, depth: 2
  }));
}

// ─── ARCADE ──────────────────────────────────────────────────────────
function buildArcade(scene) {
  scene.cameras.main.setZoom(1.5);
  tag(scene.add.rectangle(0, 0, W, H, 0x05051a).setOrigin(0).setDepth(0));
  for (let x = 0; x < W; x += 64) tag(scene.add.rectangle(x, H/2, 1, H, 0x220044).setDepth(1));
  for (let y = 0; y < H; y += 64) tag(scene.add.rectangle(W/2, y, W, 1, 0x220044).setDepth(1));

  [[W/5,H/3,"🎮"],[W*2/5,H/3,"👾"],[W*3/5,H/3,"🕹️"],[W*4/5,H/3,"🎯"],
   [W/5,H*2/3,"🏆"],[W*2/5,H*2/3,"⭐"],[W*3/5,H*2/3,"🎪"],[W*4/5,H*2/3,"🎲"]]
    .forEach(([x, y, e]) => {
      tag(scene.add.rectangle(x, y, 50, 70, 0x2a0a4a).setDepth(2));
      tag(scene.add.text(x, y, e, { fontSize: "24px" }).setOrigin(0.5).setDepth(3));
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
  scene.cameras.main.setZoom(1.5);
  // ← fix: TileSprite for park grass too
  tag(scene.add.tileSprite(0, 0, W, H, "grass").setOrigin(0).setDepth(0));

  tag(scene.add.ellipse(W/2, H/2, 200, 120, 0x1a6aaa).setDepth(1));
  tag(scene.add.text(W/2, H/2, "🦆", { fontSize: "28px" }).setOrigin(0.5).setDepth(2));

  const flowers = ["🌸","🌼","🌺","🌻","🌹"];
  for (let i = 0; i < 20; i++) {
    tag(scene.add.text(
      Phaser.Math.Between(60, W-60),
      Phaser.Math.Between(60, H-60),
      flowers[Phaser.Math.Between(0, flowers.length-1)],
      { fontSize: "18px" }
    ).setDepth(2));
  }

  [[100,100],[W-100,100],[100,H-100],[W-100,H-100],[W/4,H/4],[W*3/4,H/4]]
    .forEach(([x,y]) => tag(scene.add.image(x, y, "tree").setDepth(2)));

  tag(scene.add.rectangle(W/2-150, H/2+100, 80, 20, 0x5c3317).setDepth(2));
  tag(scene.add.rectangle(W/2+150, H/2+100, 80, 20, 0x5c3317).setDepth(2));

  tag(scene.add.text(W/2, 30, "🌸 The Park", {
    fontSize: "20px", fill: "#aaffaa",
    stroke: "#000000", strokeThickness: 4,
    backgroundColor: "#00000066", padding: { x: 12, y: 6 }
  }).setOrigin(0.5, 0).setDepth(10));

  addDoor(scene, W/2, H - 60, "🚪 Exit", "lobby");
}

// ─── BUILDING ────────────────────────────────────────────────────────
function addBuilding(scene, x, y, w, h, texture, label, targetRoom) {
  tag(scene.add.image(x + w/2, y + h, texture)
    .setOrigin(0.5, 1).setDepth(2).setScale(1.3));

  const collider = scene.add.rectangle(x + w/2, y + h - 180, w - 40, 40, 0x000000, 0);
  scene.physics.add.existing(collider, true);
  scene.physics.add.collider(player, collider);
  tag(collider);

  tag(scene.add.text(x + w/2, y + h - 140, label, {
    fontSize: "14px", fill: "#ffffff",
    stroke: "#000000", strokeThickness: 3
  }).setOrigin(0.5).setDepth(3));

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
function checkDoorCollision() {
  const now = Date.now();
  for (const door of doors) {
    if (
      Phaser.Geom.Intersects.RectangleToRectangle(player.getBounds(), door.getBounds()) &&
      now - lastRoomSwitch > 1000
    ) {
      lastRoomSwitch = now;
      enterRoom(door.getData("targetRoom"));
      return;
    }
  }
}

function enterRoom(roomName) {
  if (roomName === currentRoom) return;

  // Destroy local chat bubble before transition
  if (localChatBubble) {
    localChatBubble.destroy();
    localChatBubble = null;
  }
  if (localChatTracker) {
    localChatTracker.remove();
    localChatTracker = null;
  }

  scene.tweens.add({
    targets: scene.fadeRect, alpha: 1, duration: 300,
    onComplete: () => {
      for (let id in otherPlayers) {
        otherPlayers[id].sprite.destroy();
        otherPlayers[id].label.destroy();
        if (otherPlayers[id].chatBubble) otherPlayers[id].chatBubble.destroy();
      }
      otherPlayers = {};

      buildRoom(scene, roomName);

      const spawn = SPAWN_POINTS[roomName] || { x: W/2, y: H/2 };
      player.setPosition(spawn.x, spawn.y);
      player.setScale(1);

      socket.emit("changeRoom", { gameArea: roomName });

      scene.tweens.add({ targets: scene.fadeRect, alpha: 0, duration: 300 });
    }
  });
}

// ─── UPDATE ──────────────────────────────────────────────────────────
function update() {
  if (document.activeElement === document.getElementById("chatInput")) {
    player.setVelocity(0);
    player.anims.play("turn");
    return;
  }

  if (seated) {
    player.setVelocity(0);
    return;
  }

  const speed = 160;
  let currentAnim = "turn";
  player.setVelocity(0);

  if (cursors.left.isDown)       { player.setVelocityX(-speed); currentAnim = "left"; }
  else if (cursors.right.isDown) { player.setVelocityX(speed);  currentAnim = "right"; }
  if (cursors.up.isDown)         player.setVelocityY(-speed);
  else if (cursors.down.isDown)  player.setVelocityY(speed);

  player.anims.play(currentAnim, true);
  playerLabel.setPosition(player.x - 20, player.y - 44);
  player.setDepth(player.y);
  playerLabel.setDepth(player.y + 1);

  // ← fix: throttle socket emits to max 20/sec instead of 60/sec
  const now = Date.now();
  const moved = player.x !== lastX || player.y !== lastY || currentAnim !== lastAnim;
  if (moved && now - lastEmit > 50) {
    socket.emit("move", { x: player.x, y: player.y, anim: currentAnim });
    lastX = player.x; lastY = player.y; lastAnim = currentAnim;
    lastEmit = now;
  }

  checkDoorCollision(); // ← fix: no longer passes `this`
}

// ─── CHAT BUBBLE ─────────────────────────────────────────────────────
function showChatBubble(scene, id, msg, sprite, label) {
  const target = id ? otherPlayers[id] : null;
  if (target?.chatBubble) { target.chatBubble.destroy(); target.chatBubble = null; }

  // Destroy previous local bubble if this is the local player
  if (!id && localChatBubble) {
    localChatBubble.destroy();
    localChatBubble = null;
  }
  if (!id && localChatTracker) {
    localChatTracker.remove();
    localChatTracker = null;
  }

  const bubble = scene.add.text(sprite.x - 30, sprite.y - 64, msg, {
    fontSize: "13px", fill: "#ffffff",
    backgroundColor: "#222244", padding: { x: 6, y: 4 },
    stroke: "#000000", strokeThickness: 2, wordWrap: { width: 160 }
  }).setDepth(9999);

  if (target) target.chatBubble = bubble;
  if (!id) localChatBubble = bubble;

  const tracker = scene.time.addEvent({
    delay: 16,
    repeat: Math.floor(3000 / 16),
    callback: () => {
      if (!bubble.active) return;
      const sx = id ? sprite.x : player.x;
      const sy = id ? sprite.y : player.y;
      bubble.setPosition(sx - 30, sy - 64);
    }
  });

  if (!id) localChatTracker = tracker;

  scene.time.delayedCall(3000, () => {
    bubble.destroy();
    tracker.remove();
    if (target) target.chatBubble = null;
    if (!id) { localChatBubble = null; localChatTracker = null; }
  });
}

// ─── STICKY NOTES ────────────────────────────────────────────────────
function spawnNote(scene, data) {
  // ← fix: tag() so notes are destroyed on room switch
  tag(scene.add.text(data.x, data.y, data.author ? `${data.text}\n— ${data.author}` : data.text, {
    fontSize: "13px", fill: "#ffff88",
    backgroundColor: "#111111", padding: { x: 5, y: 3 },
    stroke: "#000000", strokeThickness: 2
  }).setDepth(8));
}