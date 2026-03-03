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

function getThaiDateTime() {
  const now = new Date();
  const options = { timeZone: 'Asia/Bangkok', day: 'numeric', month: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false };
  const formatter = new Intl.DateTimeFormat('th-TH', options);
  const parts = formatter.formatToParts(now);
  const d = parts.find(p => p.type === 'day').value;
  const m = parts.find(p => p.type === 'month').value;
  const y = parts.find(p => p.type === 'year').value;
  const time = parts.find(p => p.type === 'hour').value + ":" + parts.find(p => p.type === 'minute').value + ":" + parts.find(p => p.type === 'second').value;
  
  const monthKey = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit' }).format(now);
  return { full: `${d}/${m}/${y} ${time}`, monthKey: monthKey };
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
  try {
    const res = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${ASSET_SHEET}!A:H` });
    const rows = res.data.values || [];
    const map = new Map();
    for (let i = 1; i < rows.length; i++) {
      const [code, type, project, unit, fullName, owner, active, note] = rows[i];
      if (code) {
        const c = normalizeText(code).toUpperCase();
        map.set(c, { assetCode: c, assetName: fullName || "", project: project || "", owner: owner || "", assetNote: note || "" });
      }
    }
    return map;
  } catch (err) { return new Map(); }
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
      const timeData = getThaiDateTime();

      // --- 1. สรุปยอด ---
      const summaryMatch = text.match(/^สรุป\s+(\d{4}-\d{2})(?:\s+(@[A-Za-z0-9\-]+))?$/i);
      if (summaryMatch) {
        const targetMonth = summaryMatch[1]; 
        const targetAsset = summaryMatch[2] ? normalizeText(summaryMatch[2]).toUpperCase() : null;
        const resData = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${SHEET_NAME}!A:O` });
        const rows = resData.data.values || [];
        let totalIncome = 0, totalExpense = 0, paymentCount = 0, cumulativeIncome = 0;

        for (let i = 1; i < rows.length; i++) {
          const row = rows[i];
          const type = normalizeText(row[1] || ""); 
          const amount = parseFloat(String(row[2] || "0").replace(/,/g, "")) || 0;
          const assetCode = normalizeText(row[4] || "").toUpperCase();
          const category = normalizeText(row[6] || ""); 
          const monthKey = normalizeText(row[9] || ""); 

          if (!targetAsset || assetCode === targetAsset) {
            if (type === "รับ" && category.includes("ค่าเช่า")) { paymentCount++; cumulativeIncome += amount; }
            if (monthKey === targetMonth) {
              if (type === "รับ") totalIncome += amount;
              else if (type === "จ่าย") totalExpense += amount;
            }
          }
        }
        let replySum = `📊 สรุปยอด ${targetAsset ? targetAsset : "ภาพรวม"}\n📅 เดือน: ${targetMonth}\n-------------------------\n🟢 รับ: ${totalIncome.toLocaleString()} บาท\n🔴 จ่าย: ${totalExpense.toLocaleString()} บาท\n💰 สุทธิ: ${(totalIncome - totalExpense).toLocaleString()} บาท`;
        if (targetAsset) replySum += `\n-------------------------\n🏠 ชำระค่าเช่าสะสม: ${paymentCount} งวด\n💰 รวมยอดเงิน: ${cumulativeIncome.toLocaleString()} บาท`;
        await client.replyMessage({ replyToken: event.replyToken, messages: [{ type: "text", text: replySum }] });
        continue;
      }

      // --- 2. บันทึกข้อมูล (แก้ไข Regex ให้แม่นยำขึ้น) ---
      const m = text.match(/^(รับ|จ่าย)\s*(\d+(?:\.\d+)?)\s*(.+)$/i);
      if (!m) continue;

      const [ , type, amountStr, detailAll] = m;
      const amount = Number(amountStr);

      // แยกเครื่องหมาย @, #, * ออกจากรายละเอียด
      const assetMatch = detailAll.match(/(@[A-Za-z0-9\-]+)/);
      const payMatch = detailAll.match(/#([^\s*@#]+)/);
      const refMatch = detailAll.match(/\*([^\s*@#]+)/);

      const assetCode = assetMatch ? assetMatch[1].toUpperCase() : "";
      const paymentMethod = payMatch ? payMatch[1] : "";
      const ref = refMatch ? refMatch[1] : "";

      // คลีนข้อความรายละเอียดให้เหลือแต่เนื้อความ
      let cleanDetail = detailAll
        .replace(/(@[A-Za-z0-9\-]+)/g, "")
        .replace(/#([^\s*@#]+)/g, "")
        .replace(/\*([^\s*@#]+)/g, "")
        .trim();

      const assetMap = await loadAssetsIfNeeded();
      const asset = assetMap.get(assetCode) || {};
      const category = await detectCategory(cleanDetail);
      const room = extractRoom(cleanDetail);

      // จัดข้อมูลลง 15 คอลัมน์ (A-O)
      const row = [
        timeData.full, type, amount, cleanDetail, assetCode, 
        asset.assetName || "", category, room, asset.project || "", 
        timeData.monthKey, event.source.userId, paymentMethod, ref, 
        asset.owner || "", asset.assetNote || ""
      ];

      await sheets.spreadsheets.values.append({
        spreadsheetId: SPREADSHEET_ID, range: `${SHEET_NAME}!A:O`,
        valueInputOption: "USER_ENTERED", requestBody: { values: [row] },
      });

      // --- ส่วนการแสดงผลผลลัพธ์ (แก้ไขให้ครบทุก Field ตามภาพที่ต้องการ) ---
      let reply = `บันทึกแล้ว ✅\n`;
      reply += `${type} ${amount.toLocaleString()} บาท\n`;
      reply += `รายการ: ${category}\n`;
      
      if (assetCode) {
        reply += `รหัสทรัพย์: ${assetCode} (${asset.assetName || "ไม่พบข้อมูล"})\n`;
        reply += `ผู้ชำระเงิน: ${asset.owner || "ไม่พบข้อมูล"}\n`;
        reply += `ประเภททรัพย์สิน: ${asset.assetNote || "ไม่พบข้อมูล"}\n`;
      }
      
      if (paymentMethod) reply += `วิธีชำระ: ${paymentMethod}\n`;
      if (ref) reply += `อ้างอิง: ${ref}\n`;
      
      reply += `รับชำระเมื่อ: ${timeData.full}`;

      await client.replyMessage({ replyToken: event.replyToken, messages: [{ type: "text", text: reply.trim() }] });
    }
  } catch (e) { console.error("Webhook Error:", e); }
});

app.listen(process.env.PORT || 8080);
