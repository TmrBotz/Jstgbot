/**
 * ============================================================
 *  Telegram File Store Bot — Cloudflare Workers
 *  Production-grade | Webhook-based | KV-backed
 * ============================================================
 */

// ─── Constants ────────────────────────────────────────────────────────────────

const TG_API = (token) => `https://api.telegram.org/bot${token}`;
const TG_FILE = (token) => `https://api.telegram.org/file/bot${token}`;

const SESSION_TTL = 3600; // 1 hour session expiry (seconds)
const RATE_LIMIT_WINDOW = 60; // 60 seconds
const RATE_LIMIT_MAX = 20; // max requests per window

// ─── Main Entry Point ─────────────────────────────────────────────────────────

export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);
      const path = url.pathname;

      // ── Webhook endpoint
      if (request.method === "POST" && path === "/webhook") {
        return await handleWebhook(request, env);
      }

      // ── File serving routes
      if (request.method === "GET" && path.startsWith("/file/")) {
        const fileId = path.replace("/file/", "").trim();
        return await serveFile(fileId, env, url);
      }

      if (request.method === "GET" && path.startsWith("/batch/")) {
        const batchId = path.replace("/batch/", "").trim();
        return await serveBatch(batchId, env, url);
      }

      // ── Health check
      if (path === "/ping") {
        return jsonResponse({ ok: true, status: "alive" });
      }

      return new Response("Not Found", { status: 404 });
    } catch (err) {
      console.error("Top-level error:", err);
      return new Response("Internal Server Error", { status: 500 });
    }
  },
};

// ─── Webhook Handler ──────────────────────────────────────────────────────────

async function handleWebhook(request, env) {
  // Validate secret token
  const secretHeader = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
  if (env.WEBHOOK_SECRET && secretHeader !== env.WEBHOOK_SECRET) {
    return new Response("Unauthorized", { status: 401 });
  }

  let update;
  try {
    update = await request.json();
  } catch {
    return new Response("Bad Request", { status: 400 });
  }

  // Process update asynchronously
  const ctx = { waitUntil: () => {} }; // workers ctx not available here
  await processUpdate(update, env);

  return new Response("OK");
}

// ─── Update Router ────────────────────────────────────────────────────────────

async function processUpdate(update, env) {
  try {
    if (update.message) {
      await handleMessage(update.message, env);
    } else if (update.callback_query) {
      await handleCallbackQuery(update.callback_query, env);
    }
  } catch (err) {
    console.error("processUpdate error:", err);
  }
}

// ─── Message Handler ──────────────────────────────────────────────────────────

async function handleMessage(msg, env) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const text = msg.text || "";

  // Rate limiting
  if (await isRateLimited(userId, env)) {
    await sendMessage(env, chatId, "⚠️ You are sending too many requests. Please wait a moment.");
    return;
  }

  // Register user
  await registerUser(msg.from, env);

  // ── Deep link / start param
  if (text.startsWith("/start")) {
    const parts = text.split(" ");
    if (parts[1]) {
      return await handleStartParam(parts[1], chatId, userId, env);
    }
    return await handleStart(msg, env);
  }

  // ── Force subscribe check
  if (!(await checkForceSub(userId, env))) {
    return await sendForceSubMessage(chatId, env);
  }

  // ── Commands
  if (text === "/genlink" || text === `/genlink@${env.BOT_USERNAME}`) {
    return await handleGenLink(msg, env);
  }
  if (text === "/batch" || text === `/batch@${env.BOT_USERNAME}`) {
    return await handleBatch(msg, env);
  }
  if (text === "/done" || text === `/done@${env.BOT_USERNAME}`) {
    return await handleDone(msg, env);
  }
  if (text === "/cancel" || text === `/cancel@${env.BOT_USERNAME}`) {
    return await handleCancel(msg, env);
  }
  if (text.startsWith("/broadcast")) {
    return await handleBroadcast(msg, env);
  }
  if (text === "/stats" || text === `/stats@${env.BOT_USERNAME}`) {
    return await handleStats(msg, env);
  }
  if (text.startsWith("/delete ")) {
    return await handleDeleteFile(msg, env);
  }
  if (text.startsWith("/ban ")) {
    return await handleBanUser(msg, env);
  }
  if (text === "/users" || text === `/users@${env.BOT_USERNAME}`) {
    return await handleListUsers(msg, env);
  }

  // ── File handling (based on session state)
  if (hasFileContent(msg)) {
    return await handleFileUpload(msg, env);
  }

  // Default
  await sendMessage(env, chatId, "❓ Unknown command. Use /start for help.");
}

// ─── /start ───────────────────────────────────────────────────────────────────

async function handleStart(msg, env) {
  const { chat, from } = msg;
  const name = from.first_name || "there";
  const keyboard = {
    inline_keyboard: [
      [
        { text: "📁 Generate Link", callback_data: "cmd_genlink" },
        { text: "📦 Batch Upload", callback_data: "cmd_batch" },
      ],
      [
        { text: "📊 My Stats", callback_data: "cmd_stats" },
        { text: "ℹ️ Help", callback_data: "cmd_help" },
      ],
    ],
  };

  const welcomeText =
    `🗂 *Welcome to FileStore Bot, ${escapeMarkdown(name)}!*\n\n` +
    `Store and share files permanently with powerful features:\n\n` +
    `📁 */genlink* — Upload a file & get a shareable link\n` +
    `📦 */batch* — Upload multiple files under one link\n` +
    `📊 */stats* — View bot statistics\n\n` +
    `Your files are stored permanently and links never expire! 🔒`;

  await sendMessage(env, chat.id, welcomeText, { parse_mode: "Markdown", reply_markup: keyboard });
}

