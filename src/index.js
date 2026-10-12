import 'dotenv/config';
import crypto from 'node:crypto';
import path from 'node:path';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import express from 'express';
import { Telegraf, Markup } from 'telegraf';
import { createSubtitles, cleanupSubtitles } from './subtitles.js';

const token = process.env.BOT_TOKEN;
if (!token) {
  console.error('Missing BOT_TOKEN. Copy .env.example to .env and add your Telegram bot token.');
  process.exit(1);
}

const adminIds = new Set(
  (process.env.ADMIN_IDS || '').split(',').map((id) => id.trim()).filter(Boolean)
);
const subtitleAllowedIds = new Set(
  (process.env.SUBTITLE_ALLOWED_IDS || '').split(',').map((id) => id.trim()).filter(Boolean)
);
const miniAppUrl = (process.env.WEB_APP_URL || '').trim().replace(/\/$/, '');
const port = Number(process.env.PORT || 3000);
const bot = new Telegraf(token);
const app = express();
const recentVideos = new Map();
const activeTasks = new Set();
const settingsFile = path.resolve(process.env.SETTINGS_FILE || 'data/user-settings.json');
let userSettings = {};
try { userSettings = JSON.parse(readFileSync(settingsFile, 'utf8')); } catch { userSettings = {}; }

const outputModes = {
  ask: { label: 'Hỏi mỗi lần gửi video', description: 'Mỗi video sẽ hiện menu chọn loại phụ đề.', mode: null },
  original: { label: 'SRT nguyên ngữ', description: 'Tự nhận diện ngôn ngữ và trả phụ đề nguyên ngữ.', mode: 'original' },
  vietnamese: { label: 'Vietsub tiếng Việt', description: 'Tự nhận diện, dịch offline sang tiếng Việt và trả SRT.', mode: 'vietnamese' },
  'burn-vietnamese': { label: 'MP4 gắn phụ đề Việt', description: 'Tạo Vietsub rồi gắn cứng vào video MP4.', mode: 'burn-vietnamese' }
};

function getUserSettings(ctx) {
  const id = String(ctx.from?.id ?? '');
  if (!userSettings[id]) userSettings[id] = { defaultMode: 'ask' };
  if (!outputModes[userSettings[id].defaultMode]) userSettings[id].defaultMode = 'ask';
  return userSettings[id];
}

function saveUserSettings() {
  mkdirSync(path.dirname(settingsFile), { recursive: true });
  writeFileSync(settingsFile, JSON.stringify(userSettings, null, 2), 'utf8');
}

function settingsKeyboard(ctx) {
  const selected = getUserSettings(ctx).defaultMode;
  const button = (mode, label) => Markup.button.callback(`${selected === mode ? '✅ ' : ''}${label}`, `SETTINGS_MODE_${({ ask: 'ASK', original: 'ORIGINAL', vietnamese: 'VI', 'burn-vietnamese': 'BURN_VI' })[mode]}`);
  return Markup.inlineKeyboard([
    [button('ask', 'Hỏi mỗi lần')],
    [button('original', '📝 SRT nguyên ngữ')],
    [button('vietnamese', '🇻🇳 Vietsub tiếng Việt')],
    [button('burn-vietnamese', '🎞️ MP4 gắn phụ đề Việt')],
    [Markup.button.callback('⬅️ Menu chính', 'MAIN_MENU')]
  ]);
}

function settingsText(ctx) {
  const settings = getUserSettings(ctx);
  const mode = outputModes[settings.defaultMode];
  return `⚙️ CÀI ĐẶT BOT\n\nChế độ mặc định: ${mode.label}\n${mode.description}\n\n🌐 Phát hiện ngôn ngữ: TỰ ĐỘNG (Whisper.cpp).\n💾 Cài đặt được lưu trên máy chủ của bot. Trên máy chủ không có ổ đĩa bền vững, cài đặt có thể mất sau khi triển khai lại.\n\nChọn chế độ áp dụng tự động khi bạn gửi video:`;
}

