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

/* =====================
   GOOGLE SHEETS SETUP
===================== */
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const SHEET_NAME = process.env.SHEET_NAME || "DATA"; // ใช้แท็บ DATA

const auth = new google.auth.GoogleAuth({
  credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT || "{}"),
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});
const sheets = google.sheets({ version: "v4", auth });

function toMonthKey(date = new Date()) {
  // YYYY-MM
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

async function lookupAsset(assetCode) {
  // อ่านจากแท็บ ASSET: A:AssetCode B:AssetName C:Project
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `ASSET!A:C`,
  });

  const rows = res.data.values || [];
  // rows[0] คือ header
  for (let i = 1; i < rows.length; i++) {
    const [code, name, project] = rows[i];
    if ((code || "").trim() === assetCode) {
      return {
        assetName: name || "",
        project: project || "",
      };
    }
  }
  return { assetName: "", project: "" };
}

async function appendToDataRow(row) {
  // ลง A:K ของแท็บ DATA
  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_NAME}!A:K`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [row] },
  });
}

async function summary(month, assetCode = "") {
  // อ่าน DATA ทั้งช่วง A:K แล้วรวม
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_NAME}!A:K`,
  });

  const rows = res.data.values || [];
  let income = 0;
  let expense = 0;

  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const type = (r[1] || "").trim();     // B
    const amount = Number(r[2] || 0);     // C
    const rAsset = (r[4] || "").trim();   // E
    const rMonth = (r[9] || "").trim();   // J

    if (rMonth !== month) continue;
    if (assetCode && rAsset !== assetCode) continue;

    if (type === "รับ") income += amount;
    if (type === "จ่าย") expense += amount;
  }

  return { income, expense, net: income - expense };
}

/* =====================
   WEBHOOK
===================== */
app.post("/webhook", line.middleware(config), async (req, res) => {
  res.status(200).end(); // ตอบ LINE ทันที

  try {
    const events = req.body?.events || [];
    for (const event of events) {
      if (event.type !== "message" || event.message.type !== "text") continue;

      const userId = event.source?.userId || "";
      const raw = event.message.text || "";
      const text = raw.replace(/\u00A0/g, " ").replace(/\s+/g, " ").trim();

      // ✅ คำสั่งสรุป: "สรุป 2026-03 @H-GP59" หรือ "สรุป 2026-03"
      const sumMatch = text.match(/^สรุป\s+(\d{4}-\d{2})(?:\s+(@[A-Za-z0-9\-]+))?$/);
      if (sumMatch) {
        const month = sumMatch[1];
        const assetCode = (sumMatch[2] || "").trim();
        const s = await summary(month, assetCode);

        await client.replyMessage({
          replyToken: event.replyToken,
          messages: [{
            type: "text",
            text:
              `สรุปเดือน ${month}${assetCode ? ` (${assetCode})` : ""}\n` +
              `รายรับ: ${s.income.toLocaleString()} บาท\n` +
              `รายจ่าย: ${s.expense.toLocaleString()} บาท\n` +
              `คงเหลือ: ${s.net.toLocaleString()} บาท`,
          }],
        });
        continue;
      }

      // ✅ บันทึก: "รับ 5000 ค่าเช่า @H-GP59"
      // รูปแบบ: (รับ/จ่าย) (จำนวน) (รายละเอียด...) (@AssetCode optional)
      const m = text.match(/^(รับ|จ่าย)\s*(\d+(?:\.\d+)?)\s*(.+)$/i);
      if (!m) {
        await client.replyMessage({
          replyToken: event.replyToken,
          messages: [{
            type: "text",
            text:
              "รูปแบบบันทึก:\n" +
              "รับ 5000 ค่าเช่า @H-GP59\n" +
              "จ่าย 350 ค่าน้ำ @C-R22\n\n" +
              "สรุป:\nสรุป 2026-03\nสรุป 2026-03 @H-GP59",
          }],
        });
        continue;
      }

      const type = m[1];                 // รับ/จ่าย
      const amount = m[2];
      const detailAll = m[3];

      // ดึง @AssetCode จากท้ายข้อความ (ถ้ามี)
      const assetMatch = detailAll.match(/(.*)\s+(@[A-Za-z0-9\-]+)\s*$/);
      const detail = assetMatch ? assetMatch[1].trim() : detailAll.trim();
      const assetCode = assetMatch ? assetMatch[2].trim() : "";

      const now = new Date();
      const monthKey = toMonthKey(now);

      let assetName = "";
      let project = "";
      if (assetCode) {
        const found = await lookupAsset(assetCode);
        assetName = found.assetName;
        project = found.project;
      }

      // Category เดาง่าย ๆ จาก detail (ปรับทีหลังได้)
      let category = "";
      if (detail.includes("ค่าเช่า")) category = "ค่าเช่า";
      else if (detail.includes("ค่าน้ำ")) category = "ค่าน้ำ";
      else if (detail.includes("ค่าไฟ")) category = "ค่าไฟ";
      else if (detail.includes("ส่วนกลาง")) category = "ค่าส่วนกลาง";
      else if (detail.includes("ซ่อม")) category = "ซ่อมบำรุง";
      else category = "อื่นๆ";

      // RoomOrNo (ดึงเลขห้อง/บ้าน ถ้ามีคำว่า ห้องxxx)
      const roomMatch = detail.match(/ห้อง\s*([0-9\/\-]+)/);
      const roomOrNo = roomMatch ? roomMatch[1] : "";

      const row = [
        now.toLocaleString("th-TH"),      // A Timestamp
        type,                              // B Type
        Number(amount),                    // C Amount
        detail,                            // D Detail
        assetCode,                         // E AssetCode
        assetName,                         // F AssetName
        category,                          // G Category
        roomOrNo,                          // H RoomOrNo
        project,                           // I Project
        monthKey,                          // J Month
        userId,                            // K UserId
      ];

      await appendToDataRow(row);

      await client.replyMessage({
        replyToken: event.replyToken,
        messages: [{
          type: "text",
          text:
            `บันทึกแล้ว ✅\n` +
            `${type} ${Number(amount).toLocaleString()} บาท\n` +
            `${detail}\n` +
            `${assetCode ? `ทรัพย์: ${assetCode}${assetName ? ` (${assetName})` : ""}` : "ทรัพย์: (ยังไม่ระบุ)"}`,
        }],
      });
    }
  } catch (e) {
    console.error("WEBHOOK ERROR:", e);
  }
});

app.get("/", (req, res) => res.send("OK"));

const PORT = process.env.PORT || 8080;
app.listen(PORT, "0.0.0.0", () => console.log("Server running on", PORT));
