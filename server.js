const express = require("express");

const app = express();

/* =========================
   IMPORTANT: Railway + LINE
========================= */

// ให้ Express อ่าน body แบบ raw ด้วย (LINE ต้องการ)
app.use(express.json());

// หน้าเว็บหลัก (ใช้เช็คว่า server online)
app.get("/", (req, res) => {
  res.status(200).send("LINE BOT RUNNING ✅");
});

// route debug เช็ค webhook
app.get("/webhook", (req, res) => {
  res.status(200).send("WEBHOOK OK ✅");
});

// ✅ LINE Webhook endpoint
app.post("/webhook", (req, res) => {
  console.log("Webhook received:", JSON.stringify(req.body));

  // ต้องตอบ 200 ทันที ไม่งั้น Verify ไม่ผ่าน
  res.sendStatus(200);
});

/* =========================
   Railway PORT (สำคัญมาก)
========================= */

const PORT = process.env.PORT;

if (!PORT) {
  console.error("❌ PORT is not defined!");
  process.exit(1);
}

// ต้อง bind 0.0.0.0 สำหรับ Railway
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
