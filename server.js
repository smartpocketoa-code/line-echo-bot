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
const DATA_SHEET = process.env.SHEET_NAME || "DATA"; // ใช้แท็บ DATA
const ASSET_SHEET = "ASSET";

function assertEnv() {
  const need = [
    "LINE_CHANNEL_ACCESS_TOKEN",
    "LINE_CHANNEL_SECRET",
    "GOOGLE_SERVICE_ACCOUNT",
    "SPREADSHEET_ID",
  ];
  const missing = need.filter((k) => !process.env[k]);
  if (missing.length) {
    throw new Error("Missing env: " + missing.join(", "));
  }
}

const googleAuth = new google.auth.GoogleAuth({
  credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT || "{}"),
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});

let sheetsClient = null;
async function sheets() {
  if (!sheetsClient) {
    const authClient = await googleAuth.getClient();
    sheetsClient = google.sheets({ version: "v4", auth: authClient });
  }
  return sheetsClient;
}

function toMonthKey(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

function normalizeText(s = "") {
  return String(s)
    .replace(/\u00A0/g, " ") // NBSP
    .replace(/\s+/g, " ")
    .trim();
}

function detectCategory(detail) {
  if (detail.includes("ค่าเช่า")) return "ค่าเช่า";
  if (detail.includes("ค่าน้ำ")) return "ค่าน้ำ";
  if (detail.includes("ค่าไฟ")) return "ค่าไฟ";
  if (detail.includes("ส่วนกลาง")) return "ค่าส่วนกลาง";
  if (detail.includes("ซ่อม")) return "ซ่อมบำรุง";
  return "อื่นๆ";
}

function extractRoomOrNo(detail) {
  // "ห้อง 278/136" หรือ "ห้อง101"
  const m = detail.match(/ห้อง\s*([0-9\/\-]+)/);
  return m ? m[1] : "";
}

/**
 * lookupAsset ใช้คอลัมน์ A-H จากแท็บ ASSET:
 * A AssetCode | B AssetType | C ProjectName | D UnitNo | E FullName | F Owner | G Active | H Note
 */
async function lookupAsset(assetCode) {
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
    ] = rows[i];

    if (normalizeText(code) === normalizeText(assetCode)) {
      const activeBool = String(active || "").toUpperCase() === "TRUE";
      return {
        assetCode: normalizeText(code),
        assetType: assetType || "",
        projectName: projectName || "",
        unitNo: unitNo || "",
        fullName: fullName || "",
        owner: owner || "",
        active: activeBool,
        note: note || "",
      };
    }
  }

  return null; // ไม่พบ
}

/**
 * append DATA A:M (เพิ่ม Owner/AssetNote ต่อท้าย)
 */
async function appendToDataRow(rowAtoM) {
  const sh = await sheets();
  await sh.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: `'${DATA_SHEET}'!A:M`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [rowAtoM] },
  });
}

/**
 * summary รวมจาก DATA:
 * B Type, C Amount, E AssetCode, J Month
 */
async function summary(month, assetCode = "") {
  const sh = await sheets();
  const res = await sh.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `'${DATA_SHEET}'!A:M`,
  });

  const rows = res.data.values || [];
  let income = 0;
  let expense = 0;

  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const type = normalizeText(r[1]); // B
    const amount = Number(r[2] || 0); // C
    const rAsset = normalizeText(r[4]); // E
    const rMonth = normalizeText(r[9]); // J

    if (rMonth !== month) continue;
    if (assetCode && rAsset !== normalizeText(assetCode)) continue;

    if (type === "รับ") income += amount;
    if (type === "จ่าย") expense += amount;
  }

  return { income, expense, net: income - expense };
}

/* =====================
   WEBHOOK (ห้ามใส่ express.json ก่อนอันนี้)
===================== */
app.post("/webhook", line.middleware(config), async (req, res) => {
  res.status(200).end(); // ตอบ LINE ทันที

  try {
    assertEnv();

    const events = req.body?.events || [];
    for (const event of events) {
      if (event.type !== "message" || event.message.type !== "text") continue;

      const userId = event.source?.userId || "";
      const text = normalizeText(event.message.text || "");

      // 1) สรุป: "สรุป 2026-03" หรือ "สรุป 2026-03 @C1"
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

      // 2) บันทึก: "รับ 5000 ค่าเช่า ห้อง101 @C1" (ใส่ @ ที่ไหนก็ได้)
      // ดึง @AssetCode ถ้ามี
      const assetMatch = text.match(/(@[A-Za-z0-9\-_]+)/);
      const assetCode = assetMatch ? normalizeText(assetMatch[1]) : "";

      // ลบ assetCode ออกจากข้อความ เพื่อ parse ง่าย
      const textNoAsset = assetCode ? normalizeText(text.replace(assetCode, "")) : text;

      const m = textNoAsset.match(/^(รับ|จ่าย)\s*(\d+(?:\.\d+)?)\s*(.+)$/i);
      if (!m) {
        await client.replyMessage({
          replyToken: event.replyToken,
          messages: [{
            type: "text",
            text:
              "รูปแบบบันทึก:\n" +
              "รับ 5000 ค่าเช่า ห้อง101 @H1\n" +
              "จ่าย 350 ค่าน้ำ @C1\n\n" +
              "สรุป:\nสรุป 2026-03\nสรุป 2026-03 @C1",
          }],
        });
        continue;
      }

      const type = m[1];                 // รับ/จ่าย
      const amount = Number(m[2]);
      const detail = normalizeText(m[3]);

      // ถ้าใส่ assetCode → lookup
      let asset = null;
      if (assetCode) {
        asset = await lookupAsset(assetCode);
        if (!asset) {
          await client.replyMessage({
            replyToken: event.replyToken,
            messages: [{
              type: "text",
              text: `ไม่พบทรัพย์ ${assetCode} ในแท็บ ASSET ❌\nเช็กว่า AssetCode ตรงกันไหม`,
            }],
          });
          continue;
        }

        // Active = FALSE → ห้ามบันทึก
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

      const category = detectCategory(detail);
      const roomOrNo = extractRoomOrNo(detail);

      const row = [
        now.toLocaleString("th-TH"),     // A Timestamp
        type,                             // B Type
        amount,                           // C Amount
        detail,                           // D Detail
        asset?.assetCode || assetCode || "",     // E AssetCode
        asset?.fullName || "",            // F AssetName (FullName)
        category,                         // G Category
        asset?.unitNo || roomOrNo || "",  // H Room (ถ้ามี unitNo ให้ใช้)
        asset?.projectName || "",         // I Project
        monthKey,                         // J Month
        userId,                           // K User
        asset?.owner || "",               // L Owner (ใหม่)
        asset?.note || "",                // M AssetNote (ใหม่)
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
            `${asset ? `ทรัพย์: ${asset.assetCode} (${asset.fullName})\nOwner: ${asset.owner || "-"}\nNote: ${asset.note || "-"}` : `ทรัพย์: (ยังไม่ระบุ)`}`,
        }],
      });
    }
  } catch (e) {
    console.error("WEBHOOK ERROR:", e);
  }
});

/* =====================
   OTHER ROUTES
===================== */
app.get("/", (req, res) => res.send("OK"));

const PORT = process.env.PORT || 8080;
app.listen(PORT, "0.0.0.0", () => console.log("Server running on", PORT));