// ─── Deep Link Handler ────────────────────────────────────────────────────────

async function handleStartParam(param, chatId, userId, env) {
  // Force sub check
  if (!(await checkForceSub(userId, env))) {
    return await sendForceSubMessage(chatId, env);
  }

  if (param.startsWith("file_")) {
    const fileUid = param.replace("file_", "");
    const fileData = await getFile(fileUid, env);
    if (!fileData) {
      return await sendMessage(env, chatId, "❌ File not found or has been deleted.");
    }
    return await sendFileToUser(chatId, fileData, fileUid, env);
  }

  if (param.startsWith("batch_")) {
    const batchUid = param.replace("batch_", "");
    const batchData = await getBatch(batchUid, env);
    if (!batchData) {
      return await sendMessage(env, chatId, "❌ Batch not found or has been deleted.");
    }
    const workerUrl = env.WORKER_URL || "https://yourbot.workers.dev";
    const batchLink = `${workerUrl}/batch/${batchUid}`;
    await sendMessage(
      env,
      chatId,
      `📦 *Batch Link*\n\n` +
        `Files: *${batchData.files.length}*\n` +
        `Created: ${formatDate(batchData.timestamp)}\n\n` +
        `🔗 [Open Batch Page](${batchLink})`,
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [[{ text: "📂 View Batch", url: batchLink }]],
        },
      }
    );
    return;
  }

  // Fallback to normal start
  await handleStart({ chat: { id: chatId }, from: { id: userId, first_name: "User" } }, env);
}

// ─── /genlink ─────────────────────────────────────────────────────────────────

async function handleGenLink(msg, env) {
  const { chat, from } = msg;
  await setSession(from.id, { state: "awaiting_file", mode: "genlink" }, env);
  await sendMessage(
    env,
    chat.id,
    "📎 *Send me a file* to generate a permanent link.\n\nSupported: documents, videos, photos, audio.\n\n/cancel to abort.",
    {
      parse_mode: "Markdown",
      reply_markup: { inline_keyboard: [[{ text: "❌ Cancel", callback_data: "cmd_cancel" }]] },
    }
  );
}

// ─── /batch ───────────────────────────────────────────────────────────────────

async function handleBatch(msg, env) {
  const { chat, from } = msg;
  await setSession(from.id, { state: "batch_collecting", mode: "batch", files: [] }, env);
  await sendMessage(
    env,
    chat.id,
    "📦 *Batch mode activated!*\n\nSend multiple files one by one.\nWhen done, send /done to generate the batch link.\n\n/cancel to abort.",
    {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [
            { text: "✅ Done", callback_data: "cmd_done" },
            { text: "❌ Cancel", callback_data: "cmd_cancel" },
          ],
        ],
      },
    }
  );
}

// ─── /done ────────────────────────────────────────────────────────────────────

async function handleDone(msg, env) {
  const { chat, from } = msg;
  const session = await getSession(from.id, env);

  if (!session || session.mode !== "batch") {
    return await sendMessage(env, chat.id, "⚠️ You are not in batch mode. Use /batch first.");
  }

  if (!session.files || session.files.length === 0) {
    return await sendMessage(env, chat.id, "⚠️ No files received yet. Send some files first.");
  }

  // Store batch
  const batchId = generateUID();
  const batchData = {
    id: batchId,
    files: session.files,
    createdBy: from.id,
    timestamp: Date.now(),
  };

  await saveBatch(batchId, batchData, env);
  await clearSession(from.id, env);

  const workerUrl = env.WORKER_URL || "https://yourbot.workers.dev";
  const batchLink = `${workerUrl}/batch/${batchId}`;
  const deepLink = `https://t.me/${env.BOT_USERNAME}?start=batch_${batchId}`;

  await sendMessage(
    env,
    chat.id,
    `✅ *Batch Created Successfully!*\n\n` +
      `📦 Files: *${session.files.length}*\n` +
      `🆔 Batch ID: \`${batchId}\`\n` +
      `📅 Created: ${formatDate(Date.now())}\n\n` +
      `🔗 *Batch Page:*\n${batchLink}\n\n` +
      `📲 *Deep Link:*\n${deepLink}`,
    {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [{ text: "📂 Open Batch", url: batchLink }],
          [{ text: "📲 Share Link", url: `https://t.me/share/url?url=${encodeURIComponent(batchLink)}` }],
        ],
      },
    }
  );
}

// ─── /cancel ──────────────────────────────────────────────────────────────────

async function handleCancel(msg, env) {
  const { chat, from } = msg;
  await clearSession(from.id, env);
  await sendMessage(env, chat.id, "❌ Operation cancelled.", {
    reply_markup: { remove_keyboard: true },
  });
}

// ─── File Upload Handler ──────────────────────────────────────────────────────

