const express = require("express");
const line = require("@line/bot-sdk");
const { google } = require("googleapis");

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
   GOOGLE SHEET
===================== */

const auth = new google.auth.GoogleAuth({
  credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT),
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});

const sheets = google.sheets({ version: "v4", auth });

const SPREADSHEET_ID = process.env.SPREADSHEET_ID;

async function saveToSheet(type, amount, note) {
  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: "Sheet1!A:D",
    valueInputOption: "USER_ENTERED",
    requestBody: {
      values: [[new Date().toLocaleString(), type, amount, note]],
    },
  });
}

/* =====================
   WEBHOOK
===================== */

app.post("/webhook", line.middleware(config), async (req, res) => {
  res.sendStatus(200);

  try {
    for (const event of req.body.events) {
      if (event.type !== "message" || event.message.type !== "text")
        continue;

      const text = event.message.text;

      const match = text.match(/^(รับ|จ่าย)\s+(\d+(?:\.\d+)?)\s+(.+)$/);

      if (match) {
        const type = match[1];
        const amount = match[2];
        const note = match[3];

        await saveToSheet(type, amount, note);

        await client.replyMessage({
          replyToken: event.replyToken,
          messages: [
            {
              type: "text",
              text: `บันทึกแล้ว ✅ ${type} ${amount} บาท ${note}`,
            },
          ],
        });
      } else {
        await client.replyMessage({
          replyToken: event.replyToken,
          messages: [
            {
              type: "text",
              text: "รูปแบบ: รับ 5000 ค่าเช่า ห้อง101",
            },
          ],
        });
      }
    }
  } catch (err) {
    console.error(err);
  }
});

/* =====================
   HEALTH CHECK
===================== */

app.get("/", (req, res) => {
  res.send("LINE BOT + SHEET READY ✅");
});

const PORT = process.env.PORT || 8080;

app.listen(PORT, "0.0.0.0", () => {
  console.log("Server running on port " + PORT);
});
