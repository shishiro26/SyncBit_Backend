import express from "express";

const router = express.Router();

router.get("/ntp", (req, res) => {
  res.json({
    serverTime: Date.now(),
  });
});

export default router;
