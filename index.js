app.get("/", (req, res) => res.status(200).send("OK"));
const express = require("express");
const line = require("@line/bot-sdk");

const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET,
};

const app = express();

app.post("/webhook", line.middleware(config), (req, res) => {
  Promise.all(req.body.events.map(handleEvent))
    .then(() => res.json({ success: true }))
    .catch((err) => res.status(500).end());
});

const client = new line.Client(config);

function handleEvent(event) {
  if (event.type !== "message") return Promise.resolve(null);

  return client.replyMessage(event.replyToken, {
    type: "text",
    text: "คุณพิมพ์ว่า: " + event.message.text,
  });
}

app.listen(process.env.PORT || 3000);
