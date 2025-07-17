import redis from "../config/redis.js";

const DEFAULT_SONG_DURATION = 180000; // 3 minutes

class RoomManager {
  constructor() {
    this.sockets = new Map(); // clientId -> socket
    this.intervals = new Map(); // roomId -> intervalId
  }

  async initRoom(roomId) {
    const room = {
      clients: {},
      spatialEnabled: false,
      songEnabled: false,
      listeningSource: { x: 0, y: 0 },
      startTime: null,
      songDuration: null,
    };
    await redis.set(`room:${roomId}`, JSON.stringify(room));
  }

  async createRoom() {
    let roomId;
    do {
      roomId = Math.floor(100000 + Math.random() * 900000).toString();
    } while (await redis.exists(`room:${roomId}`));
    await this.initRoom(roomId);
    return roomId;
  }

  async getRoom(roomId) {
    const data = await redis.get(`room:${roomId}`);
    return data ? JSON.parse(data) : null;
  }

  async saveRoom(roomId, room) {
    await redis.set(`room:${roomId}`, JSON.stringify(room));
  }

  async deleteRoom(roomId) {
    clearInterval(this.intervals.get(roomId));
    this.intervals.delete(roomId);
    await redis.del(`room:${roomId}`);
  }

  async addClient({ roomId, username, clientId, socket }) {
    let room = await this.getRoom(roomId);
    console.log(`Adding room ${clientId} to room ${roomId}`);
    if (!room) {
      await this.initRoom(roomId);
      room = await this.getRoom(roomId);
    }

    for (const [id, client] of Object.entries(room.clients)) {
      if (client.username === username) {
        delete room.clients[id];
      }
    }

    room.clients[clientId] = {
      position: { x: 0, y: 0 },
      username,
    };

    this.sockets.set(clientId, socket);
    await this.updateClientPositions(room);
    await this.saveRoom(roomId, room);
    await this.broadcastSpatialUpdate(room);

    socket.emit("spatial-toggle", { enabled: room.spatialEnabled });
  }

  async removeClient({ roomId, clientId }) {
    const room = await this.getRoom(roomId);
    if (!room) return;

    delete room.clients[clientId];
    this.sockets.delete(clientId);

    const clientCount = Object.keys(room.clients).length;
    if (clientCount === 0) {
      await this.deleteRoom(roomId);
    } else {
      await this.updateClientPositions(room);
      await this.saveRoom(roomId, room);
      await this.broadcastSpatialUpdate(room);
    }
  }

  async playAudio(roomId, enable, duration) {
    const room = await this.getRoom(roomId);
    if (!room) return;

    room.songEnabled = enable;

    room.songDuration =
      typeof duration === "number" && duration > 0
        ? duration
        : room.songDuration || DEFAULT_SONG_DURATION;

    room.startTime = enable ? Date.now() : null;

    await this.saveRoom(roomId, room);
    return enable;
  }

  async pauseAudio(roomId) {
    const room = await this.getRoom(roomId);
    if (!room) return;

    room.songEnabled = false;
    await this.saveRoom(roomId, room);
    return false;
  }

  async toggleSpatialAudio(roomId, enable) {
    const room = await this.getRoom(roomId);
    if (!room) return;

    room.spatialEnabled = enable;

    clearInterval(this.intervals.get(roomId));
    this.intervals.delete(roomId);

    if (enable) {
      this.startSpatialAudioLoop(roomId, room);
    } else {
      this.stopSpatialAudioLoop(roomId, room);
    }

    await this.saveRoom(roomId, room);

    for (const clientId of Object.keys(room.clients)) {
      const socket = this.sockets.get(clientId);
      if (socket) {
        socket.emit("spatial-toggle", { enabled: enable });
      }
    }

    await this.broadcastSpatialUpdate(room);
  }

  startSpatialAudioLoop(roomId, room) {
    let step = 0;
    const radius = 50;
    const center = { x: 0, y: 0 };

    const intervalId = setInterval(async () => {
      const angle = (step * Math.PI) / 30;
      room.listeningSource = {
        x: center.x + Math.cos(angle) * radius,
        y: center.y + Math.sin(angle) * radius,
      };
      await this.broadcastSpatialUpdate(room);
      await this.saveRoom(roomId, room);
      step++;
    }, 100);

    this.intervals.set(roomId, intervalId);
  }

  stopSpatialAudioLoop(roomId, room) {
    clearInterval(this.intervals.get(roomId));
    this.intervals.delete(roomId);

    room.listeningSource = { x: 0, y: 0 };

    const gains = {};
    for (const clientId of Object.keys(room.clients)) {
      gains[clientId] = 1;
    }

    const payload = {
      source: room.listeningSource,
      gains,
      enabled: false,
      positions: Object.fromEntries(
        Object.entries(room.clients).map(([id, c]) => [id, c.position])
      ),
    };

    for (const clientId of Object.keys(room.clients)) {
      const socket = this.sockets.get(clientId);
      if (socket) {
        socket.emit("spatial-update", payload);
      }
    }
  }

  async updateClientPositions(room) {
    const clients = Object.entries(room.clients);
    const radius = 50;

    clients.forEach(([, client], index) => {
      const angle = (2 * Math.PI * index) / clients.length;
      client.position = {
        x: Math.cos(angle) * radius,
        y: Math.sin(angle) * radius,
      };
    });
  }

  async broadcastSpatialUpdate(room) {
    const source = room.listeningSource;
    const gains = {};

    for (const [clientId, client] of Object.entries(room.clients)) {
      const dist = this._distance(client.position, source);
      const gain = this._calculateGain(dist);
      gains[clientId] = gain;
    }

    const payload = {
      source,
      gains,
      enabled: room.spatialEnabled,
      positions: Object.fromEntries(
        Object.entries(room.clients).map(([id, c]) => [id, c.position])
      ),
    };

    for (const clientId of Object.keys(room.clients)) {
      const socket = this.sockets.get(clientId);
      if (socket) {
        socket.emit("spatial-update", payload);
      }
    }
  }

  async getClients(roomId) {
    const room = await this.getRoom(roomId);
    if (!room) return [];

    return Object.entries(room.clients).map(([clientId, client]) => ({
      clientId,
      username: client.username,
      position: client.position,
    }));
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
    return Math.min(elapsed, room.songDuration || 0);
  }

  async getRoomAudioState(roomId) {
    const room = await this.getRoom(roomId);
    if (!room) {
      return {
        songEnabled: false,
        elapsedTime: 0,
        songDuration: DEFAULT_SONG_DURATION,
      };
    }

    return {
      songEnabled: room.songEnabled,
      elapsedTime: this._getElapsedTime(room),
      songDuration: room.songDuration || DEFAULT_SONG_DURATION,
    };
  }
}

const roomManager = new RoomManager();
export default roomManager;
