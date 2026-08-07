"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const os = require("os");

const BASE = "https://notrack.ai";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const MAX_ATTACH = 4;
const MAX_IMG_BYTES = 20 * 1024 * 1024;
const MAX_DOC_BYTES = 20 * 1024 * 1024;

const PERSONAS = ["normal", "concise", "detailed", "creative"];

// System prompt default untuk persona Archana (Beta)
const ARCHANA_SYSTEM_PROMPT = 
  "[SYSTEM INSTRUCTION: Kamu adalah Archana (beta). Karaktermu tenang, rasional, berwawasan luas, elegan, dan penuh pertimbangan. Jawablah pengguna dengan bahasa yang sopan, lugas, dan terstruktur tanpa terburu-buru, kemudian kamu adalah assistant yang bisa di ajak bicara dan juga bisa di ajak ngoding bareng, pencipta kamu adalah KyuuDevs.]\n\n";

const JAR = path.join(os.tmpdir(), "notrack_cookies_" + os.userInfo().username + ".txt");
let cookieCache = null;

function saveCookie(cookieHeader) {
  cookieCache = cookieHeader || cookieCache;
  if (cookieCache) {
    try { fs.writeFileSync(JAR, cookieCache, "utf8"); } catch (e) { /* ignore */ }
  }
}

function loadCookie() {
  if (cookieCache) return cookieCache;
  try { cookieCache = fs.readFileSync(JAR, "utf8").trim() || null; } catch (e) { cookieCache = null; }
  return cookieCache;
}

async function ensureSession() {
  if (loadCookie()) return;
  const r = await fetch(BASE + "/chat", { headers: { "User-Agent": UA, "Cache-Control": "no-cache" }, redirect: "follow" });
  const sc = (r.headers.get("set-cookie") || "").split(",").map(s => s.split(";")[0].trim()).filter(Boolean).join("; ");
  saveCookie(sc);
  if (!sc) throw new Error("Gagal memperoleh cookie session dari " + BASE + "/chat");
}

async function request(pathname, opts = {}) {
  await ensureSession();
  const headers = Object.assign({ "User-Agent": UA }, opts.headers || {});
  if (loadCookie()) headers.Cookie = loadCookie();
  const r = await fetch(BASE + pathname, Object.assign({}, opts, { headers }));
  const sc = (r.headers.get("set-cookie") || "").split(",").map(s => s.split(";")[0].trim()).filter(Boolean).join("; ");
  if (sc) saveCookie(sc);
  return r;
}

function detectImage(filePath) {
  const buf = fs.readFileSync(filePath);
  const head = buf.subarray(0, 16);
  if (head.length < 8) return null;
  if (head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) return "png";
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "jpeg";
  if (head.toString("ascii", 0, 6) === "GIF87a" || head.toString("ascii", 0, 6) === "GIF89a") return "gif";
  if (head.toString("ascii", 0, 4) === "RIFF" && head.toString("ascii", 8, 12) === "WEBP") return "webp";
  if (head.toString("ascii", 0, 3) === "BM ") return "bmp";
  return null;
}

function imgSize(filePath) {
  const buf = fs.readFileSync(filePath);
  if (detectImage(filePath) === "png" && buf.length >= 24) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (detectImage(filePath) === "jpeg") {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i++; continue; }
      const marker = buf[i + 1];
      if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
      const len = buf.readUInt16BE(i + 2);
      if (marker === 0xc0 || marker === 0xc2) {
        return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) };
      }
      i += 2 + len;
    }
  }
  return null;
}

async function upload(filePath) {
  const name = path.basename(filePath);
  const buf = fs.readFileSync(filePath);
  const kind = detectImage(filePath) ? "image" : "file";
  const cap = kind === "image" ? MAX_IMG_BYTES : MAX_DOC_BYTES;
  if (buf.length > cap) throw new Error(name + " terlalu besar (" + buf.length + " B > " + cap + " B)");
  const fd = new FormData();
  fd.append("file", new Blob([buf], { type: kind === "image" ? "image/" + detectImage(filePath) : "application/octet-stream" }), name);
  const r = await request("/api/upload", { method: "POST", body: fd });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || data.status === "error") throw new Error("Upload gagal: " + (data.error || "HTTP " + r.status));
  return data;
}

