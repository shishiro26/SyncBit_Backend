import { Server } from "socket.io";
import handleSocketEvents from "../controllers/socketHandlers.js";

const setupSocket = (server) => {
  const io = new Server(server, {
    cors: {
      origin: "*",
      methods: ["GET", "POST"],
    },
  });

  io.on("connection", (socket) => {
    console.log(`New Connection [${socket.id}]`);

    handleSocketEvents(io, socket);

    socket.on("disconnect", () => {
      console.log(`Socket Disconnected [${socket.id}]`);
    });
  });
};

export default setupSocket;
