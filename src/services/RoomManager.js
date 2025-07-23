import redis from "../config/redis.js";
import { RADIUS } from "../constants/index.js";
import ffmpeg from "fluent-ffmpeg";
import path from "path";
import fs from "fs/promises";
import { fileURLToPath } from "url";
import ffmpegPath from "@ffmpeg-installer/ffmpeg";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
ffmpeg.setFfmpegPath(ffmpegPath.path);

class RoomManager {
  constructor() {
    this.sockets = new Map();
    this.intervals = new Map();
    this.syncIntervals = new Map();
    this.hlsOutputDir = path.join(__dirname, "../public/hls");
    this._ensureHLSDirectory();
  }

  async _ensureHLSDirectory() {
    try {
      await fs.mkdir(this.hlsOutputDir, { recursive: true });
    } catch (error) {
      console.error("Error creating HLS directory:", error);
    }
  }

  async initRoom(roomId) {
    const room = {
      clients: {},
      songs: {},
      currentSong: null,
      songElapsedTime: 0,
      songStartTime: null,
      isPlaying: false,
      playbackStartTime: null,
      serverTime: null,
      soundSource: { x: 0, y: 0 },
      spatialEnabled: false,
      hlsUrl: null,
      playbackRate: 1.0,
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
    const room = await redis.get(this._roomKey(roomId));
    return room ? JSON.parse(room) : null;
  }

  async getClients(roomId) {
    const room = await this.getRoom(roomId);
    if (!room) {
      return [];
    }

    return Object.entries(room.clients).map(([id, client]) => ({
      id,
      username: client.username,
      position: client.position,
    }));
  }

  async getSongs(roomId) {
    const room = await this.getRoom(roomId);
    if (!room) {
      return [];
    }

    return Object.entries(room.songs).map(([id, song]) => ({
      id,
      songUrl: song.songUrl,
      hlsUrl: song.hlsUrl,
      uploadedAt: song.uploadedAt,
      duration: song.duration,
    }));
  }

  async saveRoom(roomId, room) {
    await redis.set(this._roomKey(roomId), JSON.stringify(room));
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

    room.clients[clientId] = {
      username,
      position: { x: 0, y: 0 },
      joinedAt: Date.now(),
      lastSyncTime: Date.now(),
      latency: 0,
    };

    this.sockets.set(clientId, socket);
    this.updateClientPositions(room);
    await this.saveRoom(roomId, room);
    await this.broadCastSpatialUpdate(room);

    // Start sync for this room if not already started
    if (!this.syncIntervals.has(roomId)) {
      this.startSyncBroadcast(roomId);
    }

    const currentPlaybackTime = this._calculateCurrentPlaybackTime(room);

    return {
      currentSong: room.currentSong,
      isPlaying: room.isPlaying,
      songElapsedTime: currentPlaybackTime,
      playbackStartTime: room.playbackStartTime,
      serverTime: Date.now(),
      hlsUrl: room.hlsUrl,
      songs: Object.entries(room.songs).map(([id, song]) => ({
        id,
        songUrl: song.songUrl,
        hlsUrl: song.hlsUrl,
        uploadedAt: song.uploadedAt,
        duration: song.duration,
      })),
    };
  }

  async removeClient({ roomId, clientId }) {
    const room = await this.getRoom(roomId);
    if (!room) {
      return;
    }

    delete room.clients[clientId];
    this.sockets.delete(clientId);

    if (Object.keys(room.clients).length === 0) {
      // Clear all intervals before deleting room
      if (this.intervals.has(roomId)) {
        clearInterval(this.intervals.get(roomId));
        this.intervals.delete(roomId);
      }
      if (this.syncIntervals.has(roomId)) {
        clearInterval(this.syncIntervals.get(roomId));
        this.syncIntervals.delete(roomId);
      }
      await redis.del(this._roomKey(roomId));
    } else {
      this.updateClientPositions(room);
      await this.saveRoom(roomId, room);
    }
  }

  // Convert audio URL to HLS using fluent-ffmpeg
  async uploadSong(roomId, audioUrl) {
    const room = await this.getRoom(roomId);
    if (!room) {
      throw new Error("Room not found");
    }

    const songId = `song_${Date.now()}_${Math.random()
      .toString(36)
      .substring(2, 9)}`;

    console.log(`Converting audio to HLS for song: ${songId}`);
    console.log(`Audio URL: ${audioUrl}`);

    try {
      // Create HLS stream from audio URL
      const { hlsUrl, duration } = await this._convertToHLS(audioUrl, songId);

      room.songs[songId] = {
        songUrl: audioUrl,
        hlsUrl: hlsUrl,
        uploadedAt: Date.now(),
        duration: duration,
      };

      await this.saveRoom(roomId, room);

      console.log(`Successfully converted song ${songId} to HLS`);

      return {
        id: songId,
        songUrl: audioUrl,
        hlsUrl: hlsUrl,
        uploadedAt: room.songs[songId].uploadedAt,
        duration: duration,
      };
    } catch (error) {
      console.error("Error converting to HLS:", error);
      throw new Error(`Failed to process audio file: ${error.message}`);
    }
  }

  async removeSong(roomId, songId) {
    const room = await this.getRoom(roomId);
    if (!room) {
      throw new Error("Room not found");
    }

    if (!room.songs[songId]) {
      throw new Error("Song not found");
    }

    if (room.currentSong === songId) {
      room.currentSong = null;
      room.isPlaying = false;
      room.songElapsedTime = 0;
      room.songStartTime = null;
      room.playbackStartTime = null;
      room.hlsUrl = null;
    }

    // Clean up HLS files
    if (room.songs[songId].hlsUrl) {
      await this._cleanupHLS(songId);
    }

    delete room.songs[songId];
    await this.saveRoom(roomId, room);

    return songId;
  }

  // Convert audio URL to HLS using fluent-ffmpeg
  async _convertToHLS(audioUrl, songId) {
    return new Promise((resolve, reject) => {
      const outputDir = path.join(this.hlsOutputDir, songId);
      const playlistPath = path.join(outputDir, "playlist.m3u8");
      const segmentPattern = path.join(outputDir, "segment_%03d.ts");

      fs.mkdir(outputDir, { recursive: true })
        .then(() => {
          console.log(`Created HLS directory: ${outputDir}`);

          // Configure ffmpeg command
          const command = ffmpeg(audioUrl)
            .audioCodec("aac")
            .audioBitrate("128k")
            .audioChannels(2)
            .audioFrequency(44100)
            .format("hls")
            .outputOptions([
              "-hls_time 10", // 10 second segments
              "-hls_list_size 0", // Keep all segments in playlist
              "-hls_segment_filename",
              segmentPattern,
              "-hls_flags independent_segments", // Each segment is independent
              "-hls_segment_type mpegts", // Use MPEG-TS segments
              "-start_number 0", // Start segment numbering at 0
              "-hls_allow_cache 1", // Allow caching
              "-hls_base_url",
              `./`, // Base URL for segments
            ])
            .output(playlistPath);

          let duration = 0;

          // Get duration during processing
          command.on("codecData", (data) => {
            console.log(`Audio duration: ${data.duration}`);
            duration = this._parseDuration(data.duration);
          });

          command.on("progress", (progress) => {
            console.log(
              `HLS conversion progress: ${progress.percent?.toFixed(2) || 0}%`
            );
          });

          command.on("end", () => {
            console.log(`HLS conversion completed for song: ${songId}`);

            const hlsUrl = `/hls/${songId}/playlist.m3u8`;

            resolve({
              hlsUrl,
              duration: duration || 0,
            });
          });

          command.on("error", (err) => {
            console.error(`FFmpeg error for song ${songId}:`, err);
            reject(new Error(`FFmpeg conversion failed: ${err.message}`));
          });

          command.run();
        })
        .catch(reject);
    });
  }

  // Parse duration string to milliseconds
  _parseDuration(durationStr) {
    if (!durationStr) return 0;

    const timeParts = durationStr.split(":");
    if (timeParts.length !== 3) return 0;

    const hours = parseInt(timeParts[0]) || 0;
    const minutes = parseInt(timeParts[1]) || 0;
    const seconds = parseFloat(timeParts[2]) || 0;

    return (hours * 3600 + minutes * 60 + seconds) * 1000;
  }

  // Clean up HLS files
  async _cleanupHLS(songId) {
    try {
      const songDir = path.join(this.hlsOutputDir, songId);
      await fs.rm(songDir, { recursive: true, force: true });
      console.log(`Cleaned up HLS files for song: ${songId}`);
    } catch (error) {
      console.error(`Error cleaning up HLS files for ${songId}:`, error);
    }
  }

  async playSong(roomId, songId) {
    const room = await this.getRoom(roomId);
    if (!room) {
      throw new Error("Room not found");
    }

    if (!room.songs[songId]) {
      throw new Error("Song not found");
    }

    const now = Date.now();
    room.currentSong = songId;
    room.isPlaying = true;
    room.songElapsedTime = 0;
    room.songStartTime = now;
    room.playbackStartTime = now + 2000; // 2 second buffer for sync
    room.hlsUrl = room.songs[songId].hlsUrl;
    room.serverTime = now;

    await this.saveRoom(roomId, room);
    await this._broadcastPlaybackSync(roomId, room);

    return {
      songId,
      songUrl: room.songs[songId].songUrl,
      hlsUrl: room.songs[songId].hlsUrl,
      isPlaying: true,
      elapsedTime: 0,
      playbackStartTime: room.playbackStartTime,
      serverTime: now,
      duration: room.songs[songId].duration,
    };
  }

  async pauseSong(roomId) {
    const room = await this.getRoom(roomId);
    if (!room) {
      throw new Error("Room not found");
    }

    const now = Date.now();
    if (room.isPlaying && room.playbackStartTime) {
      room.songElapsedTime = Math.max(0, now - room.playbackStartTime);
    }

    room.isPlaying = false;
    room.songStartTime = null;
    room.playbackStartTime = null;
    room.serverTime = now;

    await this.saveRoom(roomId, room);
    await this._broadcastPlaybackSync(roomId, room);

    return {
      songId: room.currentSong,
      isPlaying: false,
      elapsedTime: room.songElapsedTime,
      serverTime: now,
    };
  }

  async resumeSong(roomId) {
    const room = await this.getRoom(roomId);
    if (!room) {
      throw new Error("Room not found");
    }

    if (!room.currentSong) {
      throw new Error("No song to resume");
    }

    const now = Date.now();
    room.isPlaying = true;
    room.songStartTime = now;
    room.playbackStartTime = now + 1000; // 1 second buffer for resume
    room.serverTime = now;

    await this.saveRoom(roomId, room);
    await this._broadcastPlaybackSync(roomId, room);

    return {
      songId: room.currentSong,
      songUrl: room.songs[room.currentSong].songUrl,
      hlsUrl: room.songs[room.currentSong].hlsUrl,
      isPlaying: true,
      elapsedTime: room.songElapsedTime,
      playbackStartTime: room.playbackStartTime,
      serverTime: now,
    };
  }

  async stopSong(roomId) {
    const room = await this.getRoom(roomId);
    if (!room) {
      throw new Error("Room not found");
    }

    room.currentSong = null;
    room.isPlaying = false;
    room.songElapsedTime = 0;
    room.songStartTime = null;
    room.playbackStartTime = null;
    room.hlsUrl = null;
    room.serverTime = Date.now();

    await this.saveRoom(roomId, room);
    await this._broadcastPlaybackSync(roomId, room);

    return { stopped: true, serverTime: room.serverTime };
  }

  // Precise sync broadcasting every 500ms
  startSyncBroadcast(roomId) {
    const syncInterval = setInterval(async () => {
      const room = await this.getRoom(roomId);
      if (!room || Object.keys(room.clients).length === 0) {
        clearInterval(syncInterval);
        this.syncIntervals.delete(roomId);
        return;
      }

      if (room.isPlaying && room.currentSong) {
        await this._broadcastPlaybackSync(roomId, room);
      }
    }, 500); // Sync every 500ms

    this.syncIntervals.set(roomId, syncInterval);
  }

  async _broadcastPlaybackSync(roomId, room) {
    const now = Date.now();
    const currentPlaybackTime = this._calculateCurrentPlaybackTime(room);

    const syncData = {
      songId: room.currentSong,
      isPlaying: room.isPlaying,
      playbackStartTime: room.playbackStartTime,
      currentTime: currentPlaybackTime,
      serverTime: now,
      hlsUrl: room.hlsUrl,
    };

    const clients = Object.entries(room.clients);
    for (const [clientId] of clients) {
      const socket = this.sockets.get(clientId);
      if (socket) {
        socket.emit("playback-sync", syncData);
      }
    }
  }

  _calculateCurrentPlaybackTime(room) {
    if (!room.isPlaying || !room.playbackStartTime) {
      return room.songElapsedTime || 0;
    }

    const now = Date.now();
    if (now < room.playbackStartTime) {
      return room.songElapsedTime || 0;
    }

    return (room.songElapsedTime || 0) + (now - room.playbackStartTime);
  }

  async toggleSpatialAudio(roomId, spatialEnable) {
    const room = await this.getRoom(roomId);
    if (!room) {
      return;
    }

    room.spatialEnabled = spatialEnable;

    if (this.intervals.has(roomId)) {
      clearInterval(this.intervals.get(roomId));
      this.intervals.delete(roomId);
    }

    if (spatialEnable) {
      await this.startSpatialAudio(roomId, room);
    } else {
      room.soundSource = { x: 0, y: 0 };
      await this.saveRoom(roomId, room);
      await this.broadCastSpatialUpdate(room);
    }
  }

  async startSpatialAudio(roomId, room) {
    let step = 0;
    const radius = RADIUS;
    const center = { x: 0, y: 0 };
    const FRAME_RATE = 100;

    const interval = setInterval(async () => {
      const currentRoom = await this.getRoom(roomId);
      if (!currentRoom || !currentRoom.spatialEnabled) {
        clearInterval(interval);
        this.intervals.delete(roomId);
        return;
      }

      const angle = (step * Math.PI * 2) / 100;
      currentRoom.soundSource = {
        x: center.x + Math.cos(angle) * radius,
        y: center.y + Math.sin(angle) * radius,
      };

      await this.saveRoom(roomId, currentRoom);
      await this.broadCastSpatialUpdate(currentRoom);
      step = (step + 1) % 100;
    }, FRAME_RATE);

    this.intervals.set(roomId, interval);
  }

  async updateSourcePosition(roomId, position) {
    const room = await this.getRoom(roomId);
    if (!room) {
      return;
    }

    room.soundSource = position;
    await this.saveRoom(roomId, room);
    await this.broadCastSpatialUpdate(room);
  }

  updateClientPositions(room) {
    const clients = Object.entries(room.clients);
    clients.forEach(([id, client], index) => {
      const angle = (index * 2 * Math.PI) / clients.length;
      client.position = {
        x: Math.cos(angle) * RADIUS,
        y: Math.sin(angle) * RADIUS,
      };
    });
  }

  async broadCastSpatialUpdate(room) {
    const source = room.soundSource;
    const clients = Object.entries(room.clients);
    const gains = {};

    for (const [id, client] of clients) {
      if (room.spatialEnabled) {
        const dist = this._calculateDistance(client.position, source);
        gains[id] = this._calculateGain(dist);
      } else {
        gains[id] = 1.0;
      }
    }

    const payload = {
      source,
      gains,
      enabled: room.spatialEnabled,
      positions: Object.fromEntries(
        clients.map(([id, client]) => [id, client.position])
      ),
    };

    for (const [clientId] of clients) {
      const socket = this.sockets.get(clientId);
      if (socket) {
        socket.emit("spatial-update", payload);
      }
    }
  }

  _roomKey(roomId) {
    return `room:${roomId}`;
  }

  _calculateDistance(p1, p2) {
    const dx = p1.x - p2.x;
    const dy = p1.y - p2.y;
    return Math.sqrt(dx * dx + dy * dy);
  }

  _calculateGain(distance) {
    const maxDistance = RADIUS;
    const minGain = 0.5;
    const gain = 1 - (distance / maxDistance) * (1 - minGain);
    return Math.max(gain, minGain);
  }
}

const roomManager = new RoomManager();
export default roomManager;
