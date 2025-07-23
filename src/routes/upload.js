import express from "express";

const router = express.Router();

router.post("/upload", (req, res) => {
  res.json({
    message: "File uploaded successfully",
    url: "https://res.cloudinary.com/dor4hhdzh/video/upload/v1753204341/spinning-head-271171_qoxlyz.mp3",
  });
});

export default router;
