const express = require("express");
const line = require("@line/bot-sdk");

const app = express();

/* =====================
   LINE CONFIG
===================== */

const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

const client = new line.messagingApi.MessagingApiClient({
  channelAccessToken: config.channelAccessToken,
});

/* =====================
   WEBHOOK
===================== */

app.post("/webhook", line.middleware(config), async (req, res) => {
  res.sendStatus(200); // ตอบ LINE ทันที

  try {
    const events = req.body.events;

    for (const event of events) {
      if (event.type === "message" && event.message.type === "text") {
        await client.replyMessage({
          replyToken: event.replyToken,
          messages: [
            {
              type: "text",
              text: `คุณพิมพ์ว่า: ${event.message.text}`,
            },
          ],
        });
      }
    }
  } catch (err) {
    console.error("Reply error:", err);
  }
});

/* =====================
   HEALTH CHECK
===================== */

app.get("/", (req, res) => {
  res.send("LINE BOT RUNNING ✅");
});

const PORT = process.env.PORT;

app.listen(PORT, "0.0.0.0", () => {
  console.log("Server running on port " + PORT);
});