async function handleFileUpload(msg, env) {
  const { chat, from } = msg;
  const session = await getSession(from.id, env);

  if (!session || !["awaiting_file", "batch_collecting"].includes(session.state)) {
    return; // ignore unsolicited files
  }

  // Extract file metadata
  const fileMeta = extractFileMeta(msg);
  if (!fileMeta) {
    return await sendMessage(env, chat.id, "⚠️ Unsupported file type.");
  }

  // Forward/copy to storage channel
  let storageMessageId;
  try {
    storageMessageId = await copyToStorageChannel(msg, env);
  } catch (err) {
    console.error("Storage channel error:", err);
    return await sendMessage(env, chat.id, "❌ Failed to store file. Please try again.");
  }

  // Save file record
  const fileUid = generateUID();
  const fileRecord = {
    uid: fileUid,
    file_id: fileMeta.file_id,
    file_unique_id: fileMeta.file_unique_id,
    storage_message_id: storageMessageId,
    file_name: fileMeta.file_name,
    file_size: fileMeta.file_size,
    mime_type: fileMeta.mime_type,
    type: fileMeta.type,
    caption: msg.caption || null,
    thumbnail: fileMeta.thumbnail || null,
    uploaded_by: from.id,
    timestamp: Date.now(),
  };

  await saveFile(fileUid, fileRecord, env);

  // Increment file count
  await incrementCounter("total_files", env);

  if (session.mode === "genlink") {
    // Single file mode
    await clearSession(from.id, env);
    const workerUrl = env.WORKER_URL || "https://yourbot.workers.dev";
    const fileLink = `${workerUrl}/file/${fileUid}`;
    const deepLink = `https://t.me/${env.BOT_USERNAME}?start=file_${fileUid}`;

    await sendMessage(
      env,
      chat.id,
      `✅ *File Stored Successfully!*\n\n` +
        `📄 *Name:* ${escapeMarkdown(fileMeta.file_name)}\n` +
        `📦 *Size:* ${humanSize(fileMeta.file_size)}\n` +
        `🗂 *Type:* ${fileMeta.type}\n` +
        `🆔 *File ID:* \`${fileUid}\`\n` +
        `📅 *Date:* ${formatDate(Date.now())}\n\n` +
        `🔗 *Download Link:*\n${fileLink}\n\n` +
        `📲 *Deep Link:*\n${deepLink}`,
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "🔗 Open File", url: fileLink }],
            [{ text: "📲 Share", url: `https://t.me/share/url?url=${encodeURIComponent(fileLink)}` }],
          ],
        },
      }
    );
  } else if (session.mode === "batch") {
    // Batch mode — accumulate
    session.files.push({
      uid: fileUid,
      file_name: fileMeta.file_name,
      file_size: fileMeta.file_size,
      type: fileMeta.type,
      mime_type: fileMeta.mime_type,
    });
    await setSession(from.id, session, env);

    await sendMessage(
      env,
      chat.id,
      `✅ File *${escapeMarkdown(fileMeta.file_name)}* added to batch! (${session.files.length} file${session.files.length > 1 ? "s" : ""} total)\n\nSend more files or /done to finish.`,
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [
              { text: "✅ Done", callback_data: "cmd_done" },
              { text: "❌ Cancel", callback_data: "cmd_cancel" },
            ],
          ],
        },
      }
    );
  }
}

// ─── Callback Query Handler ───────────────────────────────────────────────────

async function handleCallbackQuery(query, env) {
  const { id, from, message, data } = query;

  // Answer callback to remove loading spinner
  await answerCallbackQuery(env, id);

  const fakeMsg = { chat: message.chat, from, text: "" };

  switch (data) {
    case "cmd_genlink":
      fakeMsg.text = "/genlink";
      return await handleGenLink(fakeMsg, env);
    case "cmd_batch":
      fakeMsg.text = "/batch";
      return await handleBatch(fakeMsg, env);
    case "cmd_done":
      fakeMsg.text = "/done";
      return await handleDone(fakeMsg, env);
    case "cmd_cancel":
      fakeMsg.text = "/cancel";
      return await handleCancel(fakeMsg, env);
    case "cmd_stats":
      fakeMsg.text = "/stats";
      return await handleStats(fakeMsg, env);
    case "cmd_help":
      return await handleHelp(message.chat.id, env);
    default:
      if (data.startsWith("dl_")) {
        const uid = data.replace("dl_", "");
        return await handleDirectDownload(from.id, message.chat.id, uid, env);
      }
  }
}

// ─── Admin: Broadcast ─────────────────────────────────────────────────────────

async function handleBroadcast(msg, env) {
  const { chat, from } = msg;
  if (!isAdmin(from.id, env)) {
    return await sendMessage(env, chat.id, "⛔ Admin only command.");
  }

  const text = msg.text.replace("/broadcast", "").trim();
  if (!text) {
    return await sendMessage(env, chat.id, "Usage: /broadcast <message>");
  }

  const users = await getAllUsers(env);
  let sent = 0,
    failed = 0;

  for (const userId of users) {
    try {
      await sendMessage(env, userId, text, { parse_mode: "Markdown" });
      sent++;
    } catch {
      failed++;
    }
  }

  await sendMessage(env, chat.id, `📢 Broadcast complete!\n✅ Sent: ${sent}\n❌ Failed: ${failed}`);
}

// ─── Admin: Stats ─────────────────────────────────────────────────────────────

async function handleStats(msg, env) {
  const { chat, from } = msg;

  if (!isAdmin(from.id, env)) {
    // Non-admin sees limited info
    const totalFiles = (await env.KV.get("counter:total_files")) || "0";
    return await sendMessage(
      env,
      chat.id,
      `📊 *Bot Statistics*\n\n` + `📁 Total Files Stored: *${totalFiles}*\n\n_More stats available to admins._`,
      { parse_mode: "Markdown" }
    );
  }

  const totalFiles = (await env.KV.get("counter:total_files")) || "0";
  const totalUsers = (await env.KV.get("counter:total_users")) || "0";
  const totalBatches = (await env.KV.get("counter:total_batches")) || "0";

  await sendMessage(
    env,
    chat.id,
    `📊 *Admin Statistics*\n\n` +
      `👥 Total Users: *${totalUsers}*\n` +
      `📁 Total Files: *${totalFiles}*\n` +
      `📦 Total Batches: *${totalBatches}*\n\n` +
      `🤖 Bot: @${env.BOT_USERNAME}\n` +
      `⚡ Runtime: Cloudflare Workers`,
    { parse_mode: "Markdown" }
  );
}

