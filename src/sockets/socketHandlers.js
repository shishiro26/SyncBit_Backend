import ntpClient from "ntp-client";
import roomManager from "../core/RoomManager.js";
import { sendBroadcast, sendUnicast } from "../utils/broadcast.js";

export function handleSocketEvents(io, socket) {
  const getRoomId = () => {
    const rooms = Array.from(socket.rooms).filter((r) => r !== socket.id);
    return rooms[0];
  };
  socket.on("create-room", ({ username }) => {
    const roomId = roomManager.createRoom();
    socket.join(roomId);
    roomManager.addClient({ roomId, clientId: socket.id, username, socket });
    sendUnicast(socket, "room-created", { roomId });
    sendUnicast(socket, "set-client-id", { clientId: socket.id });
    const clients = roomManager.getClients(roomId);
    sendBroadcast(io, roomId, "room-update", { clients });
  });

  socket.on("join-room", ({ roomId, username }) => {
    if (!roomId) return;
    socket.join(roomId);
    roomManager.addClient({ roomId, clientId: socket.id, username, socket });
    sendUnicast(socket, "set-client-id", { clientId: socket.id });

    const room = roomManager.rooms.get(roomId);
    const clients = roomManager.getClients(roomId);
    const elapsedTime = roomManager._getElapsedTime(room);
    const songDuration = room?.songDuration ?? 0;

    sendBroadcast(io, roomId, "room-update", {
      clients,
      songStatus: room?.songEnabled,
    });
    sendUnicast(socket, "playback-state", {
      isPlaying: room?.songEnabled ?? false,
      elapsedTime,
      songDuration,
    });

    if (room?.spatialEnabled) {
      roomManager.broadcastSpatialUpdate(roomId);
    }
  });

  socket.on("play-audio", ({ serverTimeToExecute, seekerPosition }) => {
    const roomId = getRoomId();
    if (!roomId) return;
    const enabled = roomManager.playAudio(roomId, true);
    const room = roomManager.rooms.get(roomId);
    const elapsedTime = roomManager._getElapsedTime(room);
    sendBroadcast(io, roomId, "play-audio", {
      serverTimeToExecute,
      songStatus: enabled,
      seekerPosition,
      elapsedTime,
      songDuration: room?.songDuration ?? 0,
    });
  });

  socket.on("pause-audio", ({ serverTimeToExecute }) => {
    const roomId = getRoomId();
    if (!roomId) return;
    const disabled = roomManager.pauseAudio(roomId, false);
    sendBroadcast(io, roomId, "pause-audio", {
      serverTimeToExecute,
      songStatus: disabled,
    });
  });

  socket.on("audio-source", ({ audioId, audioName, duration }) => {
    const roomId = getRoomId();
    if (!roomId) return;
    const room = roomManager.rooms.get(roomId);
    if (room && duration) {
      room.songDuration = duration;
    }
    sendBroadcast(io, roomId, "new-audio-source", {
      audioId,
      audioName,
      addedAt: Date.now(),
      addedBy: socket.id,
      duration,
    });
  });

  socket.on("reupload-audio", ({ audioId, audioName, duration }) => {
    socket.emit("audio-source", { audioId, audioName, duration });
  });

  socket.on("ntp-request", ({ t0 }) => {
    const t1 = Date.now();
    ntpClient.getNetworkTime("pool.ntp.org", 123, (err, ntpDate) => {
      const t2 = Date.now();
      const ntpT1 = err ? t1 : ntpDate.getTime();
      const ntpT2 = Date.now();
      socket.emit("ntp-response", { t0, t1: ntpT1, t2: ntpT2 });
    });
  });

  socket.on("resync-request", () => {
    const t0 = Date.now();
    ntpClient.getNetworkTime("pool.ntp.org", 123, (err, ntpDate) => {
      const t1 = err ? Date.now() : ntpDate.getTime();
      const t2 = Date.now();
      sendUnicast(socket, "ntp-response", { t0, t1, t2 });
    });
  });

  socket.on("move-client", ({ position }) => {
    const roomId = getRoomId();
    if (!roomId) return;
    roomManager.moveClient({ roomId, clientId: socket.id, position });
    const clients = roomManager.getClients(roomId);
    sendBroadcast(io, roomId, "room-update", { clients });
  });

  socket.on("toggle-spatial", ({ roomId, enable }) => {
    if (!roomId) return;
    roomManager.toggleSpatialAudio(roomId, enable);
  });

  socket.on("disconnect", () => {
    const roomId = getRoomId();
    if (roomId) {
      roomManager.removeClient({ roomId, clientId: socket.id });
      roomManager.clientToRoom.delete(socket.id);
      const clients = roomManager.getClients(roomId);
      sendBroadcast(io, roomId, "room-update", { clients });
    }
  });
}
