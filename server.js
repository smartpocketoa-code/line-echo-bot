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

// ใช้ middleware ของ LINE ตัวนี้จะอ่าน raw body ให้เองเพื่อเช็ค signature
// (อย่าใส่ app.use(express.json()) ก่อน middleware นี้)
const client = new line.messagingApi.MessagingApiClient({
  channelAccessToken: config.channelAccessToken,
});

/* =====================
   GOOGLE SHEETS CONFIG
===================== */
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const SHEET_NAME = process.env.SHEET_NAME || "DATA"; // DATA
const ASSET_SHEET = process.env.ASSET_SHEET || "ASSET";
const CATEGORY_SHEET = process.env.CATEGORY_SHEET || "CATEGORY";

if (!SPREADSHEET_ID) {
  console.error("❌ Missing SPREADSHEET_ID env");
}

const auth = new google.auth.GoogleAuth({
  credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT || "{}"),
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});

const sheets = google.sheets({ version: "v4", auth });

/* =====================
   HELPERS
===================== */
function normalizeText(s = "") {
  return String(s).replace(/\u00A0/g, " ").replace(/\s+/g, " ").trim();
}

function getThaiDateTime() {
  const now = new Date();
  const options = {
    timeZone: "Asia/Bangkok",
    day: "numeric",
    month: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  };
  const formatter = new Intl.DateTimeFormat("th-TH", options);
  const parts = formatter.formatToParts(now);

  const d = parts.find((p) => p.type === "day")?.value || "";
  const m = parts.find((p) => p.type === "month")?.value || "";
  const y = parts.find((p) => p.type === "year")?.value || "";

  const hh = parts.find((p) => p.type === "hour")?.value || "00";
  const mm = parts.find((p) => p.type === "minute")?.value || "00";
  const ss = parts.find((p) => p.type === "second")?.value || "00";

  // Month key = YYYY-MM (ใช้โซนไทย)
  const monthKey = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Bangkok",
    year: "numeric",
    month: "2-digit",
  }).format(now);

  // ✅ เพิ่ม dateOnly สำหรับ "วันชำระ"
  const dateOnly = `${d}/${m}/${y}`;

  return { full: `${dateOnly} ${hh}:${mm}:${ss}`, monthKey, dateOnly };
}

function money(n) {
  const x = Number(n) || 0;
  return x
    .toLocaleString("th-TH", { maximumFractionDigits: 2 })
    .replace(/(\.\d*?)0+$/, "$1")
    .replace(/\.$/, "");
}

function extractRoom(detail) {
  // ห้อง 278/136 หรือ 59/90
  const m =
    detail.match(/ห้อง\s*([0-9\/\-]+)/) ||
    detail.match(/([0-9]+\/[0-9]+)/);
  return m ? m[1] : "";
}

/* =====================
   CATEGORY CACHE
===================== */
let categoryCache = { loadedAt: 0, list: [] };

async function loadCategoryIfNeeded() {
  const now = Date.now();
  if (now - categoryCache.loadedAt < 60_000 && categoryCache.list.length) return;

  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${CATEGORY_SHEET}!A:B`,
    });

    const rows = res.data.values || [];
    const list = [];
    for (let i = 1; i < rows.length; i++) {
      const [kw, cat] = rows[i];
      if (kw && cat) {
        list.push({
          keyword: normalizeText(kw).toLowerCase(),
          category: normalizeText(cat),
        });
      }
    }
    categoryCache = { loadedAt: now, list };
  } catch (err) {
    console.error("Load Category Error:", err);
  }
}

async function detectCategory(detail) {
  await loadCategoryIfNeeded();
  const d = normalizeText(detail).toLowerCase();

  for (const item of categoryCache.list) {
    if (item.keyword && d.includes(item.keyword)) return item.category;
  }
  return "อื่นๆ";
}

/* =====================
   ASSET CACHE
===================== */
let assetCache = { loadedAt: 0, map: new Map() };

async function loadAssetsIfNeeded() {
  const now = Date.now();
  if (now - assetCache.loadedAt < 60_000 && assetCache.map.size) return assetCache.map;

  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${ASSET_SHEET}!A:H`,
    });

    const rows = res.data.values || [];
    const map = new Map();

    // ASSET columns:
    // A AssetCode, B AssetType, C ProjectName, D UnitNo, E FullName, F Owner, G Active, H Note
    for (let i = 1; i < rows.length; i++) {
      const [code, assetType, project, unit, fullName, owner, active, note] = rows[i];
      if (!code) continue;

      const c = normalizeText(code).toUpperCase();
      map.set(c, {
        assetCode: c,
        assetType: normalizeText(assetType || ""),
        project: normalizeText(project || ""),
        unit: normalizeText(unit || ""),
        assetName: normalizeText(fullName || ""),
        owner: normalizeText(owner || ""),
        active: normalizeText(active || ""),
        assetNote: normalizeText(note || ""),
      });
    }

    assetCache = { loadedAt: now, map };
    return map;
  } catch (err) {
    console.error("Load Asset Error:", err);
    assetCache = { loadedAt: now, map: new Map() };
    return assetCache.map;
  }
}

