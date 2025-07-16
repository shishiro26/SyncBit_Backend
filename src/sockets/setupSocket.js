import { Server } from "socket.io";
import { handleSocketEvents } from "./socketHandlers.js";

export function setupSocket(server) {
  const io = new Server(server, {
    cors: {
      origin: "*",
      methods: ["GET", "POST"],
    },
  });

  io.on("connection", (socket) => {
    console.log("New client connected:", socket.id);
    handleSocketEvents(io, socket);
  });

  return io;
}