// ─── Admin: Delete File ───────────────────────────────────────────────────────

async function handleDeleteFile(msg, env) {
  const { chat, from } = msg;
  if (!isAdmin(from.id, env)) {
    return await sendMessage(env, chat.id, "⛔ Admin only command.");
  }

  const uid = msg.text.replace("/delete", "").trim();
  if (!uid) return await sendMessage(env, chat.id, "Usage: /delete <file_uid>");

  const file = await getFile(uid, env);
  if (!file) return await sendMessage(env, chat.id, "❌ File not found.");

  await env.KV.delete(`file:${uid}`);
  await sendMessage(env, chat.id, `✅ File \`${uid}\` deleted.`, { parse_mode: "Markdown" });
}

// ─── Admin: Ban User ──────────────────────────────────────────────────────────

async function handleBanUser(msg, env) {
  const { chat, from } = msg;
  if (!isAdmin(from.id, env)) {
    return await sendMessage(env, chat.id, "⛔ Admin only command.");
  }

  const targetId = msg.text.replace("/ban", "").trim();
  if (!targetId || isNaN(targetId)) return await sendMessage(env, chat.id, "Usage: /ban <user_id>");

  await env.KV.put(`banned:${targetId}`, "1");
  await sendMessage(env, chat.id, `✅ User ${targetId} has been banned.`);
}

// ─── Admin: List Users ────────────────────────────────────────────────────────

async function handleListUsers(msg, env) {
  const { chat, from } = msg;
  if (!isAdmin(from.id, env)) {
    return await sendMessage(env, chat.id, "⛔ Admin only command.");
  }

  const total = (await env.KV.get("counter:total_users")) || "0";
  await sendMessage(env, chat.id, `👥 Total registered users: *${total}*`, { parse_mode: "Markdown" });
}

// ─── Help ─────────────────────────────────────────────────────────────────────

async function handleHelp(chatId, env) {
  await sendMessage(
    env,
    chatId,
    `ℹ️ *FileStore Bot Help*\n\n` +
      `*User Commands:*\n` +
      `/start — Welcome screen\n` +
      `/genlink — Upload 1 file → get permanent link\n` +
      `/batch — Upload multiple files → one batch link\n` +
      `/done — Finalize batch upload\n` +
      `/cancel — Cancel current operation\n\n` +
      `*Admin Commands:*\n` +
      `/stats — View statistics\n` +
      `/broadcast <msg> — Broadcast to all users\n` +
      `/delete <uid> — Delete a file\n` +
      `/ban <user_id> — Ban a user\n` +
      `/users — View user count\n\n` +
      `*Links never expire. Files are permanently stored.*`,
    { parse_mode: "Markdown" }
  );
}

// ─── Direct Download (callback) ───────────────────────────────────────────────

async function handleDirectDownload(userId, chatId, uid, env) {
  const fileData = await getFile(uid, env);
  if (!fileData) return await sendMessage(env, chatId, "❌ File not found.");
  await sendFileToUser(chatId, fileData, uid, env);
}

// ─── Send Stored File to User ─────────────────────────────────────────────────

async function sendFileToUser(chatId, fileData, uid, env) {
  const caption =
    (fileData.caption ? `📝 ${fileData.caption}\n\n` : "") +
    `📄 *${escapeMarkdown(fileData.file_name)}*\n` +
    `📦 ${humanSize(fileData.file_size)}\n` +
    `🗂 ${fileData.type}`;

  const keyboard = {
    inline_keyboard: [
      [
        {
          text: "🔗 Web Link",
          url: `${env.WORKER_URL || "https://yourbot.workers.dev"}/file/${uid}`,
        },
      ],
    ],
  };

  const method = {
    document: "sendDocument",
    video: "sendVideo",
    audio: "sendAudio",
    photo: "sendPhoto",
    voice: "sendVoice",
    animation: "sendAnimation",
  }[fileData.type] || "sendDocument";

  const fileKey = fileData.type === "photo" ? "photo" : fileData.type === "audio" ? "audio" : fileData.type === "voice" ? "voice" : "document";

  await callTgApi(env, method, {
    chat_id: chatId,
    [fileKey]: fileData.file_id,
    caption,
    parse_mode: "Markdown",
    reply_markup: keyboard,
  });
}

// ─── Force Subscribe ──────────────────────────────────────────────────────────

async function checkForceSub(userId, env) {
  if (!env.FORCE_SUB_CHANNELS) return true;

  const channels = env.FORCE_SUB_CHANNELS.split(",").map((c) => c.trim()).filter(Boolean);
  if (channels.length === 0) return true;

  for (const channel of channels) {
    try {
      const res = await callTgApi(env, "getChatMember", {
        chat_id: channel,
        user_id: userId,
      });
      const status = res?.result?.status;
      if (!["member", "administrator", "creator"].includes(status)) {
        return false;
      }
    } catch {
      return false;
    }
  }
  return true;
}

async function sendForceSubMessage(chatId, env) {
  const channels = (env.FORCE_SUB_CHANNELS || "").split(",").map((c) => c.trim()).filter(Boolean);
  const buttons = channels.map((ch) => [{ text: `📢 Join ${ch}`, url: `https://t.me/${ch.replace("@", "")}` }]);
  buttons.push([{ text: "✅ I've Joined", callback_data: "cmd_genlink" }]);

  await sendMessage(
    env,
    chatId,
    `🔒 *Access Required*\n\nYou must join the following channel(s) to use this bot:\n\n${channels.map((c) => `• ${c}`).join("\n")}\n\nAfter joining, tap *I've Joined* below.`,
    {
      parse_mode: "Markdown",
      reply_markup: { inline_keyboard: buttons },
    }
  );
}

