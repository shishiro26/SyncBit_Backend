import roomManager from "../services/RoomManager.js";
import { sendBroadCast, sendUnicast } from "../utils/broadcast.js";

const handleSocketEvents = (io, socket) => {
  const getRoomId = () => {
    const rooms = Array.from(socket.rooms).filter((room) => room !== socket.id);
    return rooms[0];
  };

  socket.on("create-room", async ({ username }) => {
    try {
      const roomId = await roomManager.createRoom();
      socket.join(roomId);

      sendUnicast(socket, "room-created", { roomId, username });
      sendUnicast(socket, "set-client-id", { clientId: socket.id });

      const clients = await roomManager.getClients(roomId);
      sendBroadCast(io, roomId, "room-update", { clients });
    } catch (error) {
      console.error(`Error creating room: ${error.message}`);
      sendUnicast(socket, "error", { message: "Failed to create room" });
    }
  });

  socket.on("join-room", async ({ roomId, username }) => {
    try {
      if (!roomId) {
        sendUnicast(socket, "error", { message: "Room ID is required" });
        return;
      }

      socket.join(roomId);
      const roomData = await roomManager.addClient({
        roomId,
        username,
        clientId: socket.id,
        socket,
      });

      sendUnicast(socket, "set-client-id", { clientId: socket.id });
      sendUnicast(socket, "room-joined", {
        roomId,
        ...roomData,
      });

      const clients = await roomManager.getClients(roomId);
      sendBroadCast(io, roomId, "room-update", { clients });

      // Send current playback state to new client if song is playing
      if (roomData.currentSong && roomData.isPlaying) {
        sendUnicast(socket, "playback-sync", {
          songId: roomData.currentSong,
          isPlaying: roomData.isPlaying,
          playbackStartTime: roomData.playbackStartTime,
          currentTime: roomData.songElapsedTime,
          serverTime: roomData.serverTime,
          hlsUrl: roomData.hlsUrl,
        });
      }
    } catch (error) {
      console.error(`Error joining room: ${error.message}`);
      sendUnicast(socket, "error", { message: "Failed to join room" });
    }
  });

  socket.on("leave-room", async ({ roomId }) => {
    try {
      if (!roomId) return;

      socket.leave(roomId);
      await roomManager.removeClient({ roomId, clientId: socket.id });

      const clients = await roomManager.getClients(roomId);
      sendBroadCast(io, roomId, "room-update", { clients });
    } catch (error) {
      console.error(`Error leaving room: ${error.message}`);
    }
  });

  socket.on("disconnect", async () => {
    const roomId = getRoomId();
    if (!roomId) return;

    try {
      console.log(`Client [${socket.id}] disconnected from room [${roomId}]`);
      await roomManager.removeClient({ roomId, clientId: socket.id });

      const clients = await roomManager.getClients(roomId);
      if (clients.length > 0) {
        sendBroadCast(io, roomId, "room-update", { clients });
      }
    } catch (error) {
      console.error("Error handling disconnect:", error);
    }
  });

  socket.on("spatial-toggle", async ({ roomId, spatialEnabled }) => {
    try {
      if (!roomId) {
        sendUnicast(socket, "error", { message: "Room ID is required" });
        return;
      }

      const room = await roomManager.getRoom(roomId);
      if (!room) {
        sendUnicast(socket, "error", { message: "Room not found" });
        return;
      }

      await roomManager.toggleSpatialAudio(roomId, spatialEnabled);
      sendBroadCast(io, roomId, "spatial-toggled", { spatialEnabled });
    } catch (error) {
      console.error(`Error toggling spatial audio: ${error.message}`);
      sendUnicast(socket, "error", {
        message: "Failed to toggle spatial audio",
      });
    }
  });

  // Song upload with HLS conversion progress
  socket.on("song-upload", async ({ roomId, audioUrl }) => {
    try {
      if (!roomId || !audioUrl) {
        sendUnicast(socket, "error", {
          message: "Room ID and audio URL are required",
        });
        return;
      }

      const room = await roomManager.getRoom(roomId);
      if (!room) {
        sendUnicast(socket, "error", { message: "Room not found" });
        return;
      }

      // Notify upload started
      sendUnicast(socket, "song-upload-started", { audioUrl });

      // Convert to HLS and upload
      const song = await roomManager.uploadSong(roomId, audioUrl);

      // Notify all clients about new song
      sendBroadCast(io, roomId, "song-uploaded", { song });

      // Notify uploader about completion
      sendUnicast(socket, "song-upload-completed", { song });
    } catch (error) {
      console.error(`Error uploading song: ${error.message}`);
      sendUnicast(socket, "error", {
        message: "Failed to upload song",
        details: error.message,
      });
      sendUnicast(socket, "song-upload-failed", {
        audioUrl,
        error: error.message,
      });
    }
  });

  socket.on("song-remove", async ({ roomId, songId }) => {
    try {
      if (!roomId || !songId) {
        sendUnicast(socket, "error", {
          message: "Room ID and song ID are required",
        });
        return;
      }

      const removedSongId = await roomManager.removeSong(roomId, songId);

      sendBroadCast(io, roomId, "song-removed", { songId: removedSongId });
    } catch (error) {
      console.error(`Error removing song: ${error.message}`);
      sendUnicast(socket, "error", { message: "Failed to remove song" });
    }
  });

  socket.on("song-play", async ({ roomId, songId }) => {
    try {
      if (!roomId || !songId) {
        sendUnicast(socket, "error", {
          message: "Room ID and song ID are required",
        });
        return;
      }

      const playData = await roomManager.playSong(roomId, songId);

      // Broadcast to all clients with HLS URL and sync data
      sendBroadCast(io, roomId, "song-started", playData);
    } catch (error) {
      console.error(`Error playing song: ${error.message}`);
      sendUnicast(socket, "error", { message: "Failed to play song" });
    }
  });

  socket.on("song-pause", async ({ roomId }) => {
    try {
      if (!roomId) {
        sendUnicast(socket, "error", { message: "Room ID is required" });
        return;
      }

      const pauseData = await roomManager.pauseSong(roomId);

      sendBroadCast(io, roomId, "song-paused", pauseData);
    } catch (error) {
      console.error(`Error pausing song: ${error.message}`);
      sendUnicast(socket, "error", { message: "Failed to pause song" });
    }
  });

  socket.on("song-resume", async ({ roomId }) => {
    try {
      if (!roomId) {
        sendUnicast(socket, "error", { message: "Room ID is required" });
        return;
      }

      const resumeData = await roomManager.resumeSong(roomId);

      sendBroadCast(io, roomId, "song-resumed", resumeData);
    } catch (error) {
      console.error(`Error resuming song: ${error.message}`);
      sendUnicast(socket, "error", { message: "Failed to resume song" });
    }
  });

  socket.on("song-stop", async ({ roomId }) => {
    try {
      if (!roomId) {
        sendUnicast(socket, "error", { message: "Room ID is required" });
        return;
      }

      const stopData = await roomManager.stopSong(roomId);

      sendBroadCast(io, roomId, "song-stopped", stopData);
    } catch (error) {
      console.error(`Error stopping song: ${error.message}`);
      sendUnicast(socket, "error", { message: "Failed to stop song" });
    }
  });

  socket.on("get-songs", async ({ roomId }) => {
    try {
      if (!roomId) {
        sendUnicast(socket, "error", { message: "Room ID is required" });
        return;
      }

      const songs = await roomManager.getSongs(roomId);

      sendUnicast(socket, "songs-list", { songs });
    } catch (error) {
      console.error(`Error getting songs: ${error.message}`);
      sendUnicast(socket, "error", { message: "Failed to get songs" });
    }
  });

  // Client sync for precise playback
  socket.on("sync-request", async ({ roomId }) => {
    try {
      if (!roomId) return;

      const room = await roomManager.getRoom(roomId);
      if (!room) return;

      if (room.currentSong && room.isPlaying) {
        const currentTime = roomManager._calculateCurrentPlaybackTime(room);

        sendUnicast(socket, "playback-sync", {
          songId: room.currentSong,
          isPlaying: room.isPlaying,
          playbackStartTime: room.playbackStartTime,
          currentTime: currentTime,
          serverTime: Date.now(),
          hlsUrl: room.hlsUrl,
        });
      }
    } catch (error) {
      console.error(`Error handling sync request: ${error.message}`);
    }
  });

  // Client latency measurement for better sync
  socket.on("ping", ({ timestamp }) => {
    sendUnicast(socket, "pong", {
      timestamp,
      serverTime: Date.now(),
    });
  });

  // Manual position update for spatial audio
  socket.on("update-source-position", async ({ roomId, position }) => {
    try {
      if (!roomId || !position) return;

      await roomManager.updateSourcePosition(roomId, position);
    } catch (error) {
      console.error(`Error updating source position: ${error.message}`);
    }
  });
};

export default handleSocketEvents;
