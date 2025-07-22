import redis from "../config/redis.js";
import { RADIUS } from "../constants/index.js";
import ffmpeg from "fluent-ffmpeg";
import fs from "fs";
import path from "path";

class RoomManager {
  constructor() {
    this.sockets = new Map();
    this.intervals = new Map();
    this.hlsStreams = new Map();
    this.outputDir = "./hls_output";
    this.ensureDirectoryExists();
  }

  ensureDirectoryExists() {
    if (!fs.existsSync(this.outputDir)) {
      fs.mkdirSync(this.outputDir, { recursive: true });
    }
  }

  getServerTime() {
    return Date.now();
  }

  async processAudioToHLS(audioUrl, roomId) {
    const outputPath = path.join(this.outputDir, roomId);

    if (!fs.existsSync(outputPath)) {
      fs.mkdirSync(outputPath, { recursive: true });
    }

    return new Promise((resolve, reject) => {
      ffmpeg(audioUrl)
        .audioCodec("aac")
        .audioBitrate("128k")
        .audioChannels(2)
        .audioFrequency(44100)
        .outputOptions([
          "-f hls",
          "-hls_time 8",
          "-hls_list_size 0",
          "-hls_segment_type mpegts",
          "-hls_flags independent_segments",
        ])
        .output(path.join(outputPath, "playlist.m3u8"))
        .on("end", () => {
          const playlistPath = path.join(outputPath, "playlist.m3u8");
          const duration = this.getAudioDuration(playlistPath);
          const segments = this.parseM3U8Segments(playlistPath);

          resolve({
            playlistUrl: `/hls/${roomId}/playlist.m3u8`,
            duration,
            segments,
            outputPath,
          });
        })
        .on("error", reject)
        .run();
    });
  }

  parseM3U8Segments(playlistPath) {
    const content = fs.readFileSync(playlistPath, "utf8");
    const lines = content.split("\n");
    const segments = [];
    let currentTime = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();

      if (line.startsWith("#EXTINF:")) {
        const duration = parseFloat(line.split(":")[1].split(",")[0]) * 1000; // ms
        const segmentFile = lines[i + 1]?.trim();

        if (segmentFile && !segmentFile.startsWith("#")) {
          segments.push({
            file: segmentFile,
            duration,
            startTime: currentTime,
            endTime: currentTime + duration,
          });
          currentTime += duration;
        }
      }
    }