// ─── File Serving Routes ──────────────────────────────────────────────────────

async function serveFile(fileUid, env, url) {
  const fileData = await getFile(fileUid, env);

  if (!fileData) {
    return htmlResponse(errorPage("File Not Found", "This file does not exist or has been deleted."), 404);
  }

  // Get download URL from Telegram
  let downloadUrl = null;
  try {
    const tgFile = await callTgApi(env, "getFile", { file_id: fileData.file_id });
    if (tgFile?.result?.file_path) {
      downloadUrl = `${TG_FILE(env.BOT_TOKEN)}/${tgFile.result.file_path}`;
    }
  } catch (err) {
    console.error("getFile error:", err);
  }

  const isVideo = fileData.type === "video" || (fileData.mime_type || "").startsWith("video/");
  const isAudio = fileData.type === "audio" || (fileData.mime_type || "").startsWith("audio/");
  const isImage = fileData.type === "photo" || (fileData.mime_type || "").startsWith("image/");

  return htmlResponse(filePage(fileData, fileUid, downloadUrl, isVideo, isAudio, isImage, env));
}

async function serveBatch(batchId, env, url) {
  const batchData = await getBatch(batchId, env);

  if (!batchData) {
    return htmlResponse(errorPage("Batch Not Found", "This batch does not exist or has been deleted."), 404);
  }

  // Resolve files
  const filesWithData = [];
  for (const f of batchData.files) {
    const fileData = await getFile(f.uid, env);
    if (fileData) {
      let downloadUrl = null;
      try {
        const tgFile = await callTgApi(env, "getFile", { file_id: fileData.file_id });
        if (tgFile?.result?.file_path) {
          downloadUrl = `${TG_FILE(env.BOT_TOKEN)}/${tgFile.result.file_path}`;
        }
      } catch {}
      filesWithData.push({ ...fileData, downloadUrl, uid: f.uid });
    }
  }

  return htmlResponse(batchPage(batchData, batchId, filesWithData, env));
}

// ─── HTML Pages ───────────────────────────────────────────────────────────────

function baseStyles() {
  return `
    :root {
      --bg: #0d0d0f;
      --surface: #16161a;
      --surface2: #1e1e24;
      --border: #2a2a35;
      --accent: #7c3aed;
      --accent2: #a855f7;
      --text: #e2e2e8;
      --muted: #8888a0;
      --success: #22c55e;
      --danger: #ef4444;
      --radius: 12px;
      --shadow: 0 8px 32px rgba(0,0,0,0.4);
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Inter', system-ui, -apple-system, sans-serif;
      background: var(--bg);
      color: var(--text);
      min-height: 100vh;
      line-height: 1.6;
    }
    a { color: var(--accent2); text-decoration: none; }
    a:hover { text-decoration: underline; }
    .container { max-width: 900px; margin: 0 auto; padding: 2rem 1rem; }
    .card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 1.5rem;
      box-shadow: var(--shadow);
    }
    .btn {
      display: inline-flex; align-items: center; gap: 0.5rem;
      padding: 0.65rem 1.4rem;
      border-radius: 8px; border: none; cursor: pointer;
      font-size: 0.9rem; font-weight: 600;
      transition: all 0.2s ease; text-decoration: none !important;
    }
    .btn-primary {
      background: linear-gradient(135deg, var(--accent), var(--accent2));
      color: #fff;
    }
    .btn-primary:hover { opacity: 0.85; transform: translateY(-1px); }
    .btn-outline {
      background: transparent;
      border: 1px solid var(--border);
      color: var(--text);
    }
    .btn-outline:hover { border-color: var(--accent2); color: var(--accent2); }
    .badge {
      display: inline-block; padding: 0.2rem 0.6rem;
      border-radius: 999px; font-size: 0.75rem; font-weight: 600;
    }
    .badge-purple { background: rgba(124,58,237,0.2); color: var(--accent2); }
    .badge-green { background: rgba(34,197,94,0.15); color: var(--success); }
    .tag {
      display: inline-block; padding: 0.25rem 0.6rem;
      background: var(--surface2); border: 1px solid var(--border);
      border-radius: 6px; font-size: 0.78rem; color: var(--muted);
    }
    .header {
      text-align: center; padding: 2.5rem 0 2rem;
    }
    .header h1 { font-size: 2rem; font-weight: 700; margin-bottom: 0.5rem; }
    .header p { color: var(--muted); font-size: 0.95rem; }
    .logo {
      width: 64px; height: 64px; border-radius: 16px;
      background: linear-gradient(135deg, var(--accent), var(--accent2));
      display: inline-flex; align-items: center; justify-content: center;
      font-size: 1.8rem; margin-bottom: 1rem;
    }
    .meta-grid {
      display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
      gap: 1rem; margin: 1rem 0;
    }
    .meta-item { text-align: center; }
    .meta-item .val { font-size: 1.1rem; font-weight: 700; color: var(--accent2); }
    .meta-item .lbl { font-size: 0.75rem; color: var(--muted); margin-top: 0.2rem; }
    .btn-group { display: flex; gap: 0.75rem; flex-wrap: wrap; }
    @media (max-width: 600px) {
      .header h1 { font-size: 1.5rem; }
      .btn-group { flex-direction: column; }
      .btn { width: 100%; justify-content: center; }
    }
  `;
}

