const express = require("express");
const line = require("@line/bot-sdk");
const { google } = require("googleapis");

const app = express();

/* =====================
   ENV CHECK (ช่วย debug)
===================== */
const must = (k) => {
  if (!process.env[k]) console.error(`❌ Missing env: ${k}`);
};
must("LINE_CHANNEL_ACCESS_TOKEN");
must("LINE_CHANNEL_SECRET");
must("GOOGLE_SERVICE_ACCOUNT");
must("SPREADSHEET_ID");

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
   GOOGLE SHEETS SETUP
===================== */
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const DATA_SHEET = process.env.SHEET_NAME || "DATA"; // ใช้แท็บ DATA
const ASSET_SHEET = "ASSET"; // ใช้แท็บ ASSET

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

/**
 * ASSET ตามรูปของคุณ:
 * A AssetCode | B AssetType | C ProjectName | D UnitNo | E FullName | F Owner | ...
 */
async function lookupAsset(assetCode) {
  if (!assetCode) return { assetName: "", project: "", unitNo: "", assetType: "" };

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `'${ASSET_SHEET}'!A:E`,
  });

  const rows = res.data.values || [];
  for (let i = 1; i < rows.length; i++) {
    const [code, assetType, projectName, unitNo, fullName] = rows[i] || [];
    if ((code || "").trim() === assetCode.trim()) {
      return {
        assetName: (fullName || "").trim(),
        project: (projectName || "").trim(),
        unitNo: (unitNo || "").trim(),
        assetType: (assetType || "").trim(),
      };
    }
  }
  return { assetName: "", project: "", unitNo: "", assetType: "" };
}

/**
 * DATA A:K ตามที่ใช้ในโค้ดนี้
 * A Timestamp
 * B Type (รับ/จ่าย)
 * C Amount
 * D Detail
 * E AssetCode
 * F AssetName
 * G Category
 * H RoomOrNo
 * I Project
 * J Month
 * K UserId
 */
async function appendToDataRow(row) {
  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: `'${DATA_SHEET}'!A:K`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [row] },
  });
}

function guessCategory(detail) {
  if (detail.includes("ค่าเช่า")) return "ค่าเช่า";
  if (detail.includes("ค่าน้ำ")) return "ค่าน้ำ";
  if (detail.includes("ค่าไฟ")) return "ค่าไฟ";
  if (detail.includes("ส่วนกลาง")) return "ค่าส่วนกลาง";
  if (detail.includes("ซ่อม")) return "ซ่อมบำรุง";
  return "อื่นๆ";
}

function extractRoomOrNo(detail) {
  // ดึง "ห้อง101" หรือ "ห้อง 75/5"
  const roomMatch = detail.match(/ห้อง\s*([0-9\/\-]+)/);
  return roomMatch ? roomMatch[1] : "";
}

async function summary(month, assetCode = "") {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `'${DATA_SHEET}'!A:K`,
  });

  const rows = res.data.values || [];
  let income = 0;
  let expense = 0;

  for (let i = 1; i < rows.length; i++) {
    const r = rows[i] || [];
    const type = (r[1] || "").trim();       // B
    const amount = Number(r[2] || 0);       // C
    const rAssetCode = (r[4] || "").trim(); // E
    const rMonth = (r[9] || "").trim();     // J

    if (!rMonth) continue;
    if (rMonth !== month) continue;
    if (assetCode && rAssetCode !== assetCode) continue;

    if (type === "รับ") income += amount;
    if (type === "จ่าย") expense += amount;
  }

  return { income, expense, net: income - expense };
}

/* =====================
   WEBHOOK
===================== */
app.post("/webhook", line.middleware(config), async (req, res) => {
  // ตอบ LINE ทันที (สำคัญ)
  res.status(200).end();

  try {
    const events = req.body?.events || [];

    for (const event of events) {
      if (event.type !== "message" || event.message.type !== "text") continue;

      const userId = event.source?.userId || "";
      const raw = event.message.text || "";

      // Normalize ช่องว่างแปลกของ LINE
      const text = raw
        .replace(/\u00A0/g, " ")
        .replace(/\s+/g, " ")
        .trim();

      // ✅ สรุป: "สรุป 2026-03" หรือ "สรุป 2026-03 @C1"
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

      // ✅ บันทึก: "รับ 5000 ค่าเช่า @H1" / "จ่าย 120 ค่าน้ำ @C1"
      const m = text.match(/^(รับ|จ่าย)\s*(\d+(?:\.\d+)?)\s*(.+)$/i);
      if (!m) {
        await client.replyMessage({
          replyToken: event.replyToken,
          messages: [{
            type: "text",
            text:
              "รูปแบบบันทึก:\n" +
              "รับ 5000 ค่าเช่า @H1\n" +
              "จ่าย 120 ค่าน้ำ @C1\n\n" +
              "สรุป:\nสรุป 2026-03\nสรุป 2026-03 @H1",
          }],
        });
        continue;
      }

      const type = m[1];          // รับ/จ่าย
      const amountStr = m[2];
      const detailAll = m[3];

      // ดึง @AssetCode จากท้ายข้อความ (ถ้ามี)
      const assetMatch = detailAll.match(/(.*)\s+(@[A-Za-z0-9\-]+)\s*$/);
      const detail = assetMatch ? assetMatch[1].trim() : detailAll.trim();
      const assetCode = assetMatch ? assetMatch[2].trim() : "";

      const now = new Date();
      const monthKey = toMonthKey(now);

      // lookup จาก ASSET
      let assetName = "";
      let project = "";
      let unitNo = "";
      let assetType = "";

      if (assetCode) {
        const found = await lookupAsset(assetCode);
        assetName = found.assetName;
        project = found.project;
        unitNo = found.unitNo;
        assetType = found.assetType;
      }

      const category = guessCategory(detail);
      const roomOrNo = extractRoomOrNo(detail) || unitNo; // ถ้ามี unit ใน ASSET ก็เติมให้

      const amount = Number(amountStr);

      const row = [
        now.toLocaleString("th-TH"), // A Timestamp
        type,                        // B Type
        amount,                      // C Amount
        detail,                      // D Detail
        assetCode,                   // E AssetCode
        assetName,                   // F AssetName (FullName)
        category,                    // G Category
        roomOrNo,                    // H RoomOrNo
        project,                     // I Project
        monthKey,                    // J Month
        userId,                      // K UserId
      ];

      await appendToDataRow(row);

      await client.replyMessage({
        replyToken: event.replyToken,
        messages: [{
          type: "text",
          text:
            `บันทึกแล้ว ✅\n` +
            `${type} ${amount.toLocaleString()} บาท\n` +
            `${detail}\n` +
            `${assetCode ? `ทรัพย์: ${assetCode}${assetName ? ` (${assetName})` : ""}` : "ทรัพย์: (ยังไม่ระบุ)"}` +
            `${assetType ? `\nประเภท: ${assetType}` : ""}` +
            `${project ? `\nโครงการ: ${project}` : ""}`,
        }],
      });
    }
  } catch (e) {
    console.error("WEBHOOK ERROR:", e);
  }
});

/* =====================
   HEALTH CHECK
===================== */
app.get("/", (req, res) => res.send("OK"));

const PORT = process.env.PORT || 8080;
app.listen(PORT, "0.0.0.0", () => console.log("Server running on", PORT));
