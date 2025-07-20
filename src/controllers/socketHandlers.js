import roomManager from "../services/RoomManager.js";
import { sendUnicast, sendBroadCast } from "../utils/broadcast.js";
import ntpManager from "../services/TimeManager.js";
import ntpClient from "ntp-client";

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

  socket.on(
    "play-audio",
    async ({ serverTimeToExecute, songDuration, songUrl }) => {
      const roomId = getRoomId();
      if (!roomId) return;

      try {
        const currentServerTime = ntpManager.getServerTime();
        const executeTime = serverTimeToExecute || currentServerTime;
        const delay = Math.max(0, executeTime - currentServerTime);

        let elapsedTime = 0;
        if (delay === 0) {
          elapsedTime = 0;
        }

        setTimeout(async () => {
          await roomManager.playAudio(roomId, true, elapsedTime, songDuration);

          const payload = {
            action: "play",
            serverTime: ntpManager.getServerTime(),
            songDuration,
            songUrl,
            elapsedTime,
          };

          sendBroadCast(io, roomId, "audio-command", payload);
        }, delay);
      } catch (error) {
        console.error("Error playing audio:", error);
        sendUnicast(socket, "error", { message: "Failed to play audio" });
      }
    }
  );

  socket.on("pause-audio", async ({ serverTimeToExecute }) => {
    const roomId = getRoomId();
    if (!roomId) return;

    try {
      const currentServerTime = ntpManager.getServerTime();
      const executeTime = serverTimeToExecute || currentServerTime;
      const delay = Math.max(0, executeTime - currentServerTime);

      setTimeout(async () => {
        await roomManager.pauseAudio(roomId);

        const payload = {
          action: "pause",
          serverTime: ntpManager.getServerTime(),
        };

        sendBroadCast(io, roomId, "audio-command", payload);
      }, delay);
    } catch (error) {
      console.error("Error pausing audio:", error);
      sendUnicast(socket, "error", { message: "Failed to pause audio" });
    }
  });

  socket.on("seek-audio", async ({ position, serverTimeToExecute }) => {
    const roomId = getRoomId();
    if (!roomId) return;

    try {
      const currentServerTime = ntpManager.getServerTime();
      const executeTime = serverTimeToExecute || currentServerTime;
      const delay = Math.max(0, executeTime - currentServerTime);

      setTimeout(async () => {
        const room = await roomManager.getRoom(roomId);
        if (!room) return;

        await roomManager.playAudio(
          roomId,
          room.songEnabled,
          position,
          room.songDuration
        );

        const payload = {
          action: "seek",
          position,
          serverTime: ntpManager.getServerTime(),
          songEnabled: room.songEnabled,
        };

        sendBroadCast(io, roomId, "audio-command", payload);
      }, delay);
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
          elapsedTime: await roomManager._getElapsedTime(room),
          serverTime: ntpManager.getServerTime(),
        };

        sendUnicast(socket, "room-state", state);
      }
    } catch (error) {
      console.error("Error getting room state:", error);
      sendUnicast(socket, "error", { message: "Failed to get room state" });
    }
  });

  socket.on("ntp-request", ({ t0 }) => {
    const t1 = Date.now();

    ntpClient.getNetworkTime("pool.ntp.org", 123, (err, date) => {
      const t2 = Date.now();
      const ntpT1 = err ? t1 : date.getTime();
      const ntpT2 = err ? t2 : date.getTime();

      socket.emit("ntp-response", {
        t0,
        t1: ntpT1,
        t2: ntpT2,
        serverTime: ntpManager.getServerTime(),
        offset: ntpManager.ntpOffset,
      });
    });
  });

  socket.on("sync-request", () => {
    socket.emit("sync-response", {
      serverTime: ntpManager.getServerTime(),
      offset: ntpManager.ntpOffset,
      lastSync: ntpManager.lastSync,
    });
  });

  socket.on("force-ntp-sync", async () => {
    try {
      await ntpManager.syncWithNTP();
      socket.emit("ntp-sync-complete", {
        offset: ntpManager.ntpOffset,
        serverTime: ntpManager.getServerTime(),
      });
    } catch (error) {
      socket.emit("ntp-sync-error", { error: error.message });
    }
  });
};

export default handleSocketEvents;