function filePage(fileData, uid, downloadUrl, isVideo, isAudio, isImage, env) {
  const workerUrl = env.WORKER_URL || "https://yourbot.workers.dev";
  const botUser = env.BOT_USERNAME || "filestore_bot";

  const previewSection = isVideo && downloadUrl
    ? `<div class="preview-wrap">
        <video controls preload="metadata" style="width:100%;border-radius:10px;background:#000;max-height:420px">
          <source src="${downloadUrl}" type="${fileData.mime_type || "video/mp4"}">
        </video>
       </div>`
    : isAudio && downloadUrl
    ? `<div class="preview-wrap">
        <audio controls style="width:100%;margin:1rem 0">
          <source src="${downloadUrl}" type="${fileData.mime_type || "audio/mpeg"}">
        </audio>
       </div>`
    : isImage && downloadUrl
    ? `<div class="preview-wrap"><img src="${downloadUrl}" alt="${escapeHtml(fileData.file_name)}" style="max-width:100%;border-radius:10px;display:block;margin:0 auto"></div>`
    : "";

  const typeIcon = { video: "🎬", audio: "🎵", photo: "🖼️", document: "📄", animation: "🎞️" }[fileData.type] || "📁";

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(fileData.file_name)} — FileStore</title>
<meta property="og:title" content="${escapeHtml(fileData.file_name)}">
<meta property="og:description" content="${humanSize(fileData.file_size)} · ${fileData.type}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<style>${baseStyles()}
.preview-wrap { margin: 1.5rem 0; }
.file-icon { font-size: 3rem; margin-bottom: 0.5rem; }
.file-title { font-size: 1.5rem; font-weight: 700; margin-bottom: 0.5rem; word-break: break-all; }
.filename-code { font-family: monospace; font-size: 0.85rem; color: var(--muted); background: var(--surface2); padding: 0.3rem 0.7rem; border-radius: 6px; word-break: break-all; display: block; margin: 0.5rem 0 1rem; }
.divider { border: none; border-top: 1px solid var(--border); margin: 1.5rem 0; }
.footer { text-align: center; color: var(--muted); font-size: 0.8rem; margin-top: 3rem; }
</style>
</head>
<body>
<div class="container">
  <div class="header">
    <div class="logo">🗂️</div>
    <h1>FileStore</h1>
    <p>Permanent file hosting via Telegram CDN</p>
  </div>

  <div class="card">
    <div class="file-icon">${typeIcon}</div>
    <div class="file-title">${escapeHtml(fileData.file_name)}</div>
    <code class="filename-code">${escapeHtml(fileData.file_name)}</code>

    <div style="display:flex;gap:0.5rem;flex-wrap:wrap;margin-bottom:1rem">
      <span class="badge badge-purple">${fileData.type.toUpperCase()}</span>
      <span class="tag">${humanSize(fileData.file_size)}</span>
      ${fileData.mime_type ? `<span class="tag">${escapeHtml(fileData.mime_type)}</span>` : ""}
      <span class="tag">📅 ${formatDate(fileData.timestamp)}</span>
    </div>

    ${fileData.caption ? `<p style="color:var(--muted);margin-bottom:1rem;font-style:italic">"${escapeHtml(fileData.caption)}"</p>` : ""}

    ${previewSection}
    <hr class="divider">

    <div class="btn-group">
      ${downloadUrl ? `<a href="${downloadUrl}" download class="btn btn-primary">⬇️ Download</a>` : ""}
      ${isVideo && downloadUrl ? `<a href="${downloadUrl}" target="_blank" class="btn btn-outline">▶️ Stream</a>` : ""}
      <a href="https://t.me/${botUser}?start=file_${uid}" class="btn btn-outline">📲 Open in Telegram</a>
    </div>

    <div class="meta-grid" style="margin-top:1.5rem">
      <div class="meta-item"><div class="val">${humanSize(fileData.file_size)}</div><div class="lbl">Size</div></div>
      <div class="meta-item"><div class="val">${fileData.type}</div><div class="lbl">Type</div></div>
      <div class="meta-item"><div class="val">${formatDate(fileData.timestamp)}</div><div class="lbl">Uploaded</div></div>
    </div>
  </div>

  <div class="footer">Powered by <a href="https://t.me/${botUser}">@${botUser}</a> · Cloudflare Workers</div>
