// ==========================================
// ⚙️ CẤU HÌNH HỆ THỐNG RENDER WEB SERVICE
// ==========================================
import 'dotenv/config';
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createSubtitles, cleanupSubtitles } from './src/subtitles.js';

const PORT = Number(process.env.PORT || 3000);
const BOT_TOKEN = (process.env.BOT_TOKEN || '').trim();
if (!BOT_TOKEN) {
    console.error('Missing BOT_TOKEN. Set it in Render → Environment; never place the token in source code.');
    process.exit(1);
}
const ADMIN_IDS = new Set((process.env.ADMIN_IDS || process.env.ADMIN_ID || '')
    .split(',').map((id) => id.trim()).filter(Boolean));
const WEBHOOK_SECRET_TOKEN = process.env.WEBHOOK_SECRET_TOKEN || '';
const SUBTITLE_ALLOWED_IDS = new Set((process.env.SUBTITLE_ALLOWED_IDS || '')
    .split(',').map((id) => id.trim()).filter(Boolean));
const MAX_VIDEO_MB_VALUE = Number.parseInt(process.env.MAX_VIDEO_MB || '20', 10);
const MAX_VIDEO_MB = Number.isFinite(MAX_VIDEO_MB_VALUE) && MAX_VIDEO_MB_VALUE > 0 ? MAX_VIDEO_MB_VALUE : 20;
const SETTINGS_FILE = path.resolve(process.env.SETTINGS_FILE || 'data/user-settings.json');
const MINI_APP_URL = process.env.MINI_APP_URL || process.env.RENDER_EXTERNAL_URL || 'https://ngogiaidy56-eng.github.io/BOT-TELE';
const pendingVideos = new Map();
const activeSubtitleJobs = new Set();
let userSettings = {};
try { userSettings = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); } catch { userSettings = {}; }

const OUTPUT_MODES = {
    ask: { label: 'Hỏi mỗi lần gửi video', description: 'Mỗi video sẽ hiện menu chọn loại phụ đề.', mode: null },
    original: { label: 'SRT nguyên ngữ', description: 'Tự phát hiện ngôn ngữ và xuất phụ đề nguyên ngữ.', mode: 'original' },
    vietnamese: { label: 'Vietsub tiếng Việt', description: 'Dịch offline sang tiếng Việt và trả SRT.', mode: 'vietnamese' },
    'burn-vietnamese': { label: 'MP4 gắn phụ đề Việt', description: 'Tạo Vietsub rồi gắn cứng vào video.', mode: 'burn-vietnamese' }
};

// 🔗 Thay đổi đường dẫn Mini App và Web của bạn tại đây
const WEB_APP_URL = process.env.WEB_APP_URL || process.env.RENDER_EXTERNAL_URL || 'https://telegram-mini-app.ngogiaidy56.workers.dev';

// 🌐 URL Máy chủ Core Backend Node.js (Ktor Client / API Gateway Target)
const CORE_BACKEND_URL = process.env.CORE_BACKEND_URL || 'https://telegram-mini-app.ngogiaidy56.workers.dev'; 

let users = {}; 
const userStates = {};   // Quản lý trạng thái nhập liệu tạm thời
const BRANDS = ["SC88", "C168", "CM88", "F8BET", "RR88", "MM88", "GG88", "U888", "J88", "88CLB", "ABC8", "XX8", "KJC_CU"];

// ==========================================
// 1. HTTP SERVER: WEBHOOK + MINI APP + HEALTH
// ==========================================
const PUBLIC_FILES = {
    '/': ['index.html', 'text/html; charset=utf-8'],
    '/index.html': ['index.html', 'text/html; charset=utf-8'],
    '/style.css': ['style.css', 'text/css; charset=utf-8'],
    '/app.js': ['app.js', 'text/javascript; charset=utf-8']
};

function sendJson(res, statusCode, payload) {
    res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(payload));
}

async function readJsonBody(req, maxBytes = 128 * 1024) {
    let body = '';
    for await (const chunk of req) {
        body += chunk.toString('utf8');
        if (Buffer.byteLength(body, 'utf8') > maxBytes) throw new Error('Request body too large');
    }
    return JSON.parse(body || '{}');
}

function validateTelegramInitData(initData) {
    if (!initData || typeof initData !== 'string' || initData.length > 16384) return null;
    const params = new URLSearchParams(initData);
    const suppliedHash = params.get('hash');
    if (!suppliedHash || !/^[a-f0-9]{64}$/i.test(suppliedHash)) return null;
    params.delete('hash');
    params.delete('signature');
    const dataCheckString = [...params.entries()].sort(([a], [b]) => a.localeCompare(b))
        .map(([key, value]) => `${key}=${value}`).join('\n');
    const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
    const calculatedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
    const provided = Buffer.from(suppliedHash, 'hex');
    const calculated = Buffer.from(calculatedHash, 'hex');
    if (provided.length !== calculated.length || !crypto.timingSafeEqual(provided, calculated)) return null;
    const authDate = Number(params.get('auth_date') || 0);
    if (!authDate || Math.abs(Date.now() / 1000 - authDate) > 24 * 60 * 60) return null;
    try {
        const user = JSON.parse(params.get('user') || 'null');
        return user && user.id ? user : null;
    } catch { return null; }
}

