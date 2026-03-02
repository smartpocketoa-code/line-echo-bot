const express = require("express");

const app = express();
app.use(express.json());

// หน้าเว็บหลัก
app.get("/", (req, res) => {
  res.send("LINE BOT RUNNING");
});

// ✅ ตัวเช็กว่าเส้นทาง /webhook มีจริง (สำหรับ debug)
app.get("/webhook", (req, res) => {
  res.send("WEBHOOK OK");
});

// ✅ webhook สำหรับ LINE
app.post("/webhook", (req, res) => {
  console.log("Webhook received:", req.body);
  res.sendStatus(200);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Server started on port " + PORT);
});
