"use strict";

const express = require("express");
const path = require("path");
const multer = require("multer");
const notrack = require("./notrack");

const app = express();
const PORT = process.env.PORT || 3000;

// Setup direktori upload sementara
const upload = multer({ dest: "uploads/" });

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// Endpoint mendapatkan daftar model
app.get("/api/models", (req, res) => {
  res.json({
    ok: true,
    models: [
      { id: "archana-beta", name: "Archana (beta)", status: "Active", description: "Model utama dengan kepribadian tenang & elegan." }
    ]
  });
});

// Endpoint streaming chat
app.post("/api/chat", async (req, res) => {
  const { prompt, chatId, style, attachments } = req.body;

  if (!prompt && (!attachments || !attachments.length)) {
    return res.status(400).json({ ok: false, error: "Pesan tidak boleh kosong." });
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  try {
    await notrack.dispatch({
      user_input: prompt || "Analisis file ini.",
      persona: style || "normal",
      chat_id: chatId || null,
      attachments: attachments || [],
      use_archana_persona: true,
      onEvent: (ev) => {
        res.write(`data: ${JSON.stringify(ev)}\n\n`);
      }
    });
    res.end();
  } catch (err) {
    res.write(`data: ${JSON.stringify({ type: "error", error: err.message })}\n\n`);
    res.end();
  }
});

// Endpoint upload file dari frontend
app.post("/api/upload", upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ ok: false, error: "Tidak ada file diunggah." });
  try {
    const info = await notrack.upload(req.file.path);
    res.json({ ok: true, file_id: info.file_id, name: info.name, kind: info.kind });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Endpoint riwayat chat
app.get("/api/chats", async (req, res) => {
  try {
    const chats = await notrack.listChats();
    res.json({ ok: true, chats });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`[Archana AI System] Berjalan di http://localhost:${PORT}`);
});
