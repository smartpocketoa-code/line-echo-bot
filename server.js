const express = require("express");
const line = require("@line/bot-sdk");
const { google } = require("googleapis");

const app = express();
app.use(express.json()); // ✅ กัน req.body ว่าง

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
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;

const auth = new google.auth.GoogleAuth({
  credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT || "{}"),
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});

const sheets = google.sheets({ version: "v4", auth });

async function saveToSheet(type, amount, note) {
  if (!SPREADSHEET_ID) throw new Error("Missing SPREADSHEET_ID");

  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: "Sheet1!A:D",
    valueInputOption: "USER_ENTERED",
    requestBody: {
      values: [[new Date().toLocaleString("th-TH"), type, Number(amount), note]],
    },
  });
}

/* =====================
   WEBHOOK
===================== */
app.post("/webhook", line.middleware(config), async (req, res) => {
  res.sendStatus(200);

  try {
    const events = req.body?.events || [];
    if (!events.length) return;

    for (const event of events) {
      if (event.type !== "message" || event.message.type !== "text") continue;

      // ✅ Normalize ช่องว่างแปลกของ LINE + รวม space หลายตัว
      const text = (event.message.text || "")
        .replace(/\u00A0/g, " ") // non-breaking space
        .replace(/\s+/g, " ")
        .trim();

      // ✅ ยืดหยุ่น: "รับ5000 ค่าเช่า" / "รับ 5000  ค่าเช่า" ได้หมด
      const match = text.match(/^(รับ|จ่าย)\s*(\d+(?:\.\d+)?)\s*(.+)$/i);

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
              text: `บันทึกแล้ว ✅\n${type} ${amount} บาท\n${note}`,
            },
          ],
        });
      } else {
        await client.replyMessage({
          replyToken: event.replyToken,
          messages: [
            {
              type: "text",
              text: "รูปแบบบันทึก:\nรับ 5000 ค่าเช่า ห้อง101\nจ่าย 120 ค่าน้ำ",
            },
          ],
        });
      }
    }
  } catch (err) {
    console.error("SHEET/REPLY ERROR:", err);
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