async function showSettings(ctx, edit = false) {
  const text = settingsText(ctx);
  if (edit && ctx.callbackQuery?.message) {
    try { await ctx.editMessageText(text, settingsKeyboard(ctx)); return; } catch {}
  }
  await ctx.reply(text, settingsKeyboard(ctx));
}
const parsedMaxVideoMb = Number.parseInt(process.env.MAX_VIDEO_MB || '20', 10);
const MAX_VIDEO_MB = Number.isFinite(parsedMaxVideoMb) && parsedMaxVideoMb > 0 ? parsedMaxVideoMb : 20;

app.disable('x-powered-by');
app.use(express.json({ limit: '64kb' }));
app.use(express.static(path.resolve('public'), { extensions: ['html'] }));
app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'telegram-admini-bot' }));
app.get('/api/config', (_req, res) => res.json({ miniAppEnabled: Boolean(miniAppUrl) }));

function validateTelegramInitData(initData) {
  if (!initData || typeof initData !== 'string' || initData.length > 16_384) return null;
  const params = new URLSearchParams(initData);
  const suppliedHash = params.get('hash');
  if (!suppliedHash || !/^[a-f0-9]{64}$/i.test(suppliedHash)) return null;
  params.delete('hash');
  params.delete('signature');
  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(token).digest();
  const calculatedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
  const supplied = Buffer.from(suppliedHash, 'hex');
  const calculated = Buffer.from(calculatedHash, 'hex');
  if (supplied.length !== calculated.length || !crypto.timingSafeEqual(supplied, calculated)) return null;
  const authDate = Number(params.get('auth_date') || 0);
  if (!authDate || Math.abs(Date.now() / 1000 - authDate) > 24 * 60 * 60) return null;
  try {
    const user = JSON.parse(params.get('user') || 'null');
    if (!user || !user.id) return null;
    return user;
  } catch {
    return null;
  }
}

app.post('/api/miniapp/session', (req, res) => {
  const user = validateTelegramInitData(req.body?.initData);
  if (!user) return res.status(401).json({ ok: false, error: 'Không xác thực được phiên Telegram Mini App.' });
  return res.json({
    ok: true,
    user: { id: user.id, firstName: user.first_name || 'Bạn', username: user.username || null },
    isAdmin: adminIds.has(String(user.id))
  });
});

app.post('/api/miniapp/action', (req, res) => {
  const user = validateTelegramInitData(req.body?.initData);
  if (!user) return res.status(401).json({ ok: false, error: 'Phiên Mini App không hợp lệ hoặc đã hết hạn.' });
  if (!adminIds.has(String(user.id))) return res.status(403).json({ ok: false, error: 'Chỉ quản trị viên mới dùng được khu vực Admini.' });
  const action = String(req.body?.action || '');
  const actions = {
    admini1: 'Admini1 — quản lý hệ thống',
    admini2: 'Admini2 — thống kê và báo cáo',
    admini3: 'Admini3 — quản lý người dùng',
    admini4: 'Admini4 — cấu hình hệ thống'
  };
  if (!Object.hasOwn(actions, action)) return res.status(400).json({ ok: false, error: 'Chức năng không hợp lệ.' });
  // This endpoint is a secure integration point; connect real database/management operations here.
  return res.json({ ok: true, message: `${actions[action]} đã được chọn. Nghiệp vụ quản trị thật cần được nối vào handler này.` });
});

function isAdmin(ctx) {
  return adminIds.has(String(ctx.from?.id ?? ''));
}

function canUseSubtitles(ctx) {
  const id = String(ctx.from?.id ?? '');
  // Local model inference has no hosted-AI API fee; keep processing access restricted by default for CPU/disk safety.
  return adminIds.has(id) || subtitleAllowedIds.has(id);
}

function makeMainKeyboard() {
  const rows = [
    [Markup.button.callback('🚀 Admini1', 'ADMINI_1'), Markup.button.callback('🚀 Admini2', 'ADMINI_2')],
    [Markup.button.callback('🟦 Admini3', 'ADMINI_3'), Markup.button.callback('🟩 Admini4', 'ADMINI_4')]
  ];
  if (miniAppUrl) rows.push([Markup.button.webApp('🎨 Mở Mini App', miniAppUrl)]);
  rows.push([Markup.button.callback('🎬 Hướng dẫn tạo phụ đề', 'SUBTITLE_HELP'), Markup.button.callback('⚙️ Cài đặt bot', 'BOT_SETTINGS')]);
  return Markup.inlineKeyboard(rows);
}

function subtitleKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('📝 SRT nguyên ngữ · tự nhận diện', 'SUBS_ORIGINAL')],
    [Markup.button.callback('🇻🇳 Vietsub tiếng Việt · offline', 'SUBS_VI')],
    [Markup.button.callback('🎞️ MP4 gắn phụ đề Việt · offline', 'SUBS_BURN_VI')]
  ]);
}

bot.start(async (ctx) => {
  const note = miniAppUrl
    ? 'Chọn Admini1–Admini4 hoặc mở Mini App. Bạn cũng có thể gửi video để tạo phụ đề.'
    : 'Chọn Admini1–Admini4. Để mở Mini App, cần thiết lập WEB_APP_URL HTTPS. Bạn cũng có thể gửi video để tạo phụ đề.';
  await ctx.reply(`👋 HENDY ADMIN BOT\n\n${note}\n\n📹 Gửi video vào cuộc trò chuyện để bắt đầu tạo phụ đề.`, makeMainKeyboard());
});

bot.command('menu', async (ctx) => ctx.reply('🧭 MENU CHÍNH', makeMainKeyboard()));
bot.command('settings', async (ctx) => showSettings(ctx));
bot.action('BOT_SETTINGS', async (ctx) => {
  await ctx.answerCbQuery();
  await showSettings(ctx, true);
});
bot.action(/^SETTINGS_MODE_(ASK|ORIGINAL|VI|BURN_VI)$/, async (ctx) => {
  const map = { ASK: 'ask', ORIGINAL: 'original', VI: 'vietnamese', BURN_VI: 'burn-vietnamese' };
  const mode = map[ctx.match[1]];
  const settings = getUserSettings(ctx);
  settings.defaultMode = mode;
  try { saveUserSettings(); } catch (error) {
    console.error('Unable to persist user settings:', error);
    await ctx.answerCbQuery('Không lưu được cài đặt trên máy chủ.', { show_alert: true }).catch(() => {});
    return;
  }
  await ctx.answerCbQuery(`Đã chọn: ${outputModes[mode].label}`);
  await showSettings(ctx, true);
});
bot.command('help', async (ctx) => ctx.reply(
  '📚 HƯỚNG DẪN\n\n1. Gửi video (hoặc tệp video) cho bot.\n2. Whisper.cpp chạy cục bộ tự nhận diện lời nói và ngôn ngữ.\n3. Chọn SRT nguyên ngữ, Vietsub tiếng Việt offline hoặc xuất MP4 có phụ đề.\n4. Bộ dịch Argos Translate tải mô hình ngôn ngữ khi cần lần đầu; không cần OPENAI_API_KEY và không gọi API AI trả phí.\n\nGiới hạn video hiện tại: ' + MAX_VIDEO_MB + ' MB theo Bot API cloud. Xử lý dài cần CPU/RAM và thời gian đủ lớn.',
  makeMainKeyboard()
));

bot.action('SUBTITLE_HELP', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply('🎬 VIETSUB CỤC BỘ\n\nGửi video vào chat này. Whisper.cpp tự nhận diện lời nói và ngôn ngữ trên máy chủ; không cần API key hoặc dịch vụ nhận diện có phí. Chọn SRT nguyên ngữ, Vietsub offline bằng Argos Translate, hoặc MP4 gắn cứng phụ đề Việt.\n\nLưu ý: mô hình Argos có thể cần được tải lần đầu khi dịch một ngôn ngữ mới; chất lượng phụ thuộc ngôn ngữ/mô hình đã hỗ trợ.');
});

const adminActions = {
  ADMINI_1: { key: 'admini1', title: 'Admini1', description: '🛠️ Khu vực quản lý hệ thống' },
  ADMINI_2: { key: 'admini2', title: 'Admini2', description: '📊 Khu vực thống kê và báo cáo' },
  ADMINI_3: { key: 'admini3', title: 'Admini3', description: '👥 Khu vực quản lý người dùng' },
  ADMINI_4: { key: 'admini4', title: 'Admini4', description: '⚙️ Khu vực cấu hình hệ thống' }
};
const colorEffects = [
  { name: 'xanh ngọc', emoji: '🟢' }, { name: 'xanh dương', emoji: '🔵' },
  { name: 'tím', emoji: '🟣' }, { name: 'cam', emoji: '🟠' },
  { name: 'đỏ hồng', emoji: '🔴' }, { name: 'vàng', emoji: '🟡' }
];