const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

    if (req.method === 'GET' && url.pathname === '/api/health') {
        return sendJson(res, 200, { ok: true, service: 'hendy-cybertech-admini-v3' });
    }
    if (req.method === 'GET' && url.pathname === '/api/config') {
        return sendJson(res, 200, { miniAppEnabled: Boolean(MINI_APP_URL), subtitleEnabled: true });
    }
    if (req.method === 'GET' && PUBLIC_FILES[url.pathname]) {
        const [filename, contentType] = PUBLIC_FILES[url.pathname];
        try {
            const content = await fs.promises.readFile(path.join(process.cwd(), 'public', filename));
            res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'public, max-age=300' });
            return res.end(content);
        } catch {
            return sendJson(res, 500, { ok: false, error: 'Không tải được giao diện Mini App.' });
        }
    }

    if (req.method === 'POST' && url.pathname === '/api/miniapp/session') {
        try {
            const body = await readJsonBody(req, 32 * 1024);
            const user = validateTelegramInitData(body.initData);
            if (!user) return sendJson(res, 401, { ok: false, error: 'Không xác thực được phiên Telegram Mini App.' });
            return sendJson(res, 200, {
                ok: true,
                user: { id: user.id, firstName: user.first_name || 'Bạn', username: user.username || null },
                isAdmin: ADMIN_IDS.has(String(user.id))
            });
        } catch (error) {
            return sendJson(res, 400, { ok: false, error: error.message || 'Yêu cầu không hợp lệ.' });
        }
    }
    if (req.method === 'POST' && url.pathname === '/api/miniapp/action') {
        try {
            const body = await readJsonBody(req, 32 * 1024);
            const user = validateTelegramInitData(body.initData);
            if (!user) return sendJson(res, 401, { ok: false, error: 'Phiên Mini App không hợp lệ hoặc đã hết hạn.' });
            if (!ADMIN_IDS.has(String(user.id))) return sendJson(res, 403, { ok: false, error: 'Chỉ quản trị viên mới dùng được khu vực Admini.' });
            const actions = {
                admini1: 'Admini1 — quản lý hệ thống', admini2: 'Admini2 — thống kê và báo cáo',
                admini3: 'Admini3 — quản lý người dùng', admini4: 'Admini4 — cấu hình hệ thống'
            };
            const action = String(body.action || '');
            if (!Object.hasOwn(actions, action)) return sendJson(res, 400, { ok: false, error: 'Chức năng không hợp lệ.' });
            return sendJson(res, 200, { ok: true, message: `${actions[action]} đã được chọn. Cần nối nghiệp vụ thật để thực thi thao tác.` });
        } catch (error) {
            return sendJson(res, 400, { ok: false, error: error.message || 'Yêu cầu không hợp lệ.' });
        }
    }

    if (req.method === 'POST' && url.pathname === '/webhook') {
        const clientSecret = req.headers['x-telegram-bot-api-secret-token'];
        if (!WEBHOOK_SECRET_TOKEN && process.env.NODE_ENV === 'production') {
            return sendJson(res, 503, { ok: false, error: 'Webhook secret chưa được cấu hình trên máy chủ.' });
        }
        if (WEBHOOK_SECRET_TOKEN && clientSecret !== WEBHOOK_SECRET_TOKEN) {
            res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
            return res.end('Forbidden: Invalid Secret Token');
        }
        try {
            const update = await readJsonBody(req, 2 * 1024 * 1024);
            // Acknowledge Telegram quickly. Bot operations continue asynchronously.
            sendJson(res, 200, { status: 'OK' });
            handleUpdate(update).catch((error) => console.error('Lỗi xử lý update:', error));
        } catch (error) {
            console.error('Webhook payload không hợp lệ:', error.message);
            return sendJson(res, 400, { ok: false, error: 'Lỗi xử lý JSON' });
        }
        return;
    }

    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('🤖 HENDY Cybertech Admini Bot V3 đang chạy trên Render. Mở /api/health để kiểm tra trạng thái.');
});

server.listen(PORT, '0.0.0.0', async () => {
    console.log(`🚀 Server đang chạy tại cổng ${PORT}`);
    await registerWebhookAutomatically();
});

