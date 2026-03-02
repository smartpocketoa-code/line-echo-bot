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
   GOOGLE SHEETS CONFIG
===================== */
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const DATA_SHEET = process.env.SHEET_NAME || "DATA"; // แท็บ DATA
const ASSET_SHEET = "ASSET"; // แท็บ ASSET
const CATEGORY_SHEET = "CATEGORY"; // แท็บ CATEGORY

const auth = new google.auth.GoogleAuth({
  credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT || "{}"),
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});

let sheetsClient = null;
async function sheets() {
  if (!sheetsClient) {
    const authClient = await auth.getClient();
    sheetsClient = google.sheets({ version: "v4", auth: authClient });
  }
  return sheetsClient;
}

/* =====================
   HELPERS
===================== */
function normalizeText(s = "") {
  return String(s).replace(/\u00A0/g, " ").replace(/\s+/g, " ").trim();
}

function toMonthKey(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

/* =====================
   LOOKUP: ASSET (A:H)
   A AssetCode | B AssetType | C ProjectName | D UnitNo | E FullName | F Owner | G Active | H Note
===================== */
async function lookupAsset(assetCode) {
  if (!assetCode) return null;

  const sh = await sheets();
  const res = await sh.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `'${ASSET_SHEET}'!A:H`,
  });

  const rows = res.data.values || [];
  for (let i = 1; i < rows.length; i++) {
    const [
      code,
      assetType,
      projectName,
      unitNo,
      fullName,
      owner,
      active,
      note,
    ] = rows[i] || [];

    if (normalizeText(code) === normalizeText(assetCode)) {
      const isActive = String(active || "").toUpperCase() === "TRUE";
      return {
        assetCode: normalizeText(code),
        assetType: assetType || "",
        projectName: projectName || "",
        unitNo: unitNo || "",
        fullName: fullName || "",
        owner: owner || "",
        active: isActive,
        note: note || "",
      };
    }
  }
  return null;
}

/* =====================
   LOOKUP: CATEGORY RULES (Keyword -> Category)
   CATEGORY: A Keyword | B Category
===================== */
async function loadCategoryRules() {
  const sh = await sheets();
  const res = await sh.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `'${CATEGORY_SHEET}'!A:B`,
  });

  const rows = res.data.values || [];
  const rules = [];
  for (let i = 1; i < rows.length; i++) {
    const kw = normalizeText(rows[i]?.[0] || "");
    const cat = normalizeText(rows[i]?.[1] || "");
    if (kw && cat) rules.push({ kw: kw.toLowerCase(), cat });
  }
  return rules;
}

async function guessCategory(detail) {
  const d = normalizeText(detail).toLowerCase();
  const rules = await loadCategoryRules();
  for (const r of rules) {
    if (d.includes(r.kw)) return r.cat;
  }
  return "อื่นๆ";
}

function extractRoom(detail) {
  const m = normalizeText(detail).match(/ห้อง\s*([0-9\/\-]+)/);
  return m ? m[1] : "";
}

/* =====================
   APPEND TO DATA (A:O)
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
async function appendToDataRow(rowAtoO) {
  const sh = await sheets();
  await sh.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: `'${DATA_SHEET}'!A:O`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [rowAtoO] },
  });
}

/* =====================
   SUMMARY
===================== */
async function summary(month, assetCode = "") {
  const sh = await sheets();
  const res = await sh.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `'${DATA_SHEET}'!A:O`,
  });

  const rows = res.data.values || [];
  let income = 0;
  let expense = 0;

  for (let i = 1; i < rows.length; i++) {
    const r = rows[i] || [];
    const type = normalizeText(r[1]); // B
    const amount = Number(r[2] || 0); // C
    const rAsset = normalizeText(r[4]); // E
    const rMonth = normalizeText(r[9]); // J

    if (!rMonth) continue;
    if (rMonth !== month) continue;
    if (assetCode && rAsset !== normalizeText(assetCode)) continue;

    if (type === "รับ") income += amount;
    if (type === "จ่าย") expense += amount;
  }

  return { income, expense, net: income - expense };
}

