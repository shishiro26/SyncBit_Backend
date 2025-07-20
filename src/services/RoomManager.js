import redis from "../config/redis.js";
import { RADIUS } from "../constants/index.js";

class RoomManager {
  constructor() {
    this.sockets = new Map();
    this.intervals = new Map();
  }
  getServerTime() {
    return Date.now();
  }

  async initRoom(roomId) {
    const room = {
      clients: {},
      spatialEnabled: false,
      songEnabled: false,
      savedElapsedTime: 0,
      startTime: null,
      songDuration: 0,
      listeningSource: { x: 0, y: 0 },
      createdAt: this.getServerTime(),
      lastUpdated: this.getServerTime(),
    };
    await redis.set(this._roomKey(roomId), JSON.stringify(room));
    return room;
  }

  async createRoom() {
    let roomId;
    do {
      roomId = Math.floor(Math.random() * 900000).toString();
    } while (await redis.exists(this._roomKey(roomId)));
    await this.initRoom(roomId);
    return roomId;
  }

  async getRoom(roomId) {
    const data = await redis.get(this._roomKey(roomId));
    return data ? JSON.parse(data) : null;
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

  async saveRoom(roomId, room) {
    room.lastUpdated = this.getServerTime();
    await redis.set(this._roomKey(roomId), JSON.stringify(room));
  }

  async deleteRoom(roomId) {
    clearInterval(this.intervals.get(roomId));
    this.intervals.delete(roomId);
    const room = await this.getRoom(roomId);
    if (room) {
      Object.keys(room.clients).forEach((clientId) =>
        this.sockets.delete(clientId)
      );
    }
    await redis.del(this._roomKey(roomId));
  }

  async addClient({ roomId, username, clientId, socket }) {
    let room = await this.getRoom(roomId);
    if (!room) {
      room = await this.initRoom(roomId);
    }

    for (const [id, client] of Object.entries(room.clients)) {
      if (client.username === username) {
        delete room.clients[id];
        this.sockets.delete(id);
      }
    }

    room.clients[clientId] = {
      position: { x: 0, y: 0 },
      username,
      joinedAt: this.getServerTime(),
    };

    this.sockets.set(clientId, socket);

    await this.updateClientPositions(room);
    await this.saveRoom(roomId, room);
    await this._sendCompleteStateToClient(socket, room);
    await this.broadcastSpatialUpdate(room);

    return room;
  }

  async removeClient({ roomId, clientId }) {
    const room = await this.getRoom(roomId);
    if (!room) return;

    delete room.clients[clientId];
    this.sockets.delete(clientId);

    if (Object.keys(room.clients).length === 0) {
      await this.deleteRoom(roomId);
    } else {
      await this.updateClientPositions(room);
      await this.saveRoom(roomId, room);
      await this.broadcastSpatialUpdate(room);
    }
  }

  async playAudio(roomId, enable, elapsedTime, songDuration) {
    const room = await this.getRoom(roomId);
    if (!room) return;

    room.songEnabled = enable;
    if (songDuration) room.songDuration = songDuration;

    if (enable) {
      const resumeFrom = elapsedTime ?? room.savedElapsedTime ?? 0;
      room.startTime = this.getServerTime() - resumeFrom;
      room.savedElapsedTime = 0;
    } else {
      const elapsed = await this._getElapsedTime(room);
      room.savedElapsedTime = elapsed;
      room.startTime = null;
    }

    await this.saveRoom(roomId, room);
    await this.broadcastCompleteState(room);

    return enable;
  }

  async pauseAudio(roomId) {
    const room = await this.getRoom(roomId);
    if (!room) return;

    room.songEnabled = false;
    const elapsed = await this._getElapsedTime(room);
    room.savedElapsedTime = elapsed;
    room.startTime = null;

    await this.saveRoom(roomId, room);
    await this.broadcastCompleteState(room);

    return false;
  }

  async toggleSpatialAudio(roomId, enable) {
    const room = await this.getRoom(roomId);
    if (!room) return;

    room.spatialEnabled = enable;
    clearInterval(this.intervals.get(roomId));
    this.intervals.delete(roomId);

    if (enable) {
      await this.startSpatialAudio(roomId, room);
    } else {
      room.listeningSource = { x: 0, y: 0 };
      await this.saveRoom(roomId, room);
      await this.broadcastSpatialUpdate(room);
    }

    return enable;
  }

  async startSpatialAudio(roomId, room) {
    let step = 0;
    const radius = 100;
    const center = { x: 0, y: 0 };
    const FRAME_RATE = 100;

    const intervalId = setInterval(async () => {
      const currentRoom = await this.getRoom(roomId);
      if (!currentRoom || !currentRoom.spatialEnabled) {
        clearInterval(intervalId);
        this.intervals.delete(roomId);
        return;
      }

      const angle = (step * Math.PI) / 30;
      currentRoom.listeningSource = {
        x: center.x + radius * Math.cos(angle),
        y: center.y + radius * Math.sin(angle),
      };

      await this.broadcastSpatialUpdate(currentRoom);

      if (step % 30 === 0) {
        await this.saveRoom(roomId, currentRoom);
      }

      step = (step + 1) % 60;
    }, FRAME_RATE);

    this.intervals.set(roomId, intervalId);
    await this.saveRoom(roomId, room);
  }

  async updateClientPositions(room) {
    const clientEntries = Object.entries(room.clients);
    clientEntries.forEach(([id, client], index) => {
      const angle = (index * 2 * Math.PI) / clientEntries.length;
      client.position = {
        x: Math.cos(angle) * RADIUS,
        y: Math.sin(angle) * RADIUS,
      };
    });
  }

  async broadcastSpatialUpdate(room) {
    const source = room.listeningSource;
    const gains = {};

    for (const [clientId, client] of Object.entries(room.clients)) {
      if (room.spatialEnabled) {
        const dist = this._distance(client.position, source);
        gains[clientId] = this._calculateGain(dist);
      } else {
        gains[clientId] = 1.0;
      }
    }

    const payload = {
      source,
      gains,
      enabled: room.spatialEnabled,
      songEnabled: room.songEnabled,
      elapsedTime: await this._getElapsedTime(room),
      songDuration: room.songDuration,
      startTime: room.startTime,
      serverTime: this.getServerTime(),
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

  async broadcastCompleteState(room) {
    const currentTime = this.getServerTime();
    const payload = {
      songEnabled: room.songEnabled,
      spatialEnabled: room.spatialEnabled,
      elapsedTime: await this._getElapsedTime(room),
      songDuration: room.songDuration,
      startTime: room.startTime,
      serverTime: currentTime,
      savedElapsedTime: room.savedElapsedTime,
    };

    for (const clientId of Object.keys(room.clients)) {
      const socket = this.sockets.get(clientId);
      if (socket) {
        socket.emit("complete-state-update", payload);
      }
    }

    await this.broadcastSpatialUpdate(room);
  }

  async _sendCompleteStateToClient(socket, room) {
    const currentTime = this.getServerTime();

    const songPayload = {
      songEnabled: room.songEnabled,
      elapsedTime: this._getElapsedTimeSync(room),
      songDuration: room.songDuration,
      startTime: room.startTime,
      serverTime: currentTime,
      savedElapsedTime: room.savedElapsedTime,
      spatialEnabled: room.spatialEnabled,
    };

    socket.emit("initial-sync", songPayload);

    const gains = {};
    for (const [clientId, client] of Object.entries(room.clients)) {
      if (room.spatialEnabled) {
        const dist = this._distance(client.position, room.listeningSource);
        gains[clientId] = this._calculateGain(dist);
      } else {
        gains[clientId] = 1.0;
      }
    }

    const spatialPayload = {
      source: room.listeningSource,
      gains,
      enabled: room.spatialEnabled,
      songEnabled: room.songEnabled,
      elapsedTime: this._getElapsedTimeSync(room),
      songDuration: room.songDuration,
      startTime: room.startTime,
      serverTime: currentTime,
      positions: Object.fromEntries(
        Object.entries(room.clients).map(([id, c]) => [id, c.position])
      ),
    };

    socket.emit("spatial-update", spatialPayload);
  }

  async broadcastSongState(room) {
    await this.broadcastCompleteState(room);
  }

  _sendSongStateToClient(socket, room) {
    this._sendCompleteStateToClient(socket, room);
  }

  _getElapsedTimeSync(room) {
    if (!room) return 0;
    if (room.songEnabled && room.startTime) {
      return Math.min(this.getServerTime() - room.startTime, room.songDuration);
    }
    return room.savedElapsedTime || 0;
  }

  _roomKey(roomId) {
    return `room:${roomId}`;
  }

  _distance(p1, p2) {
    const dx = p1.x - p2.x;
    const dy = p1.y - p2.y;
    return Math.sqrt(dx * dx + dy * dy);
  }

  _calculateGain(distance) {
    const maxDistance = RADIUS;
    const minGain = 0.1;

    if (distance >= maxDistance) return minGain;
    const gain = 1 - distance / maxDistance;
    return Math.max(gain, minGain);
  }

  async _getElapsedTime(room) {
    if (!room) return 0;
    if (room.songEnabled && room.startTime) {
      return Math.min(this.getServerTime() - room.startTime, room.songDuration);
    }
    return room.savedElapsedTime || 0;
  }
}

const roomManager = new RoomManager();
export default roomManager;
