const express = require("express");
const line = require("@line/bot-sdk");
const { google } = require("googleapis");

const app = express();

const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

// LINE client
const client = new line.messagingApi.MessagingApiClient({
  channelAccessToken: config.channelAccessToken,
});

/* =====================
   GOOGLE SHEETS SETUP
===================== */
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const DATA_SHEET = process.env.SHEET_NAME || "DATA";
const ASSET_SHEET = "ASSET";
const CATEGORY_SHEET = "CATEGORY";

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

function normalizeText(s) {
  return (s || "")
    .replace(/\u00A0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/* =====================
   LOOKUP: ASSET
   ASSET columns:
   A AssetCode | B AssetType | C ProjectName | D UnitNo | E FullName | F Owner | G Active | H Note
===================== */
async function lookupAsset(assetCode) {
  if (!assetCode) return null;

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${ASSET_SHEET}!A:H`,
  });

  const rows = res.data.values || [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const code = (r[0] || "").trim(); // A
    if (code === assetCode) {
      return {
        assetCode: code,
        assetType: r[1] || "",
        project: r[2] || "",
        unitNo: r[3] || "",
        assetName: r[4] || "",
        owner: r[5] || "",
        active: String(r[6] || "").toUpperCase() === "TRUE",
        note: r[7] || "",
      };
    }
  }
  return null;
}

/* =====================
   LOOKUP: CATEGORY (keyword -> category)
   CATEGORY columns: A Keyword | B Category
===================== */
async function loadCategoryRules() {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${CATEGORY_SHEET}!A:B`,
  });

  const rows = res.data.values || [];
  const rules = [];
  for (let i = 1; i < rows.length; i++) {
    const kw = (rows[i][0] || "").trim();
    const cat = (rows[i][1] || "").trim();
    if (kw && cat) rules.push({ kw, cat });
  }
  return rules;
}

async function guessCategory(detail) {
  const d = (detail || "").toLowerCase();
  const rules = await loadCategoryRules();
  for (const r of rules) {
    if (d.includes(r.kw.toLowerCase())) return r.cat;
  }
  return "อื่นๆ";
}

/* =====================
   APPEND TO DATA
   DATA columns A–O:
   A Timestamp
   B Type
   C Amount
   D Detail
   E AssetCode
   F AssetName
   G Category
   H Room
   I Project
   J Month
   K User
   L PaymentMethod
   M Ref
   N Owner
   O Note
===================== */
async function appendToDataRow(row) {
  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: `${DATA_SHEET}!A:O`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [row] },
  });
}

