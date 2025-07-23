import express from "express";
import http from "node:http";
import cors from "cors";
import ntpClient from "ntp-client";
import setupSocket from "./config/socket.js";
import uploadRoutes from "./routes/upload.js";

const app = express();
const server = http.createServer(app);

app.use(cors());
app.use(express.json());
app.use("/api/v1", uploadRoutes);

app.get("/ntp", (req, res) => {
  ntpClient.getNetworkTime("pool.ntp.org", 123, (err, date) => {
    if (err) {
      return res.json({
        message: "SERVER TIME",
        time: new Date().toISOString(),
      });
    }
    res.json({
      message: "NTP TIME",
      time: date.toISOString(),
    });
  });
});

app.get("/", (req, res) => {
  res.json({
    message: "Welcome to the NTP Time API",
    endpoints: ["/ntp"],
  });
});

setupSocket(server);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