// ==========================================
// 2. HÀM GIAO TIẾP VỚI TELEGRAM API & KTOR CLIENT MOCK
// ==========================================
async function callTelegramApi(method, payload) {
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/${method}`;
    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        return await response.json();
    } catch (err) {
        console.error(`Lỗi gọi Telegram API [${method}]:`, err);
        return null;
    }
}

// Tự động đăng ký webhook Telegram trên Render.
async function registerWebhookAutomatically() {
    const baseUrl = (process.env.WEBHOOK_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/$/, '');
    if (!baseUrl) {
        console.log('⚠️ Chưa có RENDER_EXTERNAL_URL/WEBHOOK_URL; bỏ qua tự đăng ký webhook.');
        return;
    }
    if (!WEBHOOK_SECRET_TOKEN) {
        console.error('❌ Chưa cấu hình WEBHOOK_SECRET_TOKEN; không đăng ký webhook để tránh giả mạo update.');
        return;
    }
    const payload = { url: `${baseUrl}/webhook`, secret_token: WEBHOOK_SECRET_TOKEN, drop_pending_updates: false };
    try {
        const data = await callTelegramApi('setWebhook', payload);
        console.log('🔗 Kết quả đăng ký webhook:', data?.ok ? 'success' : (data?.description || 'failed'));
    } catch (error) {
        console.error('❌ Không đăng ký được webhook:', error.message);
    }
}

// Giả lập Ktor Client Web Target (gửi lệnh Quản trị Admin xuống Backend)
async function sendAdminCommandViaKtorClient(command, adminId) {
    try {
        const response = await fetch(`${CORE_BACKEND_URL}/api/bot-trigger`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chatId: adminId,
                userName: 'Hendy_Admin',
                action: 'ADMIN_COMPOSE_COMMAND',
                command: command,
                clientSDK: 'ComposeWeb-TMA-KtorClient'
            })
        });
        return await response.json();
    } catch (err) {
        return { success: false, error: err.message };
    }
}

// Helper khởi tạo dữ liệu người dùng
function initUser(chatId, user) {
    if (!users[chatId]) {
        users[chatId] = {
            name: user ? (user.first_name || 'Khách') : 'Khách',
            balance: 50000,
            history: ["Khởi tạo tài khoản (+50,000 VNĐ)"],
            wonCodes: [],
            linkedAccounts: { SC88: [], C168: [], CM88: [], F8BET: [], ABCVIP: [], KJC_CU: [] },
            accountKho: { RR88: [], MM88: [], GG88: [], U888: [], J88: [], "88CLB": [], ABC8: [], XX8: [], ABCVIP: [], KJC_CU: [] }
        };
    }
    return users[chatId];
}

// ==========================================
// 2B. HENDY ADMINI BOT V3 SETTINGS + LOCAL VIETSUB
// ==========================================
function isAdminId(id) {
    return ADMIN_IDS.has(String(id ?? ''));
}

function getSettings(userId) {
    const id = String(userId ?? '');
    if (!userSettings[id]) userSettings[id] = { defaultMode: 'ask' };
    if (!OUTPUT_MODES[userSettings[id].defaultMode]) userSettings[id].defaultMode = 'ask';
    return userSettings[id];
}

function saveSettings() {
    fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(userSettings, null, 2), 'utf8');
}

function settingsText(userId) {
    const settings = getSettings(userId);
    const mode = OUTPUT_MODES[settings.defaultMode];
    return `⚙️ CÀI ĐẶT BOT HENDY\n\nChế độ mặc định: ${mode.label}\n${mode.description}\n\n🌐 Phát hiện ngôn ngữ: TỰ ĐỘNG (Whisper.cpp).\n🧠 Nhận diện và dịch chạy cục bộ, không yêu cầu OPENAI_API_KEY.\n\nChọn chế độ tự động áp dụng khi gửi video tiếp theo:`;
}

function settingsKeyboard(userId) {
    const selected = getSettings(userId).defaultMode;
    const modes = [
        ['ask', '❔ Hỏi mỗi lần', 'settings_mode_ask'],
        ['original', '📝 SRT nguyên ngữ', 'settings_mode_original'],
        ['vietnamese', '🇻🇳 Vietsub tiếng Việt', 'settings_mode_vietnamese'],
        ['burn-vietnamese', '🎞️ MP4 gắn phụ đề Việt', 'settings_mode_burn-vietnamese']
    ];
    return { inline_keyboard: [
        ...modes.map(([key, label, callback]) => [{ text: `${selected === key ? '✅ ' : ''}${label}`, callback_data: callback }]),
        [{ text: '⬅️ Quay lại Menu Chính', callback_data: 'back_start' }]
    ] };
}

function subtitleKeyboard() {
    return { inline_keyboard: [
        [{ text: '📝 SRT nguyên ngữ · tự nhận diện', callback_data: 'subtitle_original' }],
        [{ text: '🇻🇳 Vietsub tiếng Việt · offline', callback_data: 'subtitle_vietnamese' }],
        [{ text: '🎞️ MP4 gắn phụ đề Việt · offline', callback_data: 'subtitle_burn_vietnamese' }],
        [{ text: '⚙️ Đổi chế độ mặc định', callback_data: 'bot_settings' }],
        [{ text: '🔙 Menu chính', callback_data: 'back_start' }]
    ] };
}

function subtitleAllowed(userId) {
    const id = String(userId ?? '');
    return isAdminId(id) || SUBTITLE_ALLOWED_IDS.has(id);
}

function extractVideo(message) {
    if (message?.video) return {
        fileId: message.video.file_id,
        fileName: message.video.file_name || `telegram-video-${message.message_id}.mp4`,
        fileSize: message.video.file_size,
        mimeType: message.video.mime_type || 'video/mp4'
    };
    if (message?.video_note) return {
        fileId: message.video_note.file_id,
        fileName: `telegram-video-note-${message.message_id}.mp4`,
        fileSize: message.video_note.file_size,
        mimeType: 'video/mp4'
    };
    const doc = message?.document;
    if (doc && ((doc.mime_type || '').startsWith('video/') || /\.(mp4|mov|mkv|webm|m4v|avi)$/i.test(doc.file_name || ''))) {
        return { fileId: doc.file_id, fileName: doc.file_name || `telegram-video-${message.message_id}.mp4`, fileSize: doc.file_size, mimeType: doc.mime_type || 'video/mp4' };
    }
    return null;
}

const subtitleBotAdapter = {
    telegram: {
        async getFile(fileId) {
            const response = await callTelegramApi('getFile', { file_id: fileId });
            if (!response?.ok || !response.result?.file_path) throw new Error(response?.description || 'Telegram không cung cấp đường dẫn tải video.');
            return response.result;
        }
    }
};

async function sendLocalFile(chatId, method, filePath, fileName, caption) {
    const bytes = await fs.promises.readFile(filePath);
    const form = new FormData();
    form.set('chat_id', String(chatId));
    if (caption) form.set('caption', caption);
    form.set(method === 'sendVideo' ? 'video' : 'document', new Blob([bytes]), fileName);
    const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, { method: 'POST', body: form });
    const payload = await response.json();
    if (!response.ok || !payload.ok) throw new Error(payload.description || `Telegram ${method} thất bại.`);
    return payload.result;
}

async function processSubtitleJob(chatId, userId, video, mode) {
    const jobKey = `${chatId}:${userId}`;
    if (activeSubtitleJobs.has(jobKey)) {
        await callTelegramApi('sendMessage', { chat_id: chatId, text: '⏳ Bạn đang có một tác vụ phụ đề chạy. Vui lòng chờ tác vụ đó hoàn thành.' });
        return;
    }
    if (!subtitleAllowed(userId)) {
        await callTelegramApi('sendMessage', { chat_id: chatId, text: '🔒 Tài khoản chưa được cấp quyền Vietsub. Admin hãy thêm Telegram ID vào SUBTITLE_ALLOWED_IDS hoặc ADMIN_IDS.' });
        return;
    }
    activeSubtitleJobs.add(jobKey);
    const progressResponse = await callTelegramApi('sendMessage', { chat_id: chatId, text: '⏳ Đang chuẩn bị xử lý video bằng Whisper.cpp…' });
    const progressId = progressResponse?.result?.message_id;
    const updateProgress = async (text) => {
        if (progressId) await callTelegramApi('editMessageText', { chat_id: chatId, message_id: progressId, text }).catch(() => {});
    };
    let result;
    try {
        result = await createSubtitles({
            bot: subtitleBotAdapter,
            fileId: video.fileId,
            fileName: video.fileName,
            mode,
            onProgress: updateProgress
        });
        await updateProgress(`✅ Đã nhận diện ${result.sourceLanguageName}; ${result.segmentCount} đoạn phụ đề. Đang gửi tệp…`);
        const srtName = result.language === 'vi' ? 'vietsub_vi.srt' : 'subtitles_original.srt';
        await sendLocalFile(chatId, 'sendDocument', result.srtPath, srtName,
            result.language === 'vi' ? '🇻🇳 Phụ đề tiếng Việt' : `📝 Phụ đề nguyên ngữ (${result.sourceLanguageName})`);
        await sendLocalFile(chatId, 'sendDocument', result.textPath, 'transcript.txt', '📄 Bản lời thoại dạng văn bản');
        if (result.videoPath) {
            const stat = await fs.promises.stat(result.videoPath);
            if (stat.size > 49 * 1024 * 1024) {
                await callTelegramApi('sendMessage', { chat_id: chatId, text: '⚠️ Video đã render nhưng vượt giới hạn gửi qua Bot API. Hãy dùng video ngắn hơn hoặc nén video.' });
            } else {
                await sendLocalFile(chatId, 'sendVideo', result.videoPath, 'hendy-vietsub.mp4', '🎬 Video đã gắn cứng phụ đề tiếng Việt');
            }
        }
        await updateProgress('✅ Hoàn tất! Tệp phụ đề đã được gửi phía trên.');
    } catch (error) {
        console.error('Subtitle processing error:', error);
        await updateProgress(`❌ Không tạo được phụ đề: ${String(error?.message || 'Lỗi không xác định').slice(0, 700)}`);
    } finally {
        if (result) await cleanupSubtitles(result);
        activeSubtitleJobs.delete(jobKey);
    }
}

async function handleIncomingVideo(message) {
    const chatId = String(message.chat.id);
    const userId = String(message.from?.id ?? '');
    const video = extractVideo(message);
    if (!video) return false;
    if (!subtitleAllowed(userId)) {
        await callTelegramApi('sendMessage', { chat_id: chatId, text: '🔒 Chức năng Vietsub hiện chỉ dành cho Admin hoặc ID được cấp trong SUBTITLE_ALLOWED_IDS.' });
        return true;
    }
    if (video.fileSize && video.fileSize > MAX_VIDEO_MB * 1024 * 1024) {
        await callTelegramApi('sendMessage', { chat_id: chatId, text: `⚠️ Video vượt giới hạn ${MAX_VIDEO_MB} MB. Hãy giảm dung lượng hoặc cắt ngắn video rồi gửi lại.` });
        return true;
    }
    pendingVideos.set(`${chatId}:${userId}`, video);
    const mode = getSettings(userId).defaultMode;
    if (mode === 'ask') {
        await callTelegramApi('sendMessage', {
            chat_id: chatId,
            text: `✅ Đã nhận video: ${video.fileName}\n\nChọn cách tạo phụ đề:`,
            reply_markup: subtitleKeyboard()
        });
    } else {
        await callTelegramApi('sendMessage', { chat_id: chatId, text: `⚙️ Đang dùng chế độ mặc định: ${OUTPUT_MODES[mode].label}` });
        void processSubtitleJob(chatId, userId, video, OUTPUT_MODES[mode].mode);
    }
    return true;
}

// ==========================================
// 3. HÀM TẠO GIAO DIỆN MENU CHÍNH
// ==========================================
function getMainMenuKeyboard() {
    return {
        inline_keyboard: [
            [{ text: '🛍️ TRUNG TÂM MUA CODE MINI TRỰC TIẾP', callback_data: 'shop_code_mini' }],
            [{ text: '🌐 DỊCH VỤ MẠNG XÃ HỘI', callback_data: 'social_service' }],
            [{ text: '💳 NẠP TIỀN', callback_data: 'deposit' }],
            [{ text: '💎 TRUNG TÂM KHÁCH HÀNG', callback_data: 'cshk_center' }],
            [{ text: '🤖 BOT DỊCH VỤ VIETSUB (PIPELINE)', callback_data: 'bot_vietsub' }],
            [{ text: '🚀 COMPOSE WEB / TMA KTOR ENTRYPOINT', callback_data: 'compose_web_tma' }],
            [{ text: '🎧 LIÊN HỆ CSKH', url: 'https://t.me/your_support' }],
            [{ text: '🛠 ADMIN QUẢN LÝ XÂY DỰNG PHÁT TRIỂN Vietsub', callback_data: 'admin_panel' }],
            [{ text: '⚙️ CÀI ĐẶT BOT · VIETSUB', callback_data: 'bot_settings' }]
        ]
    };
}

// ==========================================
// 4. LOGIC XỬ LÝ TOÀN BỘ CẬP NHẬT (UPDATE)
// ==========================================
async function handleUpdate(update) {
    // Video được xử lý trước nhánh văn bản để hỗ trợ video/video note/document.
    if (update.message && extractVideo(update.message)) {
        await handleIncomingVideo(update.message);
        return;
    }

    // A. XỬ LÝ TIN NHẮN VĂN BẢN (TEXT & TRẠNG THÁI NHẬP LIỆU)
    if (update.message && update.message.text) {
        const msg = update.message;
        const chatId = msg.chat.id.toString();
        const text = msg.text.trim();
        const u = initUser(chatId, msg.from);

        // Lệnh /start
        if (text.startsWith('/start')) {
            delete userStates[chatId];
            const welcomeMessage = `
🤖 *BOT HENDY CYBERTECH 2026* [RENDER HOSTED] 🚀
Buổi chiều vui vẻ nhé, *${u.name}* (ID: \`${chatId}\`)
--------------------------------------------------
💎 *VIP 0*
💰 **Ví Chính:** \`${u.balance.toLocaleString()} VNĐ\`
            `;
            await callTelegramApi('sendMessage', {
                chat_id: chatId,
                text: welcomeMessage,
                parse_mode: 'Markdown',
                reply_markup: getMainMenuKeyboard()
            });
            return;
        }

        if (text === '/settings' || text.startsWith('/settings@')) {
            await callTelegramApi('sendMessage', { chat_id: chatId, text: settingsText(msg.from.id), reply_markup: settingsKeyboard(msg.from.id) });
            return;
        }
        if (text === '/menu' || text.startsWith('/menu@')) {
            await callTelegramApi('sendMessage', { chat_id: chatId, text: '🧭 MENU CHÍNH', reply_markup: getMainMenuKeyboard() });
            return;
        }
        if (text === '/help' || text.startsWith('/help@')) {
            await callTelegramApi('sendMessage', { chat_id: chatId, text: `🎬 VIETSUB CỤC BỘ\n\nGửi video cho bot để tạo SRT nguyên ngữ, Vietsub tiếng Việt hoặc MP4 gắn phụ đề. Whisper.cpp tự phát hiện ngôn ngữ cục bộ; Argos Translate dịch offline. Không cần OPENAI_API_KEY.\n\nGiới hạn nguồn hiện tại: ${MAX_VIDEO_MB} MB.` , reply_markup: getMainMenuKeyboard() });
            return;
        }

        // KIỂM TRA TRẠNG THÁI NHẬP LIỆU TẠM THỜI (user_states)
        if (userStates[chatId]) {
            const state = userStates[chatId];
            const action = state.action;

            if (action === 'waiting_add_acc') {
                const brand = state.brand;
                if (!u.accountKho[brand]) u.accountKho[brand] = [];
                
                u.accountKho[brand].push({ acc: text, checked: true });
                delete userStates[chatId];

                const successMsg = `✅ *THÊM TÀI KHOẢN THÀNH CÔNG!*\n\n📦 Kho: *${brand}*\n🔑 Thông tin: \`${text}\``;
                const kb = {
                    inline_keyboard: [
                        [{ text: "◀ Quay lại Kho " + brand, callback_data: "shop_kho_detail_" + brand }]
                    ]
                };
                await callTelegramApi('sendMessage', { chat_id: chatId, text: successMsg, parse_mode: 'Markdown', reply_markup: kb });
                return;
            }

            if (action === 'waiting_link_account') {
                const brand = state.brand;
                if (!u.linkedAccounts[brand]) u.linkedAccounts[brand] = [];
                u.linkedAccounts[brand].push(text);
                u.history.push(`Liên kết tài khoản ${brand}:${text}`);

                delete userStates[chatId];
                const successMsg = `✅ *LIÊN KẾT THÀNH CÔNG!*\n\n🏢 Sảnh: *${brand}*\n🔑 Tài khoản: \`${text}\``;
                const kb = { inline_keyboard: [[{ text: "◀ Quay lại", callback_data: brand === "KJC_CU" ? "shop_kjc_cu_kho" : "cshk_center" }]] };
                await callTelegramApi('sendMessage', { chat_id: chatId, text: successMsg, parse_mode: 'Markdown', reply_markup: kb });
                return;
            }

            if (action === 'waiting_live_link') {
                const platform = state.platform;
                const cost = platform === "TikTok" ? 10000 : 15000;
                
                if (u.balance < cost) {
                    delete userStates[chatId];
                    const errorMsg = `❌ *GIAO DỊCH THẤT BẠI*\nSố dư (\`${u.balance.toLocaleString()} VNĐ\`) không đủ mua 1K mắt ${platform}.`;
                    const kb = { inline_keyboard: [[{ text: "💳 Nạp Tiền", callback_data: "deposit" }, { text: "🔙 Menu", callback_data: "back_start" }]] };
                    await callTelegramApi('sendMessage', { chat_id: chatId, text: errorMsg, parse_mode: 'Markdown', reply_markup: kb });
                    return;
                }

                u.balance -= cost;
                u.history.push(`Mua 1K mắt ${platform} Live (-${cost.toLocaleString()} VNĐ)`);
                delete userStates[chatId];

                const successBuff = `🚀 *BUFF MẮT THÀNH CÔNG!*\n🎵 Nền tảng: *${platform}*\n🔗 Link: ${text}\n💰 Trừ: \`-${cost.toLocaleString()} VNĐ\`\n💵 Số dư còn lại: \`${u.balance.toLocaleString()} VNĐ\``;
                const kb = { inline_keyboard: [[{ text: "🔙 Quay lại Menu Chính", callback_data: "back_start" }]] };
                await callTelegramApi('sendMessage', { chat_id: chatId, text: successBuff, parse_mode: 'Markdown', reply_markup: kb });
                return;
            }

            if (action === 'waiting_video_link') {
                delete userStates[chatId];
                const successMsg = `🎬 *ĐÃ NHẬN YÊU CẦU*\n\nVideo của bạn đã được đưa vào hệ thống Media Pipeline qua Ktor Client / WebSocket Backend.`;
                const kb = { inline_keyboard: [[{ text: "🔙 Quay lại Menu Chính", callback_data: "back_start" }]] };
                await callTelegramApi('sendMessage', { chat_id: chatId, text: successMsg, parse_mode: 'Markdown', reply_markup: kb });
                return;
            }
        }
    }

    // B. XỬ LÝ NÚT BẤM (CALLBACK QUERY)
    if (update.callback_query) {
        const query = update.callback_query;
        const chatId = query.message.chat.id.toString();
        const messageId = query.message.message_id;
        const data = query.data;

        const u = initUser(chatId, query.from);
        await callTelegramApi('answerCallbackQuery', { callback_query_id: query.id });

        // V3 Settings: menu mở được cho mọi người; các nút admin vẫn được kiểm soát bằng quyền riêng.
        if (data === 'bot_settings') {
            await callTelegramApi('editMessageText', {
                chat_id: chatId, message_id: messageId, text: settingsText(query.from.id),
                reply_markup: settingsKeyboard(query.from.id)
            });
            return;
        }
        if (data.startsWith('settings_mode_')) {
            const modeKey = data.slice('settings_mode_'.length);
            const modeMap = {
                ask: 'ask', original: 'original', vietnamese: 'vietnamese', 'burn-vietnamese': 'burn-vietnamese'
            };
            if (!Object.hasOwn(modeMap, modeKey)) return;
            getSettings(query.from.id).defaultMode = modeMap[modeKey];
            try {
                saveSettings();
                await callTelegramApi('editMessageText', {
                    chat_id: chatId, message_id: messageId, text: settingsText(query.from.id),
                    reply_markup: settingsKeyboard(query.from.id)
                });
            } catch (error) {
                console.error('Không lưu được cài đặt:', error);
                await callTelegramApi('sendMessage', { chat_id: chatId, text: '❌ Không lưu được cài đặt trên máy chủ. Hãy kiểm tra quyền ghi thư mục SETTINGS_FILE.' });
            }
            return;
        }
        if (data === 'subtitle_original' || data === 'subtitle_vietnamese' || data === 'subtitle_burn_vietnamese') {
            const userId = String(query.from.id);
            if (!subtitleAllowed(userId)) {
                await callTelegramApi('sendMessage', { chat_id: chatId, text: '🔒 Tài khoản chưa được cấp quyền Vietsub.' });
                return;
            }
            const video = pendingVideos.get(`${chatId}:${userId}`);
            if (!video) {
                await callTelegramApi('sendMessage', { chat_id: chatId, text: 'Hãy gửi video cho bot trước, sau đó chọn chế độ phụ đề.' });
                return;
            }
            const selectedMode = data === 'subtitle_original' ? 'original' : (data === 'subtitle_vietnamese' ? 'vietnamese' : 'burn-vietnamese');
            void processSubtitleJob(chatId, userId, video, selectedMode);
            return;
        }

        if (data === 'back_start') {
            delete userStates[chatId];
            const welcomeMessage = `
🤖 *BOT HENDY CYBERTECH 2026* [RENDER HOSTED] 🚀
Chào mừng bạn quay lại, *${u.name}* (ID: \`${chatId}\`)
--------------------------------------------------
💎 *VIP 0*
💰 **Ví Chính:** \`${u.balance.toLocaleString()} VNĐ\`
            `;
            await callTelegramApi('editMessageText', {
                chat_id: chatId,
                message_id: messageId,
                text: welcomeMessage,
                parse_mode: 'Markdown',
                reply_markup: getMainMenuKeyboard()
            });
            return;
        }

        let subMenuText = '';
        let subMenuKeyboard = {
            inline_keyboard: [
                [{ text: '🔙 Quay lại Menu Chính', callback_data: 'back_start' }]
            ]
        };

        if (data === 'shop_code_mini') {
            subMenuText = `🛍️ *TRUNG TÂM MUA CODE MINI TRỰC TIẾP*\n\nVui lòng chọn sảnh hoặc gói mã code bên dưới:`;
            subMenuKeyboard = {
                inline_keyboard: [
                    [
                        { text: '🚀 Liên Minh KJC', callback_data: 'shop_kjc' },
                        { text: '🚀 Liên Minh KJC CŨ', callback_data: 'shop_kjc_cu' }
                    ],
                    [
                        { text: '🚀 Liên Minh ABCVIP', callback_data: 'shop_abcvip_group' }
                    ],
                    [
                        { text: '🐶 TRỞ VỀ MENU CHÍNH', callback_data: 'back_start' }
                    ]
                ]
            };
        }

        else if (data === 'shop_kjc_cu') {
            const rr88Count = (u.accountKho.RR88 || []).length;
            const mm88Count = (u.accountKho.MM88 || []).length;
            const gg88Count = (u.accountKho.GG88 || []).length;

            subMenuText = (
                `🎮 *LIÊN MINH KJC CŨ (RR88 • MM88 • GG88)*\n` +
                `----------------------------------------\n` +
                `👤 Chào *${u.name}*\n` +
                `📊 *THỐNG KÊ KHO ACC:*\n` +
                `• Kho RR88: \`${rr88Count}\` tài khoản\n` +
                `• Kho MM88: \`${mm88Count}\` tài khoản\n` +
                `• Kho GG88: \`${gg88Count}\` tài khoản\n` +
                `✅ Liên kết thành công tài khoản: \`${(u.linkedAccounts.KJC_CU || []).length}\``
            );
            subMenuKeyboard = {
                inline_keyboard: [
                    [{ text: '🎮 RR88 MINI GAME', callback_data: 'shop_kho_detail_RR88' }],
                    [{ text: '🎮 MM88 MINI GAME', callback_data: 'shop_kho_detail_MM88' }],
                    [{ text: '🎮 GG88 MINI GAME', callback_data: 'shop_kho_detail_GG88' }],
                    [{ text: '🌊 【KHO ACC KJC CŨ LIÊN KẾT BOT】', callback_data: 'shop_kjc_cu_kho' }],
                    [{ text: '« QUAY LẠI', callback_data: 'shop_code_mini' }]
                ]
            };
        }

        else if (data === 'shop_kjc_cu_kho') {
            const accList = u.linkedAccounts.KJC_CU || [];
            let str = accList.length > 0 ? accList.map((a, i) => `${i+1}. \`${a}\``).join('\n') : 'Bạn chưa liên kết tài khoản KJC CŨ nào.';
            subMenuText = `🚀 *LIÊN MINH KJC CŨ*\n\n🎁 *KHO TÀI KHOẢN KJC CŨ ĐÃ LIÊN KẾT:*\n\n${str}`;
            subMenuKeyboard = {
                inline_keyboard: [
                    [{ text: '➕ THÊM LIÊN KẾT MỚI (AUTO)', callback_data: 'link_KJC_CU' }],
                    [{ text: '❌ XÓA LIÊN KẾT', callback_data: 'clear_link_KJC_CU' }],
                    [{ text: '« Quay lại', callback_data: 'shop_kjc_cu' }]
                ]
            };
        }

        else if (data === 'clear_link_KJC_CU') {
            u.linkedAccounts.KJC_CU = [];
            subMenuText = `🗑️ Đã xóa toàn bộ liên kết tài khoản Liên Minh KJC CŨ!`;
            subMenuKeyboard = { inline_keyboard: [[{ text: '« Quay lại', callback_data: 'shop_kjc_cu_kho' }]] };
        }

        else if (data === 'shop_abcvip_group') {
            subMenuText = (
                `📊 *THỐNG KÊ ĐƠN ABCVIP:*\n` +
                `🔴 Tổng đơn đang chạy: \`0\`\n` +
                `>> U888: \`0\`\n` +
                `>> J88: \`0\`\n` +
                `>> 88CLB: \`0\`\n` +
                `>> ABC8: \`0\`\n` +
                `>> XX8: \`0\`\n` +
                `⏳ Đang chờ duyệt: \`0\`\n` +
                `✅ Liên kết thành công tài khoản: \`${(u.linkedAccounts.ABCVIP || []).length}\``
            );
            subMenuKeyboard = {
                inline_keyboard: [
                    [{ text: '❤️ U888 MINIGAME', callback_data: 'shop_kho_detail_U888' }],
                    [{ text: '❤️ J88 MINIGAME', callback_data: 'shop_kho_detail_J88' }],
                    [{ text: '❤️ 88CLB MINIGAME', callback_data: 'shop_kho_detail_88CLB' }],
                    [{ text: '❤ ABC8 MINIGAME', callback_data: 'shop_kho_detail_ABC8' }],
                    [{ text: '❤️ XX8 MINIGAME', callback_data: 'shop_kho_detail_XX8' }],
                    [{ text: '🌊 【KHO ACC ABCVIP LIÊN KẾT BOT】', callback_data: 'shop_abcvip_kho' }],
                    [{ text: '« Quay lại', callback_data: 'shop_code_mini' }]
                ]
            };
        }

        else if (data === 'shop_abcvip_kho') {
            const accList = u.linkedAccounts.ABCVIP || [];
            let str = accList.length > 0 ? accList.map((a, i) => `${i+1}. \`${a}\``).join('\n') : 'Bạn chưa liên kết tài khoản ABCVIP nào.';
            subMenuText = `LIÊN MINH ABCVIP\n\n🎁 *KHO TÀI KHOẢN ABCVIP CỦA BẠN:*\n\n${str}`;
            subMenuKeyboard = {
                inline_keyboard: [
                    [{ text: '➕ THÊM LIÊN KẾT MỚI (AUTO)', callback_data: 'link_ABCVIP' }],
                    [{ text: '❌ XÓA LIÊN KẾT', callback_data: 'clear_link_ABCVIP' }],
                    [{ text: '« Quay lại', callback_data: 'shop_abcvip_group' }]
                ]
            };
        }

        else if (data.startsWith('shop_kho_detail_')) {
            const brand = data.replace('shop_kho_detail_', '');
            const list = u.accountKho[brand] || [];
            const total = list.length;
            const checked = list.filter(item => item.checked).length;
            const unchecked = total - checked;
            const emptyNotice = total === 0 ? '\n\n_Kho chưa có tài khoản nào._' : '';

            subMenuText = (
                `📦 *KHO ACC ${brand}*\n` +
                `----------------------------------------\n` +
                `📊 Tổng: \`${total}/50\` tài khoản\n` +
                `✅ Đã check: \`${checked}\` \n` +
                `⏳ Chưa check: \`${unchecked}\` \n` +
                `----------------------------------------` +
                emptyNotice
            );
            subMenuKeyboard = {
                inline_keyboard: [
                    [{ text: '➕ THÊM ACC VÀO KHO', callback_data: `add_acc_${brand}` }],
                    [{ text: '🔍 CHECK ACC', callback_data: `check_acc_${brand}` }],
                    [{ text: '🗑️ XÓA ACC', callback_data: `clear_acc_${brand}` }],
                    [{ text: '« QUAY LẠI', callback_data: 'shop_code_mini' }]
                ]
            };
        }

        else if (data.startsWith('add_acc_')) {
            const brand = data.replace('add_acc_', '');
            userStates[chatId] = { action: 'waiting_add_acc', brand: brand };
            subMenuText = `➕ *THÊM ACC VÀO KHO ${brand}*\n\n👉 Vui lòng nhập **Tài khoản | Mật khẩu** của bạn vào khung chat:`;
        }

        else if (data === 'link_KJC_CU') {
            userStates[chatId] = { action: 'waiting_link_account', brand: 'KJC_CU' };
            subMenuText = `➕ *LIÊN KẾT TÀI KHOẢN KJC CŨ*\n\n👉 Vui lòng nhập tài khoản cần liên kết vào khung chat:`;
        }

        else if (data === 'link_ABCVIP') {
            userStates[chatId] = { action: 'waiting_link_account', brand: 'ABCVIP' };
            subMenuText = `➕ *LIÊN KẾT TÀI KHOẢN ABCVIP*\n\n👉 Vui lòng nhập tài khoản cần liên kết vào khung chat:`;
        }

        else if (data.startsWith('check_acc_')) {
            const brand = data.replace('check_acc_', '');
            subMenuText = `🔍 *KIỂM TRA TÀI KHOẢN ${brand}*\n\nHệ thống đã quét toàn bộ tài khoản trong kho. Tất cả tài khoản hợp lệ!`;
            subMenuKeyboard = { inline_keyboard: [[{ text: '« Quay lại', callback_data: `shop_kho_detail_${brand}` }]] };
        }

        else if (data.startsWith('clear_acc_')) {
            const brand = data.replace('clear_acc_', '');
            u.accountKho[brand] = [];
            subMenuText = `🗑️ Đã xóa toàn bộ tài khoản trong kho *${brand}*!`;
            subMenuKeyboard = { inline_keyboard: [[{ text: '« Quay lại', callback_data: `shop_kho_detail_${brand}` }]] };
        }

        else if (data === 'clear_link_ABCVIP') {
            u.linkedAccounts.ABCVIP = [];
            subMenuText = `🗑️ Đã xóa toàn bộ liên kết tài khoản ABCVIP!`;
            subMenuKeyboard = { inline_keyboard: [[{ text: '« Quay lại', callback_data: 'shop_abcvip_kho' }]] };
        }

        else if (data === 'shop_kjc') {
            subMenuText = `🚀 *LIÊN MINH KJC*\nĐang cập nhật các gói code quà tặng KJC mới nhất...`;
            subMenuKeyboard = { inline_keyboard: [[{ text: '« Quay lại', callback_data: 'shop_code_mini' }]] };
        }

        else if (data === 'social_service') {
            subMenuText = '🌐 *DỊCH VỤ MẠNG XÃ HỘI*\nHệ thống buff tương tác tự động. Vui lòng chọn dịch vụ:';
            subMenuKeyboard = {
                inline_keyboard: [
                    [{ text: '🎵 Buff 1K Mắt TikTok Live (10k VNĐ)', callback_data: 'buff_tiktok' }],
                    [{ text: '📘 Buff 1K Mắt Facebook Live (15k VNĐ)', callback_data: 'buff_fb' }],
                    [{ text: '🔙 Quay lại Menu Chính', callback_data: 'back_start' }]
                ]
            };
        } 

        else if (data === 'buff_tiktok') {
            userStates[chatId] = { action: 'waiting_live_link', platform: 'TikTok' };
            subMenuText = '🎵 *BUFF 1K MẮT TIKTOK LIVE*\n\n👉 Gửi **Link hoặc Username Livestream TikTok** vào khung chat:';
        }

        else if (data === 'buff_fb') {
            userStates[chatId] = { action: 'waiting_live_link', platform: 'Facebook' };
            subMenuText = '📘 *BUFF 1K MẮT FACEBOOK LIVE*\n\n👉 Gửi **Link Livestream Facebook** vào khung chat:';
        }

        else if (data === 'deposit') {
            subMenuText = '💳 *NẠP TIỀN VÀO HỆ THỐNG*\nChuyển khoản tự động qua Momo/Banking.\nSố dư hiện tại của bạn: `' + u.balance.toLocaleString() + ' VNĐ`';
        } 

        else if (data === 'cshk_center') {
            subMenuText = (
                `🎴 *TRUNG TÂM QUẢN LÝ TÀI KHOẢN*\n\n` +
                `Chọn một trong hai cách truy cập bên dưới:\n` +
                `• *Mini App:* Trải nghiệm mới, mượt mà hơn (khuyến nghị).\n` +
                `• *Đăng nhập truyền thống:* link có hiệu lực 5 phút.`
            );
            subMenuKeyboard = {
                inline_keyboard: [
                    [{ text: '🚀 [MINI APP] BẢN MỚI | CHỈ MOBILE', web_app: { url: MINI_APP_URL } }],
                    [{ text: '🔑 PHIÊN BẢN WEB CŨ', url: WEB_APP_URL }],
                    [{ text: '⬅️ TRỞ VỀ MENU CHÍNH', callback_data: 'back_start' }]
                ]
            };
        }

        else if (data === 'compose_web_tma') {
            subMenuText = (
                `🚀 *COMPOSE WEB & TELEGRAM WEBSDK (TMA)*\n\n` +
                `Đã khởi tạo *JS Entrypoint* thành công cho Kotlin/Compose Web Target!\n` +
                `• *Ktor Client:* Đã sẵn sàng kết nối WebSocket & HTTP Gateway.\n` +
                `• *Telegram WebApp SDK:* Đã bind sự dụng window.Telegram.WebApp.`
            );
            subMenuKeyboard = {
                inline_keyboard: [
                    [{ text: '🌐 Mở Compose Web App (TMA)', web_app: { url: MINI_APP_URL } }],
                    [{ text: '🔙 Quay lại Menu Chính', callback_data: 'back_start' }]
                ]
            };
        }

        else if (data === 'admin_panel') {
            if (!isAdminId(query.from.id)) {
                subMenuText = '⛔ Bạn không có quyền truy cập khu vực quản trị!';
            } else {
                const totalUsers = Object.keys(users).length;
                subMenuText = `🛠️ *ADMIN QUẢN LÝ XÂY DỰNG PHÁT TRIỂN Vietsub*\n\n📊 Thống kê: Có \`${totalUsers}\` user đang hoạt động.`;
                subMenuKeyboard = {
                    inline_keyboard: [
                        [{ text: '👥 Danh Sách User Online', callback_data: 'admin_list_users' }],
                        [{ text: '⚡ Ký Lệnh Quản Trị Ktor Client', callback_data: 'admin_ktor_trigger' }],
                        [{ text: '🔙 Quay lại Menu Chính', callback_data: 'back_start' }]
                    ]
                };
            }
        }

        else if (data === 'admin_list_users') {
            if (!isAdminId(query.from.id)) return;
            let userListStr = "";
            let i = 1;
            for (let id in users) {
                if (i > 10) { userListStr += `... và còn nhiều user khác.`; break; }
                userListStr += `${i}.${users[id].name} (\`${id}\`) - Ví: ${users[id].balance.toLocaleString()}đ\n`;
                i++;
            }
            subMenuText = `👥 *DANH SÁCH THÀNH VIÊN*\n\n${userListStr || 'Chưa có user nào.'}`;
            subMenuKeyboard = { inline_keyboard: [[{ text: '◀ Quay lại Admin', callback_data: 'admin_panel' }]] };
        }

        else if (data === 'admin_ktor_trigger') {
            if (!isAdminId(query.from.id)) return;
            const res = await sendAdminCommandViaKtorClient('FORCE_SYNC_ALL_PIPELINES', chatId);
            subMenuText = `⚡ *KẾT QUẢ KTOR CLIENT GỬI LỆNH ADMIN*\n\nTrạng thái phản hồi từ Core Backend:\n\`${JSON.stringify(res, null, 2)}\``;
            subMenuKeyboard = { inline_keyboard: [[{ text: '◀ Quay lại Admin', callback_data: 'admin_panel' }]] };
        }

        else if (data === 'bot_vietsub') {
            try {
                await fetch(`${CORE_BACKEND_URL}/api/bot-trigger`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ 
                        chatId: chatId, 
                        userName: u.name, 
                        action: 'START_VIETSUB_PIPELINE' 
                    })
                });

                subMenuText = `🎬 *BOT DỊCH VỤ VIETSUB V3.0*\n\n✅ Đã gửi lệnh kích hoạt luồng xử lý Video AI đến Core Backend!\n\nVui lòng gửi link Video bạn muốn xử lý vào đây.`;
                userStates[chatId] = { action: 'waiting_video_link' };
            } catch (err) {
                subMenuText = `🔴 *MẤT KẾT NỐI*\nKhông thể kết nối đến Máy chủ Core Backend.`;
            }
            
            subMenuKeyboard = {
                inline_keyboard: [[{ text: '🔙 Quay lại Menu Chính', callback_data: 'back_start' }]]
            };
        }

        await callTelegramApi('editMessageText', {
            chat_id: chatId,
            message_id: messageId,
            text: subMenuText,
            parse_mode: 'Markdown',
            reply_markup: subMenuKeyboard
        });
    }
}