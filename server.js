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
   GOOGLE SHEETS SETUP
===================== */
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const SHEET_NAME = process.env.SHEET_NAME || "DATA"; 
const ASSET_SHEET = "ASSET";
const CATEGORY_SHEET = "CATEGORY";

const auth = new google.auth.GoogleAuth({
  credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT || "{}"),
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});
const sheets = google.sheets({ version: "v4", auth });

/* =====================
   HELPER FUNCTIONS
===================== */
function normalizeText(s = "") {
  return String(s).replace(/\u00A0/g, " ").replace(/\s+/g, " ").trim();
}

// ฟังก์ชันจัดฟอร์แมตวันที่แบบ ว/ด/ปปปป นน:นน:นน
function getThaiTimestamp() {
  const now = new Date();
  const date = now.toLocaleDateString("th-TH", { day: 'numeric', month: 'numeric', year: 'numeric' });
  const time = now.toLocaleTimeString("th-TH", { hour12: false });
  return `${date} ${time}`;
}

async function loadAssetsIfNeeded() {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${ASSET_SHEET}!A:H`,
  });
  const rows = res.data.values || [];
  const map = new Map();
  for (let i = 1; i < rows.length; i++) {
    const [code, type, project, unit, name, owner, active] = rows[i];
    if (!code) continue;
    map.set(normalizeText(code), {
      assetCode: normalizeText(code),
      assetType: normalizeText(type), // คอลัมน์ B: ประเภททรัพย์สิน
      projectName: normalizeText(project),
      fullName: normalizeText(name),
      owner: normalizeText(owner),    // คอลัมน์ F: ผู้ชำระเงิน
      active: String(active).toUpperCase() === "TRUE",
    });
  }
  return map;
}

/* =====================
   WEBHOOK
===================== */
app.post("/webhook", line.middleware(config), async (req, res) => {
  res.status(200).end();
  try {
    const events = req.body?.events || [];
    for (const event of events) {
      if (event.type !== "message" || event.message.type !== "text") continue;

      const text = normalizeText(event.message.text);
      const m = text.match(/^(รับ|จ่าย)\s*(\d+(?:\.\d+)?)\s*(.+)$/i);

      if (!m) continue;

      const [ , type, amountStr, detailAll] = m;
      const amount = Number(amountStr);
      const assetMatch = detailAll.match(/(.*)\s+(@[A-Za-z0-9\-]+)\s*$/);
      const detail = assetMatch ? normalizeText(assetMatch[1]) : detailAll;
      const assetCode = assetMatch ? normalizeText(assetMatch[2]) : "";

      const timestamp = getThaiTimestamp();
      const assetMap = await loadAssetsIfNeeded();
      const asset = assetMap.get(assetCode) || {};

      // เตรียมข้อมูล 15 คอลัมน์ (A-O) ตามโครงสร้างรูปภาพ
      const row = [
        timestamp,          // A: Timestamp (ฟอร์แมตวันที่แบบไทย)
        type,               // B: Type
        amount,             // C: Amount (รองรับตัวเลข/ทศนิยม)
        detail,             // D: Detail
        assetCode,          // E: AssetCode
        asset.fullName || "",// F: AssetName
        "",                 // G: Category (ดึงจากแท็บ CATEGORY ได้ถ้าต้องการ)
        "",                 // H: Room (ฟังก์ชัน extractRoom)
        asset.projectName || "", // I: Project
        new Date().getFullYear() + "-" + String(new Date().getMonth() + 1).padStart(2, "0"), // J: Month
        event.source.userId,// K: User
        "",                 // L: PaymentMethod
        "",                 // M: Ref
        asset.owner || "",  // N: Owner (ผู้ชำระเงิน)
        asset.assetType || "" // O: AssetNote (ประเภททรัพย์สิน)
      ];

      await sheets.spreadsheets.values.append({
        spreadsheetId: SPREADSHEET_ID,
        range: `${SHEET_NAME}!A:O`,
        valueInputOption: "USER_ENTERED",
        requestBody: { values: [row] },
      });

      // --- สร้างข้อความตอบกลับตามเงื่อนไขใหม่ ---
      let reply = `บันทึกแล้ว ✅\n`;
      reply += `${type} ${amount.toLocaleString()} บาท\n`;
      reply += `รายการ: ${detail}\n`;
      if (assetCode) {
        reply += `รหัสทรัพย์: ${assetCode} (${asset.fullName || ""})\n`;
        reply += `ผู้ชำระเงิน: ${asset.owner || ""}\n`;
        reply += `ประเภททรัพย์สิน: ${asset.assetType || ""}\n`;
      } else {
        reply += `รหัสทรัพย์: (ยังไม่ระบุ)\n`;
      }
      reply += `รับชำระเมื่อ: ${timestamp}`;

      await client.replyMessage({
        replyToken: event.replyToken,
        messages: [{ type: "text", text: reply.trim() }],
      });
    }
  } catch (e) { console.error("WEBHOOK ERROR:", e); }
});

app.get("/", (req, res) => res.send("OK ✅"));
const PORT = process.env.PORT || 8080;
app.listen(PORT, "0.0.0.0", () => console.log("Server running on", PORT));
