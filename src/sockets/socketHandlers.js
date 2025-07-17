import ntpClient from "ntp-client";
import roomManager from "../core/RoomManager.js";
import { sendBroadcast, sendUnicast } from "../utils/broadcast.js";

const DEFAULT_SONG_DURATION = 180000; // 3 minutes

export function handleSocketEvents(io, socket) {
  const getRoomId = () => {
    const rooms = Array.from(socket.rooms).filter((r) => r !== socket.id);
    return rooms[0];
  };

  // -------- ROOM CREATION & JOINING --------

  socket.on("create-room", async ({ username }) => {
    const roomId = await roomManager.createRoom();
    socket.join(roomId);

    await roomManager.addClient({
      roomId,
      clientId: socket.id,
      username,
      socket,
    });

    sendUnicast(socket, "room-created", { roomId });
    sendUnicast(socket, "set-client-id", { clientId: socket.id });

    const clients = await roomManager.getClients(roomId);
    sendBroadcast(io, roomId, "room-update", { clients });
  });

  socket.on("join-room", async ({ roomId, username }) => {
    if (!roomId) return;
    console.log(`Client ${socket.id} joining room ${roomId}`);
    socket.join(roomId);
    await roomManager.addClient({
      roomId,
      clientId: socket.id,
      username,
      socket,
    });

    sendUnicast(socket, "set-client-id", { clientId: socket.id });

    const clients = await roomManager.getClients(roomId);
    const { songEnabled, elapsedTime, songDuration } =
      await roomManager.getRoomAudioState(roomId);
    const room = await roomManager.getRoom(roomId);

    sendBroadcast(io, roomId, "room-update", {
      clients,
      songStatus: songEnabled,
    });

    sendUnicast(socket, "playback-state", {
      isPlaying: songEnabled,
      elapsedTime,
      songDuration,
    });

    if (room?.spatialEnabled) {
      await roomManager.broadcastSpatialUpdate(room);
    }
  });

  socket.on("leave-room", async ({ roomId }) => {
    if (!roomId) return;

    await roomManager.removeClient({ roomId, clientId: socket.id });
    socket.leave(roomId);

    const clients = await roomManager.getClients(roomId);
    sendBroadcast(io, roomId, "room-update", { clients });
  });

  socket.on("disconnect", async () => {
    const roomId = getRoomId();
    if (!roomId) return;

    await roomManager.removeClient({ roomId, clientId: socket.id });

    const clients = await roomManager.getClients(roomId);
    sendBroadcast(io, roomId, "room-update", { clients });
  });

  // -------- AUDIO CONTROL --------

  socket.on("audio-source", async ({ audioId, audioName, duration }) => {
    const roomId = getRoomId();
    if (!roomId) return;

    const room = await roomManager.getRoom(roomId);
    if (room && duration) {
      room.songDuration = duration;
      await roomManager.saveRoom(roomId, room);
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

  socket.on(
    "play-audio",
    async ({ serverTimeToExecute, seekerPosition, duration }) => {
      const roomId = getRoomId();
      if (!roomId) return;

      const room = await roomManager.getRoom(roomId);
      const fallbackDuration =
        typeof duration === "number" && duration > 0
          ? duration
          : room?.songDuration || DEFAULT_SONG_DURATION;

      const enabled = await roomManager.playAudio(
        roomId,
        true,
        fallbackDuration
      );
      const { elapsedTime, songDuration } = await roomManager.getRoomAudioState(
        roomId
      );

      sendBroadcast(io, roomId, "play-audio", {
        serverTimeToExecute,
        songStatus: enabled,
        seekerPosition,
        elapsedTime,
        songDuration,
      });
    }
  );

  socket.on("pause-audio", async ({ serverTimeToExecute }) => {
    const roomId = getRoomId();
    if (!roomId) return;

    const disabled = await roomManager.pauseAudio(roomId);

    sendBroadcast(io, roomId, "pause-audio", {
      serverTimeToExecute,
      songStatus: disabled,
    });
  });

  socket.on("move-client", async ({ position }) => {
    const roomId = getRoomId();
    if (!roomId) return;

    await roomManager.moveClient({ roomId, clientId: socket.id, position });
    const clients = await roomManager.getClients(roomId);

    sendBroadcast(io, roomId, "room-update", { clients });
  });

  socket.on("toggle-spatial", async ({ roomId, enable }) => {
    if (!roomId) return;

    await roomManager.toggleSpatialAudio(roomId, enable);
  });

  // -------- NTP TIME SYNC --------

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
}