async function uploadMany(filePaths) {
  if (filePaths.length > MAX_ATTACH) throw new Error("Maksimal " + MAX_ATTACH + " file per pesan");
  const out = [];
  for (const p of filePaths) out.push(await upload(p));
  return out;
}

async function dispatch({ 
  user_input, 
  persona = "normal", 
  chat_id = null, 
  attachments = [], 
  max_turns = 6, 
  regenerate = false, 
  edit = false, 
  edit_mid = null, 
  use_archana_persona = true,
  onEvent = null, 
  signal = null 
}) {
  if (!PERSONAS.includes(persona)) throw new Error("Persona harus salah satu dari: " + PERSONAS.join(", "));
  
  // Sisipkan instruksi Archana apabila ini adalah percakapan baru atau diminta secara eksplisit
  let finalInput = user_input;
  if (use_archana_persona && (!chat_id || chat_id === "")) {
    finalInput = ARCHANA_SYSTEM_PROMPT + user_input;
  }

  const body = {
    user_input: finalInput, 
    mode: "usual", 
    model: "C", 
    persona,
    max_turns, 
    chat_id, 
    attachments,
    regenerate, 
    edit, 
    edit_mid,
  };

  const r = await request("/api/dispatch", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });

  if (!r.ok && !(r.headers.get("content-type") || "").includes("text/event-stream")) {
    const txt = await r.text().catch(() => "");
    throw new Error("HTTP " + r.status + " " + txt.slice(0, 300));
  }

  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const result = { chat_id: null, mode: null, events: [], deltas: [], messages: [], full: "", done: false, error: null };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      for (const line of block.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload) continue;
        let ev;
        try { ev = JSON.parse(payload); } catch (e) { continue; }
        result.events.push(ev);
        if (ev.type === "chat_meta") { result.chat_id = ev.chat_id; result.mode = ev.mode; }
        if (ev.type === "delta") result.deltas.push(ev.chunk);
        if (ev.type === "message") { result.messages.push(ev); result.full = ev.content; }
        if (ev.type === "done") result.done = true;
        if (onEvent) onEvent(ev);
      }
    }
  }
  return result;
}

async function listChats() {
  const r = await request("/api/chats");
  if (!r.ok) throw new Error("HTTP " + r.status);
  const data = await r.json();
  return data.chats || [];
}

async function getChat(chatId) {
  const r = await request("/api/chat?id=" + encodeURIComponent(chatId));
  if (!r.ok) throw new Error("HTTP " + r.status);
  return r.json();
}

async function deleteChat(chatId) {
  const r = await request("/api/chat?id=" + encodeURIComponent(chatId), { method: "DELETE" });
  if (!r.ok) throw new Error("HTTP " + r.status);
  return true;
}

function formatAttachment(a) {
  const line = "- " + a.name + "  [" + a.kind + "]";
  if (a.kind === "image" && a.preview) return line + "\n  ocr: " + a.preview.slice(0, 200) + (a.preview.length > 200 ? "…" : "");
  if (a.extraction && a.extraction.chars != null) return line + "\n  text: " + String(a.extraction.chars) + " chars, token ~" + a.extraction.token_estimate;
  return line;
}

function renderChat(chat) {
  let out = "";
  for (const m of chat.messages || []) {
    const who = m.speaker === "user" ? "👤 You" : (m.speaker === "C" ? "🤖 Archana (beta)" : "🤖 " + m.speaker);
    out += "\n" + who + "  (" + m.type + ", turn " + m.turn + ")\n";
    if (m.attachments && m.attachments.length) out += m.attachments.map(formatAttachment).join("\n") + "\n";
    out += m.content + "\n";
  }
  return out.trim();
}

function emit(obj) {
  process.stdout.write(JSON.stringify(obj, null, 2) + "\n");
}