    return segments;
  }

  getAudioDuration(playlistPath) {
    const segments = this.parseM3U8Segments(playlistPath);
    return segments.reduce((total, seg) => total + seg.duration, 0);
  }

  getSegmentForTime(roomId, elapsedTime) {
    const hlsData = this.hlsStreams.get(roomId);
    if (!hlsData?.segments) return null;

    return hlsData.segments.find(
      (segment) =>
        elapsedTime >= segment.startTime && elapsedTime < segment.endTime
    );
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
      hlsPlaylistUrl: null,
      audioUrl: null,
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

  async saveRoom(roomId, room) {
    room.lastUpdated = this.getServerTime();
    await redis.set(this._roomKey(roomId), JSON.stringify(room));
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

  async deleteRoom(roomId) {
    clearInterval(this.intervals.get(roomId));
    this.intervals.delete(roomId);

    const outputPath = path.join(this.outputDir, roomId);
    if (fs.existsSync(outputPath)) {
      fs.rmSync(outputPath, { recursive: true, force: true });
    }
    this.hlsStreams.delete(roomId);

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

    // Remove existing client with same username
    for (const [id, client] of Object.entries(room.clients)) {
      if (client.username === username) {
        delete room.clients[id];
        this.sockets.delete(id);
      }
    }

    const isLateJoiner = room.songEnabled;
    room.clients[clientId] = {
      position: { x: 0, y: 0 },
      username,
      joinedAt: this.getServerTime(),
      lateJoiner: isLateJoiner,
    };

    this.sockets.set(clientId, socket);
    await this.updateClientPositions(room);
    await this.saveRoom(roomId, room);

    // Send initial state
    await this._sendCompleteStateToClient(socket, room);

    // Handle late joiner sync
    if (isLateJoiner && room.hlsPlaylistUrl) {
      await this.sendLateJoinerSync(clientId, room);
    }

    await this.broadcastSpatialUpdate(room);
    return room;
  }

  // Late joiner synchronization
  async sendLateJoinerSync(clientId, room) {
    const socket = this.sockets.get(clientId);
    if (!socket) return;

    const currentElapsedTime = this._getElapsedTimeSync(room);
    const currentSegment = this.getSegmentForTime(
      room.roomId,
      currentElapsedTime
    );

    if (!currentSegment) {
      console.warn(
        `No segment found for time ${currentElapsedTime}ms in room ${room.roomId}`
      );
      return;
    }

    const segmentOffset = currentElapsedTime - currentSegment.startTime;

    socket.emit("late-joiner-sync", {
      playlistUrl: room.hlsPlaylistUrl,
      audioUrl: room.audioUrl,
      currentSegment: currentSegment,
      segmentOffset: segmentOffset,
      totalElapsedTime: currentElapsedTime,
      serverTime: this.getServerTime(),
      songDuration: room.songDuration,
      spatialEnabled: room.spatialEnabled,
      sourcePosition: room.listeningSource,
      userPositions: Object.fromEntries(
        Object.entries(room.clients).map(([id, c]) => [id, c.position])
      ),
    });
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

  async playAudio(roomId, enable, elapsedTime, songDuration, audioUrl = null) {
    const room = await this.getRoom(roomId);
    if (!room) return;

    if (audioUrl && enable) {
      try {
        console.log(`Processing audio to HLS for room ${roomId}`);
        const hlsData = await this.processAudioToHLS(audioUrl, roomId);

        room.hlsPlaylistUrl = hlsData.playlistUrl;
        room.audioUrl = audioUrl;
        room.songDuration = hlsData.duration;

        this.hlsStreams.set(roomId, hlsData);
        console.log(`HLS processing complete: ${hlsData.duration}ms duration`);
      } catch (error) {
        console.error("Failed to process audio to HLS:", error);
        throw new Error("Audio processing failed");
      }
    }

    room.songEnabled = enable;

    if (enable) {
      const resumeFrom = elapsedTime ?? room.savedElapsedTime ?? 0;
      room.startTime = this.getServerTime() - resumeFrom;
      room.savedElapsedTime = 0;
    } else {
      room.savedElapsedTime = this._getElapsedTimeSync(room);
      room.startTime = null;
    }

    await this.saveRoom(roomId, room);
    await this.broadcastHLSCommand(room, enable);
    return enable;
  }

  // Broadcast HLS-specific commands
  async broadcastHLSCommand(room, enable) {
    const payload = {
      action: enable ? "play" : "pause",
      serverTime: this.getServerTime(),
      startTime: room.startTime,
      elapsedTime: this._getElapsedTimeSync(room),
      songDuration: room.songDuration,
      playlistUrl: room.hlsPlaylistUrl,
      audioUrl: room.audioUrl,
      spatialEnabled: room.spatialEnabled,
    };

    for (const clientId of Object.keys(room.clients)) {
      const socket = this.sockets.get(clientId);
      if (socket) {
        socket.emit("hls-command", payload);
      }
    }
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

  async updateSourcePosition(roomId, position) {
    const room = await this.getRoom(roomId);
    if (!room) return;

    room.listeningSource = position;
    await this.saveRoom(roomId, room);
    await this.broadcastSpatialUpdate(room);
    return room.listeningSource;
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
      elapsedTime: this._getElapsedTimeSync(room),
      songDuration: room.songDuration,
      startTime: room.startTime,
      serverTime: this.getServerTime(),
      playlistUrl: room.hlsPlaylistUrl,
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

  async _sendCompleteStateToClient(socket, room) {
    const currentTime = this.getServerTime();

    const initialPayload = {
      songEnabled: room.songEnabled,
      elapsedTime: this._getElapsedTimeSync(room),
      songDuration: room.songDuration,
      startTime: room.startTime,
      serverTime: currentTime,
      savedElapsedTime: room.savedElapsedTime,
      spatialEnabled: room.spatialEnabled,
      playlistUrl: room.hlsPlaylistUrl,
      audioUrl: room.audioUrl,
      sourcePosition: room.listeningSource,
    };

    socket.emit("initial-sync", initialPayload);

    // Send spatial update
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
      playlistUrl: room.hlsPlaylistUrl,
      positions: Object.fromEntries(
        Object.entries(room.clients).map(([id, c]) => [id, c.position])
      ),
    };

    socket.emit("spatial-update", spatialPayload);
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

  _getElapsedTimeSync(room) {
    if (!room) return 0;
    if (room.songEnabled && room.startTime) {
      return Math.min(this.getServerTime() - room.startTime, room.songDuration);
    }
    return room.savedElapsedTime || 0;
  }
}

const roomManager = new RoomManager();
export default roomManager;
