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

/* =====================
   ASSETS (รหัสทรัพย์ของคุณ)
===================== */
const ASSETS = {
  H1: { type: "บ้าน", name: "แกรนด์พลีโน่ 59/90" },
  C1: { type: "คอนโด", name: "Unio72-2 278/136" },
  C2: { type: "คอนโด", name: "Regent Home 22 75/5" },
};

/* =====================
   CATEGORY RULES
===================== */
function detectCategory(text) {
  const t = text.toLowerCase();

  // รายรับ
  if (t.includes("ค่าเช่า")) return "ค่าเช่า";
  if (t.includes("ค่าจอดรถ")) return "ค่าจอดรถ";
  if (t.includes("ค่าปรับ")) return "ค่าปรับ";

  // รายจ่าย
  if (t.includes("ค่าน้ำ")) return "ค่าน้ำ";
  if (t.includes("ค่าไฟ")) return "ค่าไฟ";
  if (t.includes("ค่าส่วนกลาง")) return "ค่าส่วนกลาง";
  if (t.includes("อินเทอร์เน็ต") || t.includes("เน็ตทรู") || t.includes("ais") || t.includes("true"))
    return "อินเทอร์เน็ต";
  if (t.includes("ซ่อม") || t.includes("ช่าง") || t.includes("อะไหล่")) return "ซ่อมบำรุง";
  if (t.includes("ทำความสะอาด") || t.includes("แม่บ้าน")) return "ทำความสะอาด";
  if (t.includes("เฟอร์") || t.includes("ของใช้")) return "เฟอร์นิเจอร์/ของใช้";
  if (t.includes("ภาษี") || t.includes("ประกัน")) return "ภาษี/ประกัน";
  if (t.includes("ค่าธรรมเนียม") || t.includes("fee")) return "ค่าธรรมเนียม";

  return "อื่นๆ";
}

/* =====================
   GOOGLE SHEET
===================== */
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;

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

async function appendToSheet(row) {
  if (!SPREADSHEET_ID) throw new Error("Missing SPREADSHEET_ID");

  // ✅ ใช้ชื่อแท็บ DATA ตามของคุณ
  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: "DATA!A:K",
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [row] },
  });
}

/* =====================
   PARSER: "รับ 5000 ค่าเช่า ห้อง101 @C1"
===================== */
function normalizeText(s = "") {
  return s.replace(/\u00A0/g, " ").replace(/\s+/g, " ").trim();
}

function parseMessage(text) {
  const t = normalizeText(text);

  // จับ @AssetCode ท้ายบรรทัด
  const assetMatch = t.match(/@([A-Za-z0-9]+)\s*$/);
  if (!assetMatch) return { ok: false, reason: "missing_asset" };

  const assetCode = assetMatch[1].toUpperCase();
  const asset = ASSETS[assetCode];
  if (!asset) return { ok: false, reason: "unknown_asset" };

  // ตัด @xxx ออก
  const withoutAsset = t.replace(/@([A-Za-z0-9]+)\s*$/, "").trim();

  // จับ type + amount + detail
  const m = withoutAsset.match(/^(รับ|จ่าย)\s*(\d+(?:\.\d+)?)\s*(.+)$/);
  if (!m) return { ok: false, reason: "bad_format" };

  const type = m[1];
  const amount = Number(m[2]);
  const detail = m[3].trim();
  const category = detectCategory(detail);

  return { ok: true, type, amount, detail, category, assetCode, assetName: asset.name };
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

      const text = event.message.text || "";
      const parsed = parseMessage(text);

      if (!parsed.ok) {
        let msg = "รูปแบบไม่ถูกต้อง ❌\n\nตัวอย่าง:\nรับ 5000 ค่าเช่า ห้อง101 @C1\nจ่าย 1200 ค่าน้ำ @H1\n\nรหัสทรัพย์: @H1 @C1 @C2";
        if (parsed.reason === "unknown_asset") msg = "ไม่รู้จักรหัสทรัพย์ ❌\nใช้ได้แค่ @H1 @C1 @C2";
        if (parsed.reason === "missing_asset") msg = "ต้องใส่รหัสทรัพย์ท้ายข้อความ ❌\nเช่น @H1 หรือ @C1 หรือ @C2";
        await client.replyMessage({
          replyToken: event.replyToken,
          messages: [{ type: "text", text: msg }],
        });
        continue;
      }

      const now = new Date();
      const monthKey = toMonthKey(now);
      const ts = now.toLocaleString("th-TH");

      const income = parsed.type === "รับ" ? parsed.amount : 0;
      const expense = parsed.type === "จ่าย" ? parsed.amount : 0;
      const net = income - expense;

      // A-K ตามแบบที่ออกแบบไว้
      const row = [
        ts,                     // A Timestamp
        parsed.type,            // B Type
        parsed.amount,          // C Amount
        parsed.assetCode,       // D AssetCode
        parsed.assetName,       // E AssetName
        parsed.category,        // F Category
        parsed.detail,          // G Detail
        monthKey,               // H Month
        income,                 // I Income
        expense,                // J Expense
        net,                    // K Net
      ];

      await appendToSheet(row);

      await client.replyMessage({
        replyToken: event.replyToken,
        messages: [
          {
            type: "text",
            text:
              `บันทึกแล้ว ✅\n` +
              `${parsed.assetCode} (${parsed.assetName})\n` +
              `${parsed.type} ${parsed.amount} บาท\n` +
              `หมวด: ${parsed.category}\n` +
              `${parsed.detail}`,
          },
        ],
      });
    }
  } catch (e) {
    console.error("WEBHOOK ERROR:", e);
  }
});

app.get("/", (req, res) => res.send("OK"));

const PORT = process.env.PORT || 8080;
app.listen(PORT, "0.0.0.0", () => console.log("Server running on", PORT));
