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

if (!SPREADSHEET_ID) {
  console.error("❌ Missing env: SPREADSHEET_ID");
}

const auth = new google.auth.GoogleAuth({
  credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT || "{}"),
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});
const sheets = google.sheets({ version: "v4", auth });

function toMonthKey(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

function normalizeText(s = "") {
  return String(s)
    .replace(/\u00A0/g, " ") 
    .replace(/\s+/g, " ")
    .trim();
}

/* =====================
   CACHE
===================== */
let categoryCache = { loadedAt: 0, list: [] };
let assetCache = { loadedAt: 0, map: new Map() };

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

    const keywords = String(keywordRaw)
      .split(",")
      .map((k) => normalizeText(k))
      .filter(Boolean);

    for (const k of keywords) {
      list.push({ keyword: k, category });
    }
  }

  list.sort((a, b) => b.keyword.length - a.keyword.length);
  categoryCache = { loadedAt: now, list };
}

async function loadAssetsIfNeeded() {
  const now = Date.now();
  if (now - assetCache.loadedAt < CACHE_TTL_MS && assetCache.map.size) return;

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${ASSET_SHEET}!A:H`,
  });

  const rows = res.data.values || [];
  const map = new Map();

  for (let i = 1; i < rows.length; i++) {
    const [
      assetCode,
      assetType,
      projectName,
      unitNo,
      fullName,
      owner,
      active,
      note,
    ] = rows[i];

    const code = normalizeText(assetCode);
    if (!code) continue;

    map.set(code, {
      assetCode: code,
      assetType: normalizeText(assetType),
      projectName: normalizeText(projectName),
      unitNo: normalizeText(unitNo),
      fullName: normalizeText(fullName),
      owner: normalizeText(owner),
      active: String(active).toUpperCase() === "TRUE",
      note: normalizeText(note),
    });
  }

  assetCache = { loadedAt: now, map };
}

async function lookupAsset(assetCode) {
  await loadAssetsIfNeeded();
  return assetCache.map.get(assetCode) || null;
}

async function detectCategory(detail) {
  await loadCategoryIfNeeded();
  const d = detail.toLowerCase();

  for (const item of categoryCache.list) {
    if (d.includes(item.keyword.toLowerCase())) {
      return item.category;
    }
  }
  return "อื่นๆ";
}

function extractRoom(detail) {
  const m = detail.match(/ห้อง\s*([0-9\/\-]+)/);
  return m ? m[1] : "";
}

async function appendToDataRow(row) {
  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_NAME}!A:K`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [row] },
  });
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

      const userId = event.source?.userId || "";
      const text = normalizeText(event.message.text || "");

      const m = text.match(/^(รับ|จ่าย)\s*(\d+(?:\.\d+)?)\s*(.+)$/i);

      if (!m) {
        await client.replyMessage({
          replyToken: event.replyToken,
          messages: [
            {
              type: "text",
              text:
                "รูปแบบบันทึก:\n" +
                "รับ 5000 ค่าเช่า @C1\n" +
                "จ่าย 350 ค่าน้ำ @C1\n\n" +
                "หมายเหตุ: ใส่ @AssetCode ต่อท้ายเพื่อให้รู้ว่าเป็นทรัพย์ไหน",
            },
          ],
        });
        continue;
      }

      const type = m[1];
      const amount = Number(m[2]);
      const detailAll = normalizeText(m[3]);

      const assetMatch = detailAll.match(/(.*)\s+(@[A-Za-z0-9\-]+)\s*$/);
      const detail = assetMatch ? normalizeText(assetMatch[1]) : detailAll;
      const assetCode = assetMatch ? normalizeText(assetMatch[2]) : "";

      const now = new Date();
      const monthKey = toMonthKey(now);

      let assetName = "";
      let project = "";
      let owner = "";
      let assetType = ""; // เพิ่มตัวแปรสำหรับ AssetType
      let active = true;

      if (assetCode) {
        const asset = await lookupAsset(assetCode);
        if (asset) {
          assetName = asset.fullName || "";
          project = asset.projectName || "";
          owner = asset.owner || "";
          assetType = asset.assetType || ""; // ดึงค่าจากคอลัมน์ B ในแท็บ ASSET
          active = asset.active !== false;
        }
      }

      if (assetCode && !active) {
        await client.replyMessage({
          replyToken: event.replyToken,
          messages: [
            {
              type: "text",
              text: `ทรัพย์ ${assetCode} ถูกปิดใช้งาน (Active=FALSE) ❌\nกรุณาเปิดในแท็บ ASSET ก่อน แล้วลองใหม่`,
            },
          ],
        });
        continue;
      }

      const category = await detectCategory(detail);
      const room = extractRoom(detail);

      const row = [
        now.toLocaleString("th-TH"), 
        type,                        
        amount,                      
        detail,                      
        assetCode,                   
        assetName,                   
        category,                    
        room,                        
        project,                     
        monthKey,                    
        userId,                      
      ];

      await appendToDataRow(row);

      // --- ปรับปรุงส่วนการตอบกลับตามที่คุณต้องการ ---
      let reply =
        `บันทึกแล้ว ✅\n` +
        `${type} ${amount.toLocaleString()} บาท\n` +
        `${category}\n` +
        (assetCode ? `ทรัพย์: ${assetCode}${assetName ? ` (${assetName})` : ""}\n` : "ทรัพย์: (ยังไม่ระบุ)\n");

      if (owner) reply += `Owner: ${owner}\n`;
      if (assetType) reply += `AssetType: ${assetType}`; // เปลี่ยนจาก Note เป็น AssetType

      await client.replyMessage({
        replyToken: event.replyToken,
        messages: [{ type: "text", text: reply.trim() }],
      });
    }
  } catch (e) {
    console.error("WEBHOOK ERROR:", e);
  }
});

app.get("/", (req, res) => res.send("OK ✅"));

const PORT = process.env.PORT || 8080;
app.listen(PORT, "0.0.0.0", () => console.log("Server running on", PORT));
