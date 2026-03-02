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

// ระบบ Cache Asset & Category (เหมือนเดิม)
let categoryCache = { loadedAt: 0, list: [] };
async function loadCategoryIfNeeded() {
  const now = Date.now();
  if (now - categoryCache.loadedAt < 60000 && categoryCache.list.length) return;
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${CATEGORY_SHEET}!A:B` });
  const rows = res.data.values || [];
  const list = [];
  for (let i = 1; i < rows.length; i++) {
    const [kw, cat] = rows[i];
    if (kw && cat) list.push({ keyword: normalizeText(kw), category: normalizeText(cat) });
  }
  categoryCache = { loadedAt: now, list };
}

async function detectCategory(detail) {
  await loadCategoryIfNeeded();
  for (const item of categoryCache.list) {
    if (detail.toLowerCase().includes(item.keyword.toLowerCase())) return item.category;
  }
  return "อื่นๆ";
}

function extractRoom(detail) {
  const m = detail.match(/ห้อง\s*([0-9\/\-]+)/) || detail.match(/([0-9]+\/[0-9]+)/);
  return m ? m[1] : "";
}

async function loadAssetsIfNeeded() {
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${ASSET_SHEET}!A:H` });
  const rows = res.data.values || [];
  const map = new Map();
  for (let i = 1; i < rows.length; i++) {
    const [code, type, project, unit, name, owner, active] = rows[i];
    if (code) map.set(normalizeText(code), { assetCode: code, assetType: type, fullName: name, owner: owner, projectName: project });
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

      // --- 1. ตรวจสอบว่าเป็นคำสั่ง "สรุป" หรือไม่ ---
      const summaryMatch = text.match(/^สรุป\s+(\d{4}-\d{2})(?:\s+(@[A-Za-z0-9\-]+))?$/i);
      if (summaryMatch) {
        const targetMonth = summaryMatch[1]; // เช่น 2026-03
        const targetAsset = summaryMatch[2] ? normalizeText(summaryMatch[2]) : null;

        const resData = await sheets.spreadsheets.values.get({
          spreadsheetId: SPREADSHEET_ID,
          range: `${SHEET_NAME}!B:J`, // ดึง Type(B), Amount(C), AssetCode(E), Month(J)
        });

        const rows = resData.data.values || [];
        let totalIncome = 0;
        let totalExpense = 0;

        for (const row of rows) {
          const [type, amount, , , assetCode, , , , monthKey] = row;
          if (monthKey === targetMonth) {
            // ถ้าระบุ @AssetCode ให้กรองเฉพาะตัวนั้น ถ้าไม่ระบุให้เอาทั้งหมด
            if (!targetAsset || (assetCode && normalizeText(assetCode) === targetAsset)) {
              const val = parseFloat(String(amount).replace(/,/g, "")) || 0;
              if (type === "รับ") totalIncome += val;
              else if (type === "จ่าย") totalExpense += val;
            }
          }
        }

        let replySummary = `📊 สรุปยอด ${targetAsset ? targetAsset : "ภาพรวม"}\n📅 เดือน: ${targetMonth}\n`;
        replySummary += `-------------------------\n`;
        replySummary += `🟢 รายรับ: ${totalIncome.toLocaleString()} บาท\n`;
        replySummary += `🔴 รายจ่าย: ${totalExpense.toLocaleString()} บาท\n`;
        replySummary += `💰 คงเหลือสุทธิ: ${(totalIncome - totalExpense).toLocaleString()} บาท`;

        await client.replyMessage({
          replyToken: event.replyToken,
          messages: [{ type: "text", text: replySummary }],
        });
        continue;
      }

      // --- 2. คำสั่ง "บันทึก" (รับ/จ่าย) เดิม ---
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
      const category = await detectCategory(detail);
      const room = extractRoom(detail);

      const row = [
        timestamp, type, amount, detail, assetCode, asset.fullName || "",
        category, room, asset.projectName || "", 
        new Date().getFullYear() + "-" + String(new Date().getMonth() + 1).padStart(2, "0"), 
        event.source.userId, "", "", asset.owner || "", asset.assetType || ""
      ];

      await sheets.spreadsheets.values.append({
        spreadsheetId: SPREADSHEET_ID,
        range: `${SHEET_NAME}!A:O`,
        valueInputOption: "USER_ENTERED",
        requestBody: { values: [row] },
      });

      let reply = `บันทึกแล้ว ✅\n${type} ${amount.toLocaleString()} บาท\nรายการ: ${category}\n`;
      if (assetCode) {
        reply += `รหัสทรัพย์: ${assetCode}${asset.fullName ? ` (${asset.fullName})` : ""}\n`;
        reply += `ผู้ชำระเงิน: ${asset.owner || ""}\n`;
        reply += `ประเภททรัพย์สิน: ${asset.assetType || ""}\n`;
      }
      reply += `รับชำระเมื่อ: ${timestamp}`;

      await client.replyMessage({
        replyToken: event.replyToken,
        messages: [{ type: "text", text: reply.trim() }],
      });
    }
  } catch (e) { console.error("Error:", e); }
});

app.get("/", (req, res) => res.send("OK ✅"));
app.listen(process.env.PORT || 8080);