/* =====================
   SHEET APPEND
===================== */
async function appendDataRow(rowAtoO) {
  // เขียนลง DATA A:O
  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_NAME}!A:O`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [rowAtoO] },
  });
}

/* =====================
   SUMMARY
===================== */
async function buildSummary(targetMonth, targetAsset = "") {
  const resData = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_NAME}!A:O`,
  });

  const rows = resData.data.values || [];

  let monthIncome = 0;
  let monthExpense = 0;

  let rentCount = 0;
  let rentTotal = 0;

  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];

    const type = normalizeText(r[1] || ""); // B
    const amount = parseFloat(String(r[2] || "0").replace(/,/g, "")) || 0; // C
    const assetCode = normalizeText(r[4] || "").toUpperCase(); // E
    const category = normalizeText(r[6] || ""); // G
    const monthKey = normalizeText(r[9] || ""); // J

    if (targetAsset && assetCode !== targetAsset) continue;

    if (monthKey === targetMonth) {
      if (type === "รับ") monthIncome += amount;
      if (type === "จ่าย") monthExpense += amount;
    }

    // ค่าเช่าสะสม: นับเฉพาะ asset ที่เลือก (และเป็นรับ/หมวดค่าเช่า)
    if (targetAsset) {
      if (type === "รับ" && category === "ค่าเช่า") {
        rentCount += 1;
        rentTotal += amount;
      }
    }
  }

  return {
    income: monthIncome,
    expense: monthExpense,
    net: monthIncome - monthExpense,
    rentCount,
    rentTotal,
  };
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
      const text = normalizeText(event.message.text);
      const timeData = getThaiDateTime(); // ✅ มี dateOnly แล้ว

      // 1) SUMMARY: "สรุป 2026-03" หรือ "สรุป 2026-03 @C1"
      const sumMatch = text.match(/^สรุป\s+(\d{4}-\d{2})(?:\s+(@[A-Za-z0-9\-]+))?\s*$/i);
      if (sumMatch) {
        const targetMonth = sumMatch[1];
        const targetAsset = sumMatch[2] ? normalizeText(sumMatch[2]).toUpperCase() : "";

        try {
          const s = await buildSummary(targetMonth, targetAsset);

          if (targetAsset) {
            const reply =
              `📊 สรุปยอด ${targetAsset}\n` +
              `📅 เดือน: ${targetMonth}\n` +
              `🟢 รับ: ${money(s.income)} บาท\n` +
              `🔴 จ่าย: ${money(s.expense)} บาท\n` +
              `💰 สุทธิ: ${money(s.net)} บาท\n` +
              `🏠 ชำระค่าเช่าสะสม: ${s.rentCount} งวด\n` +
              `💰 รวมยอดเงิน: ${money(s.rentTotal)} บาท`;

            await client.replyMessage({
              replyToken: event.replyToken,
              messages: [{ type: "text", text: reply }],
            });
          } else {
            const reply =
              `📊 สรุปยอด ภาพรวม\n` +
              `📅 เดือน: ${targetMonth}\n` +
              `🟢 รับรวม: ${money(s.income)} บาท\n` +
              `🔴 จ่ายรวม: ${money(s.expense)} บาท\n` +
              `💰 สุทธิ: ${money(s.net)} บาท`;

            await client.replyMessage({
              replyToken: event.replyToken,
              messages: [{ type: "text", text: reply }],
            });
          }
        } catch (err) {
          console.error("SUMMARY ERROR:", err);
          await client.replyMessage({
            replyToken: event.replyToken,
            messages: [{ type: "text", text: "สรุปไม่สำเร็จ ❌ กรุณาเช็ค Railway Logs (SUMMARY ERROR)" }],
          });
        }

        continue;
      }

      // 2) RECORD: "รับ/จ่าย ..."
      // รองรับ: @AssetCode, #PaymentMethod, *Ref (อยู่ตรงไหนก็ได้)
      const m = text.match(/^(รับ|จ่าย)\s*(\d+(?:\.\d+)?)\s*(.+)$/i);
      if (!m) {
        await client.replyMessage({
          replyToken: event.replyToken,
          messages: [{
            type: "text",
            text:
              "รูปแบบบันทึก:\n" +
              "รับ 5000 ค่าเช่า ห้อง 278/136 @C1 #โอน *SCB001\n" +
              "จ่าย 120.5 ค่าน้ำ @C1 #เงินสด *BILL01\n\n" +
              "สรุป:\nสรุป 2026-03\nสรุป 2026-03 @C1",
          }],
        });
        continue;
      }

      const type = m[1];
      const amountStr = m[2];
      const detailAll = m[3] || "";
      const amount = parseFloat(amountStr);

      // tokens
      const assetMatch = detailAll.match(/(@[A-Za-z0-9\-]+)/);
      const payMatch = detailAll.match(/#([^\s*@#]+)/);
      const refMatch = detailAll.match(/\*([^\s*@#]+)/);

      const assetCode = assetMatch ? normalizeText(assetMatch[1]).toUpperCase() : "";
      const paymentMethod = payMatch ? normalizeText(payMatch[1]) : "";
      const ref = refMatch ? normalizeText(refMatch[1]) : "";

      // clean detail
      const cleanDetail = normalizeText(
        detailAll
          .replace(/(@[A-Za-z0-9\-]+)/g, "")
          .replace(/#([^\s*@#]+)/g, "")
          .replace(/\*([^\s*@#]+)/g, "")
      );

      // lookup
      const assetMap = await loadAssetsIfNeeded();
      const asset = assetCode ? assetMap.get(assetCode) : null;

      // ถ้าทรัพย์ถูกปิด (Active FALSE) ให้เตือนและไม่บันทึก
      if (asset && String(asset.active).toUpperCase() === "FALSE") {
        await client.replyMessage({
          replyToken: event.replyToken,
          messages: [{ type: "text", text: `ทรัพย์ ${assetCode} ถูกปิดใช้งาน (Active=FALSE) จึงยังไม่บันทึก ❌` }],
        });
        continue;
      }

      const category = await detectCategory(cleanDetail);
      const room = extractRoom(cleanDetail);

      // DATA columns A:O ตามรูป
      const row = [
        timeData.full,            // A Timestamp
        type,                     // B Type
        amount,                   // C Amount
        cleanDetail,              // D Detail
        assetCode,                // E AssetCode
        asset?.assetName || "",   // F AssetName
        category,                 // G Category
        room,                     // H Room
        asset?.project || "",     // I Project
        timeData.monthKey,        // J Month (YYYY-MM)
        userId,                   // K User
        paymentMethod,            // L PaymentMethod
        ref,                      // M Ref
        asset?.owner || "",       // N Owner
        asset?.assetNote || "",   // O AssetNote
      ];

      await appendDataRow(row);

      // ✅ reply format + เพิ่มวันชำระ
      let reply =
        `บันทึกแล้ว ✅\n` +
        `${type} ${money(amount)} บาท\n` +
        `วันชำระ: ${timeData.dateOnly}\n` +   // ✅ เพิ่มบรรทัดนี้
        `${category}\n` +
        `ทรัพย์: ${assetCode ? `${assetCode}${asset?.assetName ? ` (${asset.assetName})` : ""}` : "(ยังไม่ระบุ)"}`;

      if (asset?.owner) reply += `\nOwner: ${asset.owner}`;
      if (asset?.assetNote) reply += `\nNote: ${asset.assetNote}`;
      if (paymentMethod) reply += `\nPayment: ${paymentMethod}`;
      if (ref) reply += `\nRef: ${ref}`;

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
