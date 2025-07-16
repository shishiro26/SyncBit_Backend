import express from "express";
import http from "http";
import cors from "cors";
import { setupSocket } from "./sockets/setupSocket.js";

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
setupSocket(server);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