async function main() {
  const [,, cmd, ...rest] = process.argv;
  const args = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a.startsWith("--")) {
      const k = a.slice(2);
      args[k] = rest[i + 1] !== undefined && !rest[i + 1].startsWith("--") ? rest[i + 1] : true;
      if (typeof args[k] === "string") i++;
    }
  }
  const positional = rest.filter(a => !a.startsWith("--"));

  try {
    if (!cmd) {
      emit({
        ok: true,
        command: "help",
        model_available: ["Archana (beta)"],
        usage: [
          "node notrack.js ask \"<pesan>\" [--style normal|concise|detailed|creative] [--file a.jpg,b.txt] [--chat <id>]",
          "node notrack.js upload <file> [--caption \"<teks>\"] [--style <style>]",
          "node notrack.js list",
          "node notrack.js history <chat_id>",
          "node notrack.js delete <chat_id>",
        ],
      });
      return;
    }

    if (cmd === "ask") {
      const files = String(args.file || "").split(",").map(s => s.trim()).filter(Boolean);
      let text = (args.text || positional[0] || "").trim();
      let autoCaption = false;
      if (!text && files.length) {
        const imgOnly = files.every(f => detectImage(f));
        text = imgOnly
          ? "Apa isi dari gambar ini? Analisis dan jelaskan isinya secara tenang dan rinci."
          : "Analisis file yang saya lampirkan dan ringkas isinya.";
        autoCaption = true;
      }
      if (!text) throw new Error("Pesan kosong: berikan teks atau parameter --file");
      const style = args.style || "normal";
      if (!PERSONAS.includes(style)) throw new Error("Style harus salah satu dari: " + PERSONAS.join(" | "));
      const chatId = args.chat || null;
      let uploaded = [];
      let attachments = [];
      if (files.length) {
        const ups = await uploadMany(files);
        uploaded = ups;
        attachments = ups.map(u => u.file_id);
      }
      const res = await dispatch({
        user_input: text, persona: style, chat_id: chatId, attachments,
        onEvent: (ev) => { if (ev.type === "delta") process.stderr.write(ev.chunk); },
      });
      process.stderr.write("\n");
      emit({
        ok: true,
        command: "ask",
        model: "Archana (beta)",
        chat_id: res.chat_id,
        style,
        persona: style,
        auto_caption: autoCaption,
        user_input: text,
        attachments: uploaded.map(u => ({ name: u.name, file_id: u.file_id, kind: u.kind, ocr_chars: u.extraction && u.extraction.chars != null ? u.extraction.chars : null })),
        response: res.full,
        messages: res.messages,
        done: res.done,
      });
      return;
    }

    if (cmd === "list") {
      const chats = await listChats();
      emit({ ok: true, command: "list", total: chats.length, chats });
      return;
    }

    if (cmd === "history") {
      const id = args.id || positional[0];
      if (!id) throw new Error("Membutuhkan parameter chat_id");
      const data = await getChat(id);
      emit({ ok: true, command: "history", chat: data.chat, messages: data.messages });
      return;
    }

    if (cmd === "delete") {
      const id = args.id || positional[0];
      if (!id) throw new Error("Membutuhkan parameter chat_id");
      await deleteChat(id);
      emit({ ok: true, command: "delete", deleted: true, chat_id: id });
      return;
    }

    if (cmd === "upload") {
      const file = args.file || positional[0];
      if (!file) throw new Error("Membutuhkan path file");
      const caption = args.caption || positional[1] || null;
      const info = await upload(file);
      const payload = {
        ok: true,
        command: "upload",
        name: info.name,
        file_id: info.file_id,
        kind: info.kind,
        detected: detectImage(file),
        mime: info.mime,
        bytes: info.bytes,
        sha256: info.sha256,
        extraction: info.extraction || null,
        preview: info.preview || null,
      };
      if (caption) {
        const style = args.style || "normal";
        if (!PERSONAS.includes(style)) throw new Error("Style harus salah satu dari: " + PERSONAS.join(" | "));
        const res = await dispatch({
          user_input: caption, persona: style, attachments: [info.file_id],
          onEvent: (ev) => { if (ev.type === "delta") process.stderr.write(ev.chunk); },
        });
        process.stderr.write("\n");
        payload.caption = caption;
        payload.chat_id = res.chat_id;
        payload.response = res.full;
        payload.done = res.done;
      }
      emit(payload);
      return;
    }

    emit({ ok: false, error: "Perintah tidak dikenal: " + cmd });
    process.exit(1);
  } catch (e) {
    emit({ ok: false, error: e.message });
    process.exit(1);
  }
}

module.exports = { 
  PERSONAS, 
  ARCHANA_SYSTEM_PROMPT, 
  ensureSession, 
  upload, 
  uploadMany, 
  dispatch, 
  listChats, 
  getChat, 
  deleteChat, 
  detectImage, 
  imgSize, 
  renderChat 
};

if (require.main === module) main();