for (const [callbackData, action] of Object.entries(adminActions)) {
  bot.action(callbackData, async (ctx) => {
    if (!isAdmin(ctx)) {
      await ctx.answerCbQuery('⛔ Chỉ Admin được sử dụng nút này.', { show_alert: true }).catch(() => {});
      return;
    }
    const effect = colorEffects[Math.floor(Math.random() * colorEffects.length)];
    await ctx.answerCbQuery(`${effect.emoji} Hiệu ứng ${effect.name}`);
    await ctx.reply(
      `${effect.emoji} ${action.description}\n\nNút: ${action.title}\nHiệu ứng màu ngẫu nhiên: ${effect.name}.\n\nℹ️ Đây là điểm nối nghiệp vụ; cần tích hợp database/quản trị cụ thể để thực hiện thao tác thật.`,
      Markup.inlineKeyboard([[Markup.button.callback('⬅️ Quay lại menu', 'MAIN_MENU')]])
    );
  });
}

bot.action('MAIN_MENU', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply('🧭 MENU CHÍNH', makeMainKeyboard());
});

function extractVideo(message) {
  if (message?.video) {
    return {
      fileId: message.video.file_id,
      fileName: message.video.file_name || `telegram-video-${message.message_id}.mp4`,
      fileSize: message.video.file_size,
      mimeType: message.video.mime_type || 'video/mp4'
    };
  }
  if (message?.video_note) {
    return {
      fileId: message.video_note.file_id,
      fileName: `telegram-video-note-${message.message_id}.mp4`,
      fileSize: message.video_note.file_size,
      mimeType: 'video/mp4'
    };
  }
  if (message?.document && ((message.document.mime_type || '').startsWith('video/') || /\.(mp4|mov|mkv|webm|m4v|avi)$/i.test(message.document.file_name || ''))) {
    return {
      fileId: message.document.file_id,
      fileName: message.document.file_name || `telegram-video-${message.message_id}.mp4`,
      fileSize: message.document.file_size,
      mimeType: message.document.mime_type
    };
  }
  return null;
}

async function onVideo(ctx, message) {
  const video = extractVideo(message);
  if (!video) return;
  if (!canUseSubtitles(ctx)) {
    await ctx.reply('🔒 Tính năng tạo phụ đề chưa được cấp cho tài khoản này. Admin hãy thêm Telegram ID vào SUBTITLE_ALLOWED_IDS hoặc ADMIN_IDS để bật quyền.');
    return;
  }
  const key = `${ctx.chat.id}:${ctx.from.id}`;
  recentVideos.set(key, video);
  if (video.fileSize && video.fileSize > MAX_VIDEO_MB * 1024 * 1024) {
    await ctx.reply(`⚠️ Video lớn hơn giới hạn hiện tại ${MAX_VIDEO_MB} MB. Hãy giảm dung lượng hoặc cắt ngắn video rồi gửi lại.`);
    return;
  }
  const defaultMode = getUserSettings(ctx).defaultMode;
  if (defaultMode !== 'ask') {
    await ctx.reply(`⚙️ Đã nhận video. Tự động xử lý theo cài đặt: ${outputModes[defaultMode].label}.`);
    await runSubtitleTask(ctx, outputModes[defaultMode].mode);
    return;
  }
  await ctx.reply(
    `✅ Đã nhận video: ${video.fileName}\n\nChọn cách tạo phụ đề:`,
    subtitleKeyboard()
  );
}

bot.on('video', (ctx) => onVideo(ctx, ctx.message));
bot.on('video_note', (ctx) => onVideo(ctx, ctx.message));
bot.on('document', (ctx) => onVideo(ctx, ctx.message));

