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

let categoryCache = { loadedAt: 0, list: [] };
async function loadCategoryIfNeeded() {
  const now = Date.now();
  if (now - categoryCache.loadedAt < 60000 && categoryCache.list.length) return;
  try {
    const res = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${CATEGORY_SHEET}!A:B` });
    const rows = res.data.values || [];
    const list = [];
    for (let i = 1; i < rows.length; i++) {
      const [kw, cat] = rows[i];
      if (kw && cat) list.push({ keyword: normalizeText(kw), category: normalizeText(cat) });
    }
    categoryCache = { loadedAt: now, list };
  } catch (err) { console.error("Load Category Error:", err); }
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
  const m = detail.match(/ห้อง\s*([0-9\/\-]+)/) || detail.match(/([0-9]+\/[0-9]+)/);
  return m ? m[1] : "";
}

async function loadAssetsIfNeeded() {
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${ASSET_SHEET}!A:H` });
  const rows = res.data.values || [];
  const map = new Map();
  for (let i = 1; i < rows.length; i++) {
    const [code, type, project, unit, name, owner, active] = rows[i];
    if (code) {
      const c = normalizeText(code).toUpperCase();
      map.set(c, { assetCode: c, assetType: type, fullName: name, owner: owner, projectName: project });
    }
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

      // --- 1. ส่วนคำสั่งสรุปยอด, นับงวด และยอดสะสม ---
      const summaryMatch = text.match(/^สรุป\s+(\d{4}-\d{2})(?:\s+(@[A-Za-z0-9\-]+))?$/i);
      if (summaryMatch) {
        const targetMonth = summaryMatch[1]; 
        const targetAsset = summaryMatch[2] ? normalizeText(summaryMatch[2]).toUpperCase() : null;

        const resData = await sheets.spreadsheets.values.get({
          spreadsheetId: SPREADSHEET_ID,
          range: `${SHEET_NAME}!A:O`, 
        });

        const rows = resData.data.values || [];
        let totalIncome = 0;
        let totalExpense = 0;
        let paymentCount = 0;
        let cumulativeIncome = 0;

        for (let i = 1; i < rows.length; i++) {
          const row = rows[i];
          const type = normalizeText(row[1] || ""); 
          const amount = parseFloat(String(row[2] || "0").replace(/,/g, "")) || 0;
          const assetCode = normalizeText(row[4] || "").toUpperCase();
          const category = normalizeText(row[6] || ""); 
          const monthKey = normalizeText(row[9] || ""); 

          if (!targetAsset || assetCode === targetAsset) {
            // นับงวดและยอดสะสมเฉพาะรายการ "ค่าเช่า" ที่สถานะเป็น "รับ"
            if (type === "รับ" && category.includes("ค่าเช่า")) {
              paymentCount++;
              cumulativeIncome += amount;
            }

            // คำนวณยอดเฉพาะเดือนที่ระบุ
            if (monthKey === targetMonth) {
              if (type === "รับ") totalIncome += amount;
              else if (type === "จ่าย") totalExpense += amount;
            }
          }
        }

        let replySum = `📊 สรุปยอด ${targetAsset ? targetAsset : "ภาพรวม"}\n📅 เดือน: ${targetMonth}\n`;
        replySum += `-------------------------\n`;
        replySum += `🟢 รับ: ${totalIncome.toLocaleString()} บาท\n`;
        replySum += `🔴 จ่าย: ${totalExpense.toLocaleString()} บาท\n`;
        replySum += `💰 สุทธิ: ${(totalIncome - totalExpense).toLocaleString()} บาท`;
        
        if (targetAsset) {
          replySum += `\n-------------------------\n`;
          replySum += `🏠 ชำระค่าเช่าสะสม: ${paymentCount} งวด\n`;
          replySum += `💰 รวมยอดเงิน: ${cumulativeIncome.toLocaleString()} บาท`;
        }

        await client.replyMessage({ replyToken: event.replyToken, messages: [{ type: "text", text: replySum }] });
        continue;
      }

      // --- 2. คำสั่งบันทึก (รับ/จ่าย) ---
      const m = text.match(/^(รับ|จ่าย)\s*(\d+(?:\.\d+)?)\s*(.+)$/i);
      if (!m) continue;

      const [ , type, amountStr, detailAll] = m;
      const amount = Number(amountStr);
      const assetMatch = detailAll.match(/(.*)\s+(@[A-Za-z0-9\-]+)\s*$/);
      const detailRaw = assetMatch ? normalizeText(assetMatch[1]) : detailAll;
      const assetCode = assetMatch ? normalizeText(assetMatch[2]).toUpperCase() : "";

      const payMatch = detailRaw.match(/#(\S+)/);
      const refMatch = detailRaw.match(/\*(\S+)/);
      const paymentMethod = payMatch ? payMatch[1] : "";
      const ref = refMatch ? refMatch[1] : "";
      const cleanDetail = detailRaw.replace(/#\S+/g, "").replace(/\*\S+/g, "").trim();

      const timestamp = getThaiTimestamp();
      const assetMap = await loadAssetsIfNeeded();
      const asset = assetMap.get(assetCode) || {};
      const category = await detectCategory(cleanDetail);
      const room = extractRoom(cleanDetail);
      const monthKey = new Date().getFullYear() + "-" + String(new Date().getMonth() + 1).padStart(2, "0");

      const row = [
        timestamp, type, amount, cleanDetail, assetCode, asset.fullName || "",
        category, room, asset.projectName || "", monthKey, event.source.userId,
        paymentMethod, ref, asset.owner || "", asset.assetType || ""
      ];

      await sheets.spreadsheets.values.append({
        spreadsheetId: SPREADSHEET_ID,
        range: `${SHEET_NAME}!A:O`,
        valueInputOption: "USER_ENTERED",
        requestBody: { values: [row] },
      });

      let reply = `บันทึกแล้ว ✅\n${type} ${amount.toLocaleString()} บาท\nรายการ: ${category}\n`;
      if (paymentMethod) reply += `ช่องทาง: ${paymentMethod}\n`;
      if (assetCode) reply += `รหัสทรัพย์: ${assetCode}\nผู้ชำระเงิน: ${asset.owner || ""}\n`;
      reply += `เมื่อ: ${timestamp}`;

      await client.replyMessage({ replyToken: event.replyToken, messages: [{ type: "text", text: reply.trim() }] });
    }
  } catch (e) { console.error("Webhook Error:", e); }
});

app.get("/", (req, res) => res.send("System Active ✅"));
app.listen(process.env.PORT || 8080);
