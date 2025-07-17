class RoomManager {
  constructor() {
    this.rooms = new Map();
  }

  initRoom(roomId) {
    this.rooms.set(roomId, {
      clients: new Map(),
      listeningSource: { x: 0, y: 0 },
      intervalId: null,
      spatialEnabled: false,
      songEnabled: false,
      startTime: null,
      songDuration: 180000,
    });
  }

  createRoom() {
    let roomId;
    do {
      roomId = Math.floor(100000 + Math.random() * 900000).toString();
    } while (this.rooms.has(roomId));

    this.initRoom(roomId);
    return roomId;
  }

  addClient({ roomId, clientId, username, socket }) {
    if (!this.rooms.has(roomId)) {
      this.initRoom(roomId);
    }

    const room = this.rooms.get(roomId);
    if (!room) return;

    for (const [id, client] of room.clients.entries()) {
      if (client.username === username) {
        room.clients.delete(id);
      }
    }

    room.clients.set(clientId, {
      username,
      socket,
      position: { x: 0, y: 0 },
    });

    this.updateClientPositions(roomId);
    this.broadcastSpatialUpdate(roomId);
  }

  removeClient({ roomId, clientId }) {
    const room = this.rooms.get(roomId);
    if (!room) return;

    room.clients.delete(clientId);

    if (room.clients.size === 0) {
      clearInterval(room.intervalId);
      this.rooms.delete(roomId);
    } else {
      this.updateClientPositions(roomId);
      this.broadcastSpatialUpdate(roomId);
    }
  }

  getClients(roomId) {
    const room = this.rooms.get(roomId);
    if (!room) return [];

    return Array.from(room.clients.entries()).map(([clientId, client]) => ({
      clientId,
      username: client.username,
      position: client.position,
    }));
  }

  playAudio(roomId, enable) {
    const room = this.rooms.get(roomId);
    if (!room) return;
    room.songEnabled = enable;
    room.startTime = enable ? Date.now() : null;
    return enable;
  }

  pauseAudio(roomId, enable) {
    const room = this.rooms.get(roomId);
    if (!room) return;
    room.songEnabled = enable;
    room.startTime = enable ? Date.now() : null;
    return enable;
  }

  moveClient({ roomId, clientId, position }) {
    const room = this.rooms.get(roomId);
    if (!room) return;
    const client = room.clients.get(clientId);
    if (client) {
      client.position = position;
      this.broadcastSpatialUpdate(roomId);
    }
  }

  toggleSpatialAudio(roomId, enable) {
    const room = this.rooms.get(roomId);
    if (!room) return;
    room.spatialEnabled = enable;

    if (enable) {
      this.startSpatialAudioLoop(roomId);
    } else {
      this.stopSpatialAudioLoop(roomId);
    }

    for (const [, client] of room.clients.entries()) {
      client.socket.emit("spatial-toggle", { enabled: enable });
    }
  }

  startSpatialAudioLoop(roomId) {
    const room = this.rooms.get(roomId);
    if (!room) return;

    let step = 0;
    const radius = 50;
    const center = { x: 0, y: 0 };

    room.intervalId = setInterval(() => {
      const angle = (step * Math.PI) / 30;
      room.listeningSource = {
        x: center.x + Math.cos(angle) * radius,
        y: center.y + Math.sin(angle) * radius,
      };
      this.broadcastSpatialUpdate(roomId);
      step++;
    }, 100);
  }

  stopSpatialAudioLoop(roomId) {
    const room = this.rooms.get(roomId);
    if (!room) return;

    if (room.intervalId) {
      clearInterval(room.intervalId);
      room.intervalId = null;
    }

    room.listeningSource = { x: 0, y: 0 };

    const gains = {};
    for (const [clientId] of room.clients.entries()) {
      gains[clientId] = 1;
    }

    const payload = {
      source: room.listeningSource,
      gains,
      enabled: false,
      positions: Object.fromEntries(
        Array.from(room.clients.entries()).map(([id, client]) => [
          id,
          client.position,
        ])
      ),
    };

    for (const [, client] of room.clients.entries()) {
      client.socket.emit("spatial-update", payload);
    }
  }

  broadcastSpatialUpdate(roomId) {
    const room = this.rooms.get(roomId);
    if (!room) return;

    const source = room.listeningSource;
    const gains = {};

    for (const [clientId, client] of room.clients.entries()) {
      const dist = this._distance(client.position, source);
      const gain = this._calculateGain(dist);
      gains[clientId] = gain;
    }

    const payload = {
      source,
      gains,
      enabled: room.spatialEnabled,
      positions: Object.fromEntries(
        Array.from(room.clients.entries()).map(([id, client]) => [
          id,
          client.position,
        ])
      ),
    };

    for (const [, client] of room.clients.entries()) {
      client.socket.emit("spatial-update", payload);
    }
  }

  updateClientPositions(roomId) {
    const room = this.rooms.get(roomId);
    if (!room) return;

    const clients = Array.from(room.clients.entries());
    const radius = 50;

    clients.forEach(([clientId, client], index) => {
      const angle = (2 * Math.PI * index) / clients.length;
      client.position = {
        x: Math.cos(angle) * radius,
        y: Math.sin(angle) * radius,
      };
    });
  }

  _distance(p1, p2) {
    const dx = p1.x - p2.x;
    const dy = p1.y - p2.y;
    return Math.sqrt(dx * dx + dy * dy);
  }

  _calculateGain(distance) {
    const maxDistance = 100;
    const minGain = 0.05;
    const gain = 1 - Math.pow(distance / maxDistance, 2);
    return Math.max(minGain, gain);
  }

  _getElapsedTime(room) {
    if (!room || !room.songEnabled || !room.startTime) return 0;
    const elapsed = Date.now() - room.startTime;
    return Math.min(elapsed, room.songDuration);
  }
}

const roomManager = new RoomManager();
export default roomManager;