async function runSubtitleTask(ctx, mode) {
  const key = `${ctx.chat.id}:${ctx.from.id}`;
  const video = recentVideos.get(key);
  if (!video) {
    await ctx.answerCbQuery('Hãy gửi video cho bot trước.', { show_alert: true });
    return;
  }
  if (activeTasks.has(key)) {
    await ctx.answerCbQuery('Bạn đang có tác vụ phụ đề chạy rồi.', { show_alert: true });
    return;
  }
  if (!canUseSubtitles(ctx)) {
    await ctx.answerCbQuery('Tài khoản chưa được cấp quyền tạo phụ đề.', { show_alert: true });
    return;
  }
  activeTasks.add(key);
  if (ctx.callbackQuery) {
    await ctx.answerCbQuery('Đã bắt đầu xử lý video…');
  } else {
    await ctx.reply('⏳ Đã bắt đầu xử lý phụ đề theo cài đặt mặc định…');
  }
  const progress = await ctx.reply('⏳ Đang chuẩn bị xử lý phụ đề…');
  const updateProgress = async (text) => {
    await ctx.telegram.editMessageText(ctx.chat.id, progress.message_id, undefined, text).catch(() => {});
  };
  let result;
  try {
    result = await createSubtitles({
      bot,
      fileId: video.fileId,
      fileName: video.fileName,
      mode,
      onProgress: updateProgress
    });
    await updateProgress(`✅ Nhận diện ${result.sourceLanguageName}; đã tạo ${result.segmentCount} đoạn. Đang gửi tệp…`);
    const languageCaption = result.language === 'vi' ? 'Phụ đề tiếng Việt' : `Phụ đề nguyên ngữ (${result.sourceLanguageName})`;
    await ctx.replyWithDocument(
      { source: result.srtPath, filename: result.language === 'vi' ? 'subtitles_vi.srt' : 'subtitles_original.srt' },
      { caption: `📝 ${languageCaption} · ${result.segmentCount} đoạn` }
    );
    await ctx.replyWithDocument(
      { source: result.textPath, filename: 'transcript.txt' },
      { caption: '📄 Bản lời thoại dạng văn bản' }
    );
    if (result.videoPath) {
      const stat = await import('node:fs/promises').then((fs) => fs.stat(result.videoPath));
      if (stat.size > 49 * 1024 * 1024) {
        await ctx.reply('⚠️ Video đã được render nhưng lớn hơn giới hạn gửi của Telegram Bot API nên bot không thể gửi lại. Hãy dùng video nguồn ngắn hơn hoặc nén hơn rồi thử lại.');
      } else {
        await ctx.replyWithVideo(
          { source: result.videoPath, filename: 'vietsub.mp4' },
          { caption: '🎬 Video đã gắn cứng phụ đề tiếng Việt', supports_streaming: true }
        );
      }
    }
    await updateProgress('✅ Hoàn tất! Bạn có thể tải các tệp phụ đề ở phía trên.');
  } catch (error) {
    console.error('Subtitle task failed:', error);
    const message = String(error?.message || 'Lỗi không xác định').slice(0, 700);
    await updateProgress(`❌ Không tạo được phụ đề: ${message}`);
  } finally {
    if (result) await cleanupSubtitles(result);
    activeTasks.delete(key);
  }
}

bot.action('SUBS_ORIGINAL', (ctx) => runSubtitleTask(ctx, 'original'));
bot.action('SUBS_VI', (ctx) => runSubtitleTask(ctx, 'vietnamese'));
bot.action('SUBS_BURN_VI', (ctx) => runSubtitleTask(ctx, 'burn-vietnamese'));

bot.on('web_app_data', async (ctx) => {
  const raw = ctx.message?.web_app_data?.data;
  try {
    const data = JSON.parse(raw || '{}');
    if (data?.action) await ctx.reply(`Mini App đã gửi lựa chọn: ${String(data.action).slice(0, 80)}`);
  } catch {
    await ctx.reply('Đã nhận dữ liệu từ Mini App.');
  }
});

bot.catch((error, ctx) => {
  console.error(`Bot error while handling update ${ctx.update?.update_id}:`, error);
});

const server = app.listen(port, '0.0.0.0', () => {
  console.log(`HTTP/Mini App server listening on port ${port}`);
});

bot.launch()
  .then(() => console.log('Telegram Admini Bot polling started.'))
  .catch((error) => {
    console.error('Could not start Telegram bot:', error);
    server.close();
    process.exit(1);
  });

function shutdown(signal) {
  console.log(`Received ${signal}; shutting down…`);
  bot.stop(signal);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}
process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
