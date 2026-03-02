const express = require("express");
const line = require("@line/bot-sdk");
const { google } = require("googleapis");

const app = express();

const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

const client = new line.messagingApi.MessagingApiClient({
  channelAccessToken: config.channelAccessToken,
});

/* Google (ค่อยใช้ตอน message จริง) */
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;

const auth = new google.auth.GoogleAuth({
  credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT || "{}"),
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});
const sheets = google.sheets({ version: "v4", auth });

async function saveToSheet(type, amount, note) {
  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: "Sheet1!A:D",
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [[new Date().toLocaleString("th-TH"), type, Number(amount), note]] },
  });
}

/* webhook */
app.post("/webhook", line.middleware(config), async (req, res) => {
  res.status(200).end(); // ตอบ LINE ทันที

  try {
    const events = req.body?.events || [];
    for (const event of events) {
      if (event.type !== "message" || event.message.type !== "text") continue;

      const text = (event.message.text || "").replace(/\u00A0/g, " ").replace(/\s+/g, " ").trim();
      const match = text.match(/^(รับ|จ่าย)\s*(\d+(?:\.\d+)?)\s*(.+)$/);

      if (!match) continue;

      await saveToSheet(match[1], match[2], match[3]);

      await client.replyMessage({
        replyToken: event.replyToken,
        messages: [{ type: "text", text: `บันทึกแล้ว ✅\n${match[1]} ${match[2]} บาท\n${match[3]}` }],
      });
    }
  } catch (e) {
    console.error("WEBHOOK ERROR:", e);
  }
});

app.get("/", (req, res) => res.send("OK"));

const PORT = process.env.PORT || 8080;
app.listen(PORT, "0.0.0.0", () => console.log("Server running on", PORT));