/* =====================
   SUMMARY
===================== */
async function summary(month, assetCode = "") {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${DATA_SHEET}!A:O`,
  });

  const rows = res.data.values || [];
  let income = 0;
  let expense = 0;

  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const type = (r[1] || "").trim();      // B
    const amount = Number(r[2] || 0);      // C
    const rAsset = (r[4] || "").trim();    // E
    const rMonth = (r[9] || "").trim();    // J

    if (rMonth !== month) continue;
    if (assetCode && rAsset !== assetCode) continue;

    if (type === "รับ") income += amount;
    if (type === "จ่าย") expense += amount;
  }

  return { income, expense, net: income - expense };
}

/* =====================
   PARSE MESSAGE
   ตัวอย่าง:
   "จ่าย 120 ค่าน้ำ @C1 โอน สลิป123"
===================== */
function parseSaveCommand(text) {
  // รับ/จ่าย + จำนวน + ข้อความที่เหลือ
  const m = text.match(/^(รับ|จ่าย)\s*(\d+(?:\.\d+)?)\s*(.+)$/i);
  if (!m) return null;

  const type = m[1];
  const amount = m[2];
  let rest = m[3];

  // ดึง @AssetCode (ตัวสุดท้ายที่ขึ้นต้นด้วย @)
  let assetCode = "";
  const assetMatch = rest.match(/(.*)\s+(@[A-Za-z0-9_@\-]+)\s*$/);
  if (assetMatch) {
    rest = assetMatch[1].trim();
    assetCode = assetMatch[2].trim();
  }

  // payment/ref (ถ้ามี) — วิธีง่าย: ถ้าเจอคำว่า เงินสด/โอน/บัตร/อื่นๆ เป็น payment
  // และคำที่เหลือท้ายสุดให้เป็น ref ถ้ามี
  let paymentMethod = "";
  let ref = "";

  const pmMatch = rest.match(/(.*)\s+(เงินสด|โอน|บัตร|อื่นๆ)\s*(.*)$/);
  if (pmMatch) {
    rest = pmMatch[1].trim();
    paymentMethod = pmMatch[2].trim();
    ref = (pmMatch[3] || "").trim(); // เช่น สลิป123
  }

  const detail = rest.trim();

  return { type, amount, detail, assetCode, paymentMethod, ref };
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
      const text = normalizeText(event.message.text);

      // สรุป
      const sumMatch = text.match(/^สรุป\s+(\d{4}-\d{2})(?:\s+(@[A-Za-z0-9_@\-]+))?$/);
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

      // บันทึก
      const cmd = parseSaveCommand(text);
      if (!cmd) {
        await client.replyMessage({
          replyToken: event.replyToken,
          messages: [{
            type: "text",
            text:
              "รูปแบบบันทึก:\n" +
              "รับ 5000 ค่าเช่า @C1\n" +
              "จ่าย 120 ค่าน้ำ @C1 โอน สลิป123\n\n" +
              "สรุป:\nสรุป 2026-03\nสรุป 2026-03 @C1",
          }],
        });
        continue;
      }

      const now = new Date();
      const monthKey = toMonthKey(now);

      // lookup asset
      let asset = null;
      if (cmd.assetCode) asset = await lookupAsset(cmd.assetCode);

      // ถ้าทรัพย์ถูกปิด (Active = FALSE) ให้เตือนและไม่บันทึก
      if (asset && asset.active === false) {
        await client.replyMessage({
          replyToken: event.replyToken,
          messages: [{
            type: "text",
            text: `ทรัพย์ ${cmd.assetCode} ถูกปิดใช้งาน (Active=FALSE)\nเปิดในแท็บ ASSET ก่อน แล้วค่อยบันทึกอีกครั้ง`,
          }],
        });
        continue;
      }

      const assetName = asset?.assetName || "";
      const project = asset?.project || "";
      const owner = asset?.owner || "";
      const note = asset?.note || "";

      // category
      const category = await guessCategory(cmd.detail);

      // room (ถ้ามีคำว่า ห้องxxx หรือมี unitNo จาก asset)
      const roomMatch = cmd.detail.match(/ห้อง\s*([0-9\/\-]+)/);
      const room = roomMatch ? roomMatch[1] : (asset?.unitNo || "");

      const row = [
        now.toLocaleString("th-TH"),      // A
        cmd.type,                          // B
        Number(cmd.amount),                // C
        cmd.detail,                         // D
        cmd.assetCode,                      // E
        assetName,                          // F
        category,                           // G
        room,                               // H
        project,                            // I
        monthKey,                           // J
        userId,                             // K
        cmd.paymentMethod,                  // L
        cmd.ref,                            // M
        owner,                              // N
        note,                               // O
      ];

      await appendToDataRow(row);

      await client.replyMessage({
        replyToken: event.replyToken,
        messages: [{
          type: "text",
          text:
            `บันทึกแล้ว ✅\n` +
            `${cmd.type} ${Number(cmd.amount).toLocaleString()} บาท\n` +
            `${cmd.detail}\n` +
            `${cmd.assetCode ? `ทรัพย์: ${cmd.assetCode}${assetName ? ` (${assetName})` : ""}` : "ทรัพย์: (ยังไม่ระบุ)"}\n` +
            `${cmd.paymentMethod ? `ชำระ: ${cmd.paymentMethod}${cmd.ref ? ` (${cmd.ref})` : ""}` : ""}`,
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
