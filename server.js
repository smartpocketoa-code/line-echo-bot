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

function getThaiTimestamp() {
  const now = new Date();
  const date = now.toLocaleDateString("th-TH", { day: 'numeric', month: 'numeric', year: 'numeric' });
  const time = now.toLocaleTimeString("th-TH", { hour12: false });
  return `${date} ${time}`;
}

// --- เพิ่มระบบ Cache และค้นหาหมวดหมู่ ---
let categoryCache = { loadedAt: 0, list: [] };
const CACHE_TTL_MS = 60 * 1000;

async function loadCategoryIfNeeded() {
  const now = Date.now();
  if (now - categoryCache.loadedAt < CACHE_TTL_MS && categoryCache.list.length) return;

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${CATEGORY_SHEET}!A:B`,
  });

  const rows = res.data.values || [];
  const list = [];
  for (let i = 1; i < rows.length; i++) {
    const [keywordRaw, categoryRaw] = rows[i];
    const category = normalizeText(categoryRaw);
    if (!keywordRaw || !category) continue;
    const keywords = String(keywordRaw).split(",").map(k => normalizeText(k)).filter(Boolean);
    for (const k of keywords) { list.push({ keyword: k, category }); }
  }
  list.sort((a, b) => b.keyword.length - a.keyword.length);
  categoryCache = { loadedAt: now, list };
}

async function detectCategory(detail) {
  await loadCategoryIfNeeded();
  const d = detail.toLowerCase();
  for (const item of categoryCache.list) {
    if (d.includes(item.keyword.toLowerCase())) return item.category;
  }
  return "อื่นๆ";
}

function extractRoom(detail) {
  // ดึงเลขหลังคำว่า "ห้อง" หรือรูปแบบตัวเลขที่มีทับ เช่น 123/45
  const m = detail.match(/ห้อง\s*([0-9\/\-]+)/) || detail.match(/([0-9]+\/[0-9]+)/);
  return m ? m[1] : "";
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
      assetType: normalizeText(type),
      projectName: normalizeText(project),
      fullName: normalizeText(name),
      owner: normalizeText(owner),
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

      // --- ประมวลผล Category และ Room ---
      const category = await detectCategory(detail);
      const room = extractRoom(detail);

      const row = [
        timestamp,          // A: Timestamp
        type,               // B: Type
        amount,             // C: Amount
        detail,             // D: Detail
        assetCode,          // E: AssetCode
        asset.fullName || "",// F: AssetName
        category,           // G: Category (ดึงอัตโนมัติจากแท็บ CATEGORY)
        room,               // H: Room (ดึงจากรายละเอียดข้อความ)
        asset.projectName || "", // I: Project
        new Date().getFullYear() + "-" + String(new Date().getMonth() + 1).padStart(2, "0"), // J: Month
        event.source.userId,// K: User
        "",                 // L: PaymentMethod
        "",                 // M: Ref
        asset.owner || "",  // N: Owner
        asset.assetType || "" // O: AssetNote
      ];

      await sheets.spreadsheets.values.append({
        spreadsheetId: SPREADSHEET_ID,
        range: `${SHEET_NAME}!A:O`,
        valueInputOption: "USER_ENTERED",
        requestBody: { values: [row] },
      });

      let reply = `บันทึกแล้ว ✅\n`;
      reply += `${type} ${amount.toLocaleString()} บาท\n`;
      reply += `รายการ: ${category}\n`; // แสดงหมวดหมู่ที่ระบบตรวจเจอ
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
