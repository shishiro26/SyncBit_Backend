import roomManager from "../services/RoomManager.js";
import { sendUnicast, sendBroadCast } from "../utils/broadcast.js";

const handleSocketEvents = (io, socket) => {
  const getRoomId = () => {
    const rooms = Array.from(socket.rooms).filter((r) => r !== socket.id);
    return rooms[0];
  };

  socket.on("create-room", async ({ username }) => {
    try {
      const roomId = await roomManager.createRoom();
      socket.join(roomId);

      await roomManager.addClient({
        roomId,
        username,
        clientId: socket.id,
        socket,
      });

      sendUnicast(socket, "room-created", { roomId });
      sendUnicast(socket, "set-client-id", { clientId: socket.id });

      const clients = await roomManager.getClients(roomId);
      sendBroadCast(io, roomId, "room-update", { clients });
    } catch (error) {
      console.error("Error creating room:", error);
      sendUnicast(socket, "error", { message: "Failed to create room" });
    }
  });

  socket.on("join-room", async ({ roomId, username }) => {
    if (!roomId) {
      sendUnicast(socket, "error", { message: "Room ID is required" });
      return;
    }

    try {
      console.log(
        `Client [${socket.id}] joining room [${roomId}] with username [${username}]`
      );

      socket.join(roomId);
      await roomManager.addClient({
        roomId,
        username,
        clientId: socket.id,
        socket,
      });

      sendUnicast(socket, "set-client-id", { clientId: socket.id });
      sendUnicast(socket, "room-joined", { roomId });

      const clients = await roomManager.getClients(roomId);
      sendBroadCast(io, roomId, "room-update", { clients });
    } catch (error) {
      console.error("Error joining room:", error);
      sendUnicast(socket, "error", { message: "Failed to join room" });
    }
  });

  socket.on("leave-room", async () => {
    const roomId = getRoomId();
    if (!roomId) return;

    try {
      await roomManager.removeClient({ roomId, clientId: socket.id });
      socket.leave(roomId);

      const clients = await roomManager.getClients(roomId);
      sendBroadCast(io, roomId, "room-update", { clients });
    } catch (error) {
      console.error("Error leaving room:", error);
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

  socket.on("play-audio", async ({ songDuration, audioUrl, elapsedTime }) => {
    const roomId = getRoomId();
    if (!roomId) return;

    try {
      await roomManager.playAudio(
        roomId,
        true,
        elapsedTime,
        songDuration,
        "https://res.cloudinary.com/dor4hhdzh/video/upload/v1753204341/spinning-head-271171_qoxlyz.mp3"
      );
    } catch (error) {
      console.error("Error playing audio:", error);
      sendUnicast(socket, "error", { message: "Failed to play audio" });
    }
  });

  socket.on("pause-audio", async () => {
    const roomId = getRoomId();
    if (!roomId) return;

    try {
      await roomManager.playAudio(roomId, false);
    } catch (error) {
      console.error("Error pausing audio:", error);
      sendUnicast(socket, "error", { message: "Failed to pause audio" });
    }
  });

  socket.on("seek-audio", async ({ position }) => {
    const roomId = getRoomId();
    if (!roomId) return;

    try {
      const room = await roomManager.getRoom(roomId);
      if (!room) return;

      await roomManager.playAudio(
        roomId,
        room.songEnabled,
        position,
        room.songDuration
      );
    } catch (error) {
      console.error("Error seeking audio:", error);
      sendUnicast(socket, "error", { message: "Failed to seek audio" });
    }
  });

  socket.on("toggle-spatial", async ({ roomId, enable }) => {
    if (!roomId) return;

    try {
      await roomManager.toggleSpatialAudio(roomId, enable);
      sendBroadCast(io, roomId, "spatial-toggled", { enabled: enable });
    } catch (error) {
      console.error("Error toggling spatial audio:", error);
      sendUnicast(socket, "error", {
        message: "Failed to toggle spatial audio",
      });
    }
  });

  socket.on("update-source", async ({ position }) => {
    const roomId = getRoomId();
    if (!roomId) return;

    try {
      await roomManager.updateSourcePosition(roomId, position);
    } catch (error) {
      console.error("Error updating source:", error);
      sendUnicast(socket, "error", { message: "Failed to update source" });
    }
  });

  socket.on("get-room-state", async () => {
    const roomId = getRoomId();
    if (!roomId) return;

    try {
      const room = await roomManager.getRoom(roomId);
      const clients = await roomManager.getClients(roomId);

      if (room) {
        const state = {
          roomId,
          clients,
          spatialEnabled: room.spatialEnabled,
          songEnabled: room.songEnabled,
          songDuration: room.songDuration,
          elapsedTime: roomManager._getElapsedTimeSync(room),
          serverTime: roomManager.getServerTime(),
          playlistUrl: room.hlsPlaylistUrl,
          audioUrl: room.audioUrl,
          listeningSource: room.listeningSource,
        };

        sendUnicast(socket, "room-state", state);
      }
    } catch (error) {
      console.error("Error getting room state:", error);
      sendUnicast(socket, "error", { message: "Failed to get room state" });
    }
  });

  socket.on("request-resync", async () => {
    const roomId = getRoomId();
    if (!roomId) return;

    try {
      const room = await roomManager.getRoom(roomId);
      if (!room || !room.songEnabled) return;

      await roomManager.sendLateJoinerSync(socket.id, room);
    } catch (error) {
      console.error("Error handling resync request:", error);
      sendUnicast(socket, "error", { message: "Failed to resync" });
    }
  });
};

export default handleSocketEvents;
