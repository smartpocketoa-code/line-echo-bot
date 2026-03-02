/* =====================
   WEBHOOK (ส่วนที่ปรับปรุงการตอบกลับและชื่อหัวข้อ)
===================== */
app.post("/webhook", line.middleware(config), async (req, res) => {
  res.status(200).end();

  try {
    const events = req.body?.events || [];
    for (const event of events) {
      if (event.type !== "message" || event.message.type !== "text") continue;

      const userId = event.source?.userId || "";
      const text = normalizeText(event.message.text || "");

      // รูปแบบ: "รับ 5000 ค่าเช่า @C1"
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
      
      // สร้างรูปแบบวันที่สำหรับแสดงผลใน LINE
      const timestampThai = now.toLocaleString("th-TH", {
        year: "numeric",
        month: "long",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });

      let assetName = "";
      let project = "";
      let owner = "";
      let assetType = ""; 
      let active = true;

      if (assetCode) {
        const asset = await lookupAsset(assetCode);
        if (asset) {
          assetName = asset.fullName || "";
          project = asset.projectName || "";
          owner = asset.owner || "";
          assetType = asset.assetType || ""; 
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

      // บันทึกลง Google Sheets (ใช้ค่า timestampThai เพื่อให้อ่านง่ายในชีตด้วย)
      const row = [
        timestampThai, // A Timestamp
        type,          // B Type
        amount,        // C Amount
        detail,        // D Detail
        assetCode,     // E AssetCode
        assetName,     // F AssetName
        category,      // G Category
        room,          // H Room
        project,       // I Project
        monthKey,      // J Month
        userId,        // K User
      ];

      await appendToDataRow(row);

      // --- สร้างข้อความตอบกลับตามเงื่อนไขใหม่ ---
      let reply = `บันทึกแล้ว ✅\n`;
      reply += `${type} ${amount.toLocaleString()} บาท\n`;
      reply += `รายการ: ${category}\n`;
      reply += assetCode 
        ? `รหัสทรัพย์: ${assetCode}${assetName ? ` (${assetName})` : ""}\n` 
        : `รหัสทรัพย์: (ยังไม่ระบุ)\n`;

      if (owner) reply += `ผู้ชำระเงิน: ${owner}\n`;
      if (assetType) reply += `ประเภททรัพย์สิน: ${assetType}\n`;
      
      // เพิ่มบรรทัดวันที่ชำระ (รับชำระเมื่อ)
      reply += `รับชำระเมื่อ: ${timestampThai}`;

      await client.replyMessage({
        replyToken: event.replyToken,
        messages: [{ type: "text", text: reply.trim() }],
      });
    }
  } catch (e) {
    console.error("WEBHOOK ERROR:", e);
  }
});