/* =====================
   PARSE MESSAGE
   รองรับ:
   - "รับ 5000 ค่าเช่า @C1"
   - "จ่าย 120 ค่าน้ำ @C1 โอน สลิป123"
   - ใส่ @C1 ตรงไหนก็ได้ (แนะนำท้าย)
===================== */
function parseSaveCommand(text) {
  const t = normalizeText(text);

  // ดึง @AssetCode จากข้อความ (ตัวแรกที่เจอ)
  const assetMatch = t.match(/(@[A-Za-z0-9\-_]+)/);
  const assetCode = assetMatch ? normalizeText(assetMatch[1]) : "";

  // ลบ assetCode ออกเพื่อ parse ง่าย
  const withoutAsset = assetCode ? normalizeText(t.replace(assetCode, "")) : t;

  // รับ/จ่าย + จำนวน + ที่เหลือ
  const m = withoutAsset.match(/^(รับ|จ่าย)\s*(\d+(?:\.\d+)?)\s*(.+)$/i);
  if (!m) return null;

  const type = m[1];
  const amount = m[2];

  // หาจ่ายแบบมี payment/ref ต่อท้าย: "... โอน สลิป123" หรือ "... เงินสด" ฯลฯ
  let rest = normalizeText(m[3]);
  let paymentMethod = "";
  let ref = "";

  const pm = rest.match(/(.*)\s+(เงินสด|โอน|บัตร|อื่นๆ)\s*(.*)$/);
  if (pm) {
    rest = normalizeText(pm[1]);
    paymentMethod = normalizeText(pm[2]);
    ref = normalizeText(pm[3]); // อาจว่างได้
  }

  const detail = rest;

  return { type, amount, detail, assetCode, paymentMethod, ref };
}

/* =====================
   WEBHOOK
   (อย่าใส่ app.use(express.json()) ก่อนนี้)
===================== */
app.post("/webhook", line.middleware(config), async (req, res) => {
  res.status(200).end();

  try {
    const events = req.body?.events || [];

    for (const event of events) {
      if (event.type !== "message" || event.message.type !== "text") continue;

      const userId = event.source?.userId || "";
      const text = normalizeText(event.message.text || "");

      // ✅ คำสั่งสรุป
      const sumMatch = text.match(/^สรุป\s+(\d{4}-\d{2})(?:\s+(@[A-Za-z0-9\-_]+))?$/);
      if (sumMatch) {
        const month = sumMatch[1];
        const assetCode = normalizeText(sumMatch[2] || "");
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

      // ✅ บันทึก
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

      // lookup asset
      let asset = null;
      if (cmd.assetCode) {
        asset = await lookupAsset(cmd.assetCode);
        if (!asset) {
          await client.replyMessage({
            replyToken: event.replyToken,
            messages: [{
              type: "text",
              text: `ไม่พบทรัพย์ ${cmd.assetCode} ในแท็บ ASSET ❌\nเช็กว่า AssetCode ตรงกันไหม`,
            }],
          });
          continue;
        }

        if (!asset.active) {
          await client.replyMessage({
            replyToken: event.replyToken,
            messages: [{
              type: "text",
              text:
                `ทรัพย์ ${asset.assetCode} ถูกปิดใช้งาน (Active=FALSE) ❌\n` +
                `Owner: ${asset.owner || "-"}\n` +
                `Note: ${asset.note || "-"}`,
            }],
          });
          continue;
        }
      }

      const now = new Date();
      const monthKey = toMonthKey(now);

      const category = await guessCategory(cmd.detail);
      const room = extractRoom(cmd.detail) || (asset?.unitNo || "");
      const assetName = asset?.fullName || "";
      const project = asset?.projectName || "";
      const owner = asset?.owner || "";
      const note = asset?.note || "";

      // write to DATA A:O
      const row = [
        now.toLocaleString("th-TH"),        // A Timestamp
        cmd.type,                           // B Type
        Number(cmd.amount),                 // C Amount
        cmd.detail,                         // D Detail
        cmd.assetCode || "",                // E AssetCode
        assetName,                          // F AssetName
        category,                           // G Category
        room,                               // H Room
        project,                            // I Project
        monthKey,                           // J Month
        userId,                             // K User
        cmd.paymentMethod || "",            // L PaymentMethod
        cmd.ref || "",                      // M Ref
        owner,                              // N Owner
        note,                               // O Note
      ];

      await appendToDataRow(row);

      // ✅ Reply ให้แสดง Owner/Note แบบที่คุณอยากได้
      let reply =
        `บันทึกแล้ว ✅\n` +
        `${cmd.type} ${Number(cmd.amount).toLocaleString()} บาท\n` +
        `${cmd.detail}\n` +
        `ทรัพย์: ${cmd.assetCode || "-"}${assetName ? ` (${assetName})` : ""}\n` +
        `Owner: ${owner || "-"}\n` +
        `Note: ${note || "-"}`;

      // ถ้ามี payment/ref ให้โชว์เพิ่ม
      if (cmd.paymentMethod) {
        reply += `\nชำระ: ${cmd.paymentMethod}${cmd.ref ? ` (${cmd.ref})` : ""}`;
      }

      await client.replyMessage({
        replyToken: event.replyToken,
        messages: [{ type: "text", text: reply }],
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