</div>
</body></html>`;
}

function batchPage(batchData, batchId, files, env) {
  const workerUrl = env.WORKER_URL || "https://yourbot.workers.dev";
  const botUser = env.BOT_USERNAME || "filestore_bot";

  const fileCards = files
    .map((f, i) => {
      const typeIcon = { video: "🎬", audio: "🎵", photo: "🖼️", document: "📄", animation: "🎞️" }[f.type] || "📁";
      const isVideo = f.type === "video" || (f.mime_type || "").startsWith("video/");
      return `
      <div class="file-card">
        <div class="fc-left">
          <span class="fc-icon">${typeIcon}</span>
          <div class="fc-info">
            <div class="fc-name">${escapeHtml(f.file_name)}</div>
            <div class="fc-meta">
              <span class="tag">${humanSize(f.file_size)}</span>
              <span class="badge badge-purple">${f.type}</span>
              ${f.mime_type ? `<span class="tag">${escapeHtml(f.mime_type)}</span>` : ""}
            </div>
          </div>
        </div>
        <div class="fc-actions">
          ${f.downloadUrl ? `<a href="${f.downloadUrl}" download class="btn btn-primary" style="padding:0.5rem 1rem;font-size:0.82rem">⬇️ Download</a>` : ""}
          ${isVideo && f.downloadUrl ? `<a href="${f.downloadUrl}" target="_blank" class="btn btn-outline" style="padding:0.5rem 1rem;font-size:0.82rem">▶️ Stream</a>` : ""}
          <a href="${workerUrl}/file/${f.uid}" class="btn btn-outline" style="padding:0.5rem 1rem;font-size:0.82rem">🔗 Page</a>
        </div>
      </div>`;
    })
    .join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Batch ${batchId} — FileStore</title>
<meta property="og:title" content="Batch of ${files.length} files">
<style>${baseStyles()}
.batch-header { display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:1rem; margin-bottom:1.5rem; }
.batch-title { font-size:1.4rem; font-weight:700; }
.file-card {
  display:flex; align-items:center; justify-content:space-between;
  gap:1rem; flex-wrap:wrap;
  padding:1rem; background:var(--surface2);
  border:1px solid var(--border); border-radius:10px; margin-bottom:0.8rem;
  transition: border-color 0.2s;
}
.file-card:hover { border-color: var(--accent); }
.fc-left { display:flex; align-items:center; gap:0.8rem; flex:1; min-width:0; }
.fc-icon { font-size:1.8rem; flex-shrink:0; }
.fc-info { min-width:0; }
.fc-name { font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:350px; }
.fc-meta { display:flex; gap:0.4rem; flex-wrap:wrap; margin-top:0.3rem; }
.fc-actions { display:flex; gap:0.5rem; flex-wrap:wrap; flex-shrink:0; }
.stats-bar {
  display:flex; gap:1rem; flex-wrap:wrap;
  padding:1rem; background:var(--surface2);
  border:1px solid var(--border); border-radius:10px; margin-bottom:1.5rem;
}
.stat { flex:1; text-align:center; }
.stat .val { font-size:1.4rem; font-weight:700; color:var(--accent2); }
.stat .lbl { font-size:0.75rem; color:var(--muted); }
.search-box {
  width:100%; padding:0.65rem 1rem;
  background:var(--surface2); border:1px solid var(--border);
  border-radius:8px; color:var(--text); font-size:0.9rem;
  margin-bottom:1rem; outline:none;
}
.search-box:focus { border-color:var(--accent); }
.footer { text-align:center; color:var(--muted); font-size:0.8rem; margin-top:3rem; }
@media(max-width:600px){
  .fc-name{max-width:180px;}
  .fc-actions{width:100%;}
  .fc-actions .btn{flex:1;justify-content:center;}
}
</style>
</head>
<body>
<div class="container">
  <div class="header">
    <div class="logo">📦</div>
    <h1>Batch Files</h1>
    <p>Created ${formatDate(batchData.timestamp)} · ${files.length} file${files.length !== 1 ? "s" : ""}</p>
  </div>

  <div class="stats-bar">
    <div class="stat"><div class="val">${files.length}</div><div class="lbl">Total Files</div></div>
    <div class="stat"><div class="val">${humanSize(files.reduce((s, f) => s + (f.file_size || 0), 0))}</div><div class="lbl">Total Size</div></div>
    <div class="stat"><div class="val">${formatDate(batchData.timestamp)}</div><div class="lbl">Created</div></div>
  </div>

  <div class="card">
    <div class="batch-header">
      <div class="batch-title">📂 File List</div>
      <a href="https://t.me/${botUser}?start=batch_${batchId}" class="btn btn-outline">📲 Open in Telegram</a>
    </div>

    <input type="text" class="search-box" placeholder="🔍 Search files..." oninput="filterFiles(this.value)">

    <div id="file-list">
      ${fileCards}
    </div>

    ${files.length === 0 ? '<p style="color:var(--muted);text-align:center;padding:2rem">No files found in this batch.</p>' : ""}
  </div>

  <div class="footer">Powered by <a href="https://t.me/${botUser}">@${botUser}</a> · Cloudflare Workers</div>
</div>
<script>
function filterFiles(q){
  const cards=document.querySelectorAll('#file-list .file-card');
  q=q.toLowerCase();
  cards.forEach(c=>{
    const name=c.querySelector('.fc-name').textContent.toLowerCase();
    c.style.display=name.includes(q)?'':'none';
  });
}
</script>
</body></html>`;
}

function errorPage(title, message) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)} — FileStore</title>
<style>${baseStyles()}
.err-wrap{display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:60vh;text-align:center;gap:1rem}
.err-code{font-size:4rem;font-weight:800;color:var(--accent2)}
</style>
</head>
<body>
<div class="container">
  <div class="err-wrap">
    <div class="err-code">404</div>
    <h2>${escapeHtml(title)}</h2>
    <p style="color:var(--muted)">${escapeHtml(message)}</p>
    <a href="/" class="btn btn-primary">🏠 Go Home</a>
  </div>
</div>
</body></html>`;
}

// ─── Telegram API Helpers ─────────────────────────────────────────────────────

async function callTgApi(env, method, params = {}) {
  const url = `${TG_API(env.BOT_TOKEN)}/${method}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  return res.json();
}

async function sendMessage(env, chatId, text, extra = {}) {
  return callTgApi(env, "sendMessage", { chat_id: chatId, text, ...extra });
}

async function answerCallbackQuery(env, callbackQueryId, text = "") {
  return callTgApi(env, "answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    text,
  });
}

async function copyToStorageChannel(msg, env) {
  const res = await callTgApi(env, "copyMessage", {
    chat_id: env.CHANNEL_ID,
    from_chat_id: msg.chat.id,
    message_id: msg.message_id,
  });
  if (!res.ok) throw new Error(`copyMessage failed: ${JSON.stringify(res)}`);
  return res.result.message_id;
}

// ─── KV Storage Helpers ───────────────────────────────────────────────────────

async function saveFile(uid, data, env) {
  await env.KV.put(`file:${uid}`, JSON.stringify(data));
}

async function getFile(uid, env) {
  const raw = await env.KV.get(`file:${uid}`);
  return raw ? JSON.parse(raw) : null;
}

async function saveBatch(batchId, data, env) {
  await env.KV.put(`batch:${batchId}`, JSON.stringify(data));
  await incrementCounter("total_batches", env);
}

async function getBatch(batchId, env) {
  const raw = await env.KV.get(`batch:${batchId}`);
  return raw ? JSON.parse(raw) : null;
}

async function setSession(userId, data, env) {
  await env.KV.put(`session:${userId}`, JSON.stringify(data), { expirationTtl: SESSION_TTL });
}

async function getSession(userId, env) {
  const raw = await env.KV.get(`session:${userId}`);
  return raw ? JSON.parse(raw) : null;
}

async function clearSession(userId, env) {
  await env.KV.delete(`session:${userId}`);
}

async function registerUser(from, env) {
  const key = `user:${from.id}`;
  const existing = await env.KV.get(key);
  if (!existing) {
    await env.KV.put(
      key,
      JSON.stringify({
        id: from.id,
        username: from.username || null,
        first_name: from.first_name || null,
        joined: Date.now(),
      })
    );
    await incrementCounter("total_users", env);
  }
}

async function getAllUsers(env) {
  const list = await env.KV.list({ prefix: "user:" });
  return list.keys.map((k) => k.name.replace("user:", ""));
}

async function incrementCounter(name, env) {
  const key = `counter:${name}`;
  const current = parseInt((await env.KV.get(key)) || "0", 10);
  await env.KV.put(key, String(current + 1));
}

async function isRateLimited(userId, env) {
  const key = `rl:${userId}`;
  const raw = await env.KV.get(key);
  const data = raw ? JSON.parse(raw) : { count: 0, window: Date.now() };

  const now = Date.now();
  const elapsed = (now - data.window) / 1000;

  if (elapsed > RATE_LIMIT_WINDOW) {
    await env.KV.put(key, JSON.stringify({ count: 1, window: now }), { expirationTtl: RATE_LIMIT_WINDOW * 2 });
    return false;
  }

  if (data.count >= RATE_LIMIT_MAX) return true;

  data.count++;
  await env.KV.put(key, JSON.stringify(data), { expirationTtl: RATE_LIMIT_WINDOW * 2 });
  return false;
}

// ─── Utility Helpers ──────────────────────────────────────────────────────────

function extractFileMeta(msg) {
  if (msg.document) {
    return {
      type: "document",
      file_id: msg.document.file_id,
      file_unique_id: msg.document.file_unique_id,
      file_name: msg.document.file_name || "Unknown File",
      file_size: msg.document.file_size || 0,
      mime_type: msg.document.mime_type || "application/octet-stream",
      thumbnail: msg.document.thumb?.file_id || null,
    };
  }
  if (msg.video) {
    return {
      type: "video",
      file_id: msg.video.file_id,
      file_unique_id: msg.video.file_unique_id,
      file_name: msg.video.file_name || `video_${Date.now()}.mp4`,
      file_size: msg.video.file_size || 0,
      mime_type: msg.video.mime_type || "video/mp4",
      thumbnail: msg.video.thumb?.file_id || null,
    };
  }
  if (msg.audio) {
    return {
      type: "audio",
      file_id: msg.audio.file_id,
      file_unique_id: msg.audio.file_unique_id,
      file_name: msg.audio.file_name || `audio_${Date.now()}.mp3`,
      file_size: msg.audio.file_size || 0,
      mime_type: msg.audio.mime_type || "audio/mpeg",
      thumbnail: null,
    };
  }
  if (msg.photo) {
    const photo = msg.photo[msg.photo.length - 1]; // largest
    return {
      type: "photo",
      file_id: photo.file_id,
      file_unique_id: photo.file_unique_id,
      file_name: `photo_${Date.now()}.jpg`,
      file_size: photo.file_size || 0,
      mime_type: "image/jpeg",
      thumbnail: null,
    };
  }
  if (msg.voice) {
    return {
      type: "voice",
      file_id: msg.voice.file_id,
      file_unique_id: msg.voice.file_unique_id,
      file_name: `voice_${Date.now()}.ogg`,
      file_size: msg.voice.file_size || 0,
      mime_type: "audio/ogg",
      thumbnail: null,
    };
  }
  if (msg.animation) {
    return {
      type: "animation",
      file_id: msg.animation.file_id,
      file_unique_id: msg.animation.file_unique_id,
      file_name: msg.animation.file_name || `animation_${Date.now()}.gif`,
      file_size: msg.animation.file_size || 0,
      mime_type: msg.animation.mime_type || "video/mp4",
      thumbnail: msg.animation.thumb?.file_id || null,
    };
  }
  return null;
}

function hasFileContent(msg) {
  return !!(msg.document || msg.video || msg.audio || msg.photo || msg.voice || msg.animation);
}

function generateUID() {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const arr = new Uint8Array(16);
  crypto.getRandomValues(arr);
  return Array.from(arr)
    .map((b) => chars[b % chars.length])
    .join("");
}

function humanSize(bytes) {
  if (!bytes || bytes === 0) return "Unknown";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let size = bytes;
  while (size >= 1024 && i < units.length - 1) {
    size /= 1024;
    i++;
  }
  return `${size.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function formatDate(ts) {
  if (!ts) return "Unknown";
  const d = new Date(ts);
  return d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}

function escapeMarkdown(text) {
  if (!text) return "";
  return String(text).replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, "\\$&");
}

function escapeHtml(text) {
  if (!text) return "";
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function isAdmin(userId, env) {
  if (!env.ADMINS) return false;
  return env.ADMINS.split(",")
    .map((a) => a.trim())
    .includes(String(userId));
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function htmlResponse(html, status = 200) {
  return new Response(html, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}
