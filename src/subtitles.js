import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const MB = 1024 * 1024;
const parsedMaxMb = Number.parseInt(process.env.MAX_VIDEO_MB || '20', 10);
const DEFAULT_MAX_MB = Number.isFinite(parsedMaxMb) && parsedMaxMb > 0 ? parsedMaxMb : 20;
const FFMPEG_PATH = process.env.FFMPEG_PATH || 'ffmpeg';
const WHISPER_CPP_PATH = process.env.WHISPER_CPP_PATH || 'whisper-cli';
const WHISPER_MODEL_PATH = process.env.WHISPER_MODEL_PATH || '';
const PYTHON_PATH = process.env.PYTHON_PATH || 'python3';

const LANGUAGE_NAMES = {
  af: 'Afrikaans', ar: 'Ả Rập', az: 'Azerbaijan', be: 'Belarus', bg: 'Bulgaria', bn: 'Bengali',
  bs: 'Bosnia', ca: 'Catalan', cs: 'Séc', cy: 'Wales', da: 'Đan Mạch', de: 'Đức', el: 'Hy Lạp',
  en: 'English', es: 'Tây Ban Nha', et: 'Estonia', fa: 'Ba Tư', fi: 'Phần Lan', fr: 'Pháp',
  gl: 'Galicia', he: 'Do Thái', hi: 'Hindi', hr: 'Croatia', hu: 'Hungary', id: 'Indonesia',
  is: 'Iceland', it: 'Ý', ja: 'Nhật', jw: 'Java', ko: 'Hàn', la: 'Latin', lt: 'Lithuania',
  lv: 'Latvia', mk: 'Macedonia', mr: 'Marathi', ms: 'Mã Lai', ne: 'Nepal', nl: 'Hà Lan',
  no: 'Na Uy', pa: 'Punjabi', pl: 'Ba Lan', pt: 'Bồ Đào Nha', ro: 'Romania', ru: 'Nga',
  sk: 'Slovak', sl: 'Slovenia', sq: 'Albania', sr: 'Serbia', su: 'Sunda', sv: 'Thụy Điển',
  sw: 'Swahili', ta: 'Tamil', te: 'Telugu', th: 'Thái', tl: 'Tagalog', tr: 'Thổ Nhĩ Kỳ',
  uk: 'Ukraina', ur: 'Urdu', vi: 'Tiếng Việt', yi: 'Yiddish', zh: 'Tiếng Trung', yue: 'Quảng Đông'
};

function safeName(name = 'telegram-video.mp4') {
  const parsed = path.parse(name);
  const clean = (parsed.name || 'telegram-video')
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}_-]+/gu, '_')
    .slice(0, 80) || 'telegram-video';
  const ext = (parsed.ext || '.mp4').toLowerCase().replace(/[^.a-z0-9]/g, '') || '.mp4';
  return `${clean}${ext}`;
}

function secondsToSrt(seconds) {
  const ms = Math.max(0, Math.round(Number(seconds || 0) * 1000));
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.floor((ms % 3_600_000) / 60_000);
  const secs = Math.floor((ms % 60_000) / 1000);
  const milli = ms % 1000;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')},${String(milli).padStart(3, '0')}`;
}

function toSrt(segments) {
  return segments.map((segment, index) => {
    const text = String(segment.text || '').trim().replace(/\s*\n\s*/g, ' ');
    return `${index + 1}\n${secondsToSrt(segment.start)} --> ${secondsToSrt(segment.end)}\n${text}\n`;
  }).join('\n');
}

async function downloadTelegramFile(bot, fileId, destination) {
  const info = await bot.telegram.getFile(fileId);
  if (!info.file_path) throw new Error('Telegram không trả về đường dẫn tải tệp.');
  const maxBytes = Math.max(1, DEFAULT_MAX_MB) * MB;
  if (info.file_size && info.file_size > maxBytes) {
    throw new Error(`Video có dung lượng ${(info.file_size / MB).toFixed(1)} MB, vượt giới hạn ${DEFAULT_MAX_MB} MB. Hãy gửi video nhỏ hơn.`);
  }
  const url = `https://api.telegram.org/file/bot${process.env.BOT_TOKEN}/${info.file_path}`;
  const response = await fetch(url);
  if (!response.ok || !response.body) throw new Error('Không tải được video từ Telegram.');
  let received = 0;
  const limitStream = new Transform({
    transform(chunk, _encoding, callback) {
      received += chunk.length;
      if (received > maxBytes) callback(new Error(`Video vượt giới hạn ${DEFAULT_MAX_MB} MB.`));
      else callback(null, chunk);
    }
  });
  await pipeline(Readable.fromWeb(response.body), limitStream, fs.createWriteStream(destination));
}

async function extractAudio(inputPath, audioPath) {
  await execFileAsync(FFMPEG_PATH, [
    '-hide_banner', '-loglevel', 'error', '-y', '-i', inputPath,
    '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-f', 'wav', audioPath
  ], { timeout: 10 * 60 * 1000, maxBuffer: 4 * MB });
  const stat = await fs.promises.stat(audioPath);
  if (!stat.size) throw new Error('Video không có âm thanh có thể xử lý.');
}

function timestampToSeconds(value, numericIsMilliseconds = false) {
  if (typeof value === 'number') return numericIsMilliseconds || value > 10000 ? value / 1000 : value;
  if (typeof value === 'string') {
    const match = value.match(/^(\d+):(\d{2}):(\d{2})[,.](\d{1,3})$/);
    if (match) return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number(match[4].padEnd(3, '0')) / 1000;
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric > 10000 ? numeric / 1000 : numeric;
  }
  return 0;
}

async function transcribeAudio(audioPath, outputBase) {
  if (!WHISPER_MODEL_PATH) {
    throw new Error('Chưa có WHISPER_MODEL_PATH. Hãy deploy bằng Dockerfile đi kèm hoặc cài whisper.cpp + model đa ngôn ngữ và cấu hình đường dẫn.');
  }
  try {
    await fs.promises.access(WHISPER_MODEL_PATH, fs.constants.R_OK);
  } catch {
    throw new Error(`Không tìm thấy mô hình nhận diện tại: ${WHISPER_MODEL_PATH}`);
  }
  try {
    await execFileAsync(WHISPER_CPP_PATH, [
      '-m', WHISPER_MODEL_PATH,
      '-f', audioPath,
      '-l', 'auto',
      '-ojf', '-osrt', '-of', outputBase,
      '-np'
    ], { timeout: Number(process.env.WHISPER_TIMEOUT_MS || 30 * 60 * 1000), maxBuffer: 16 * MB });
  } catch (error) {
    const detail = String(error?.stderr || error?.message || '').slice(-1400);
    throw new Error(`Whisper.cpp không xử lý được âm thanh. Kiểm tra WHISPER_CPP_PATH và model. ${detail}`);
  }

  const jsonPath = `${outputBase}.json`;
  let parsed;
  try {
    parsed = JSON.parse(await fs.promises.readFile(jsonPath, 'utf8'));
  } catch {
    throw new Error('Whisper.cpp đã chạy nhưng không tạo được JSON phụ đề. Kiểm tra phiên bản whisper-cli và quyền ghi thư mục.');
  }
  const sourceLanguage = String(parsed?.result?.language || parsed?.language || 'und').toLowerCase();
  const rawSegments = parsed?.transcription || parsed?.segments || [];
  const segments = rawSegments.map((item) => {
    const hasTimestampStrings = item.timestamps?.from !== undefined || item.timestamps?.to !== undefined;
    const hasOffsets = item.offsets?.from !== undefined || item.offsets?.to !== undefined;
    const startRaw = item.timestamps?.from ?? item.start ?? item.offsets?.from ?? 0;
    const endRaw = item.timestamps?.to ?? item.end ?? item.offsets?.to ?? startRaw;
    const start = timestampToSeconds(startRaw, hasOffsets && !hasTimestampStrings && item.start === undefined);
    let end = timestampToSeconds(endRaw, hasOffsets && !hasTimestampStrings && item.end === undefined);
    if (end <= start) end = start + 0.5;
    return { start, end, text: String(item.text || '').trim() };
  }).filter((segment) => segment.text);

  if (!segments.length) throw new Error('Không phát hiện được lời nói. Video có thể không có thoại rõ hoặc chỉ có nhạc nền.');
  return {
    sourceLanguage,
    sourceLanguageName: LANGUAGE_NAMES[sourceLanguage] || `ngôn ngữ ${sourceLanguage}`,
    segments
  };
}

async function translateSegmentsLocally(segments, sourceLanguage, workDir) {
  if (sourceLanguage === 'vi') return segments;
  if (!sourceLanguage || sourceLanguage === 'und') {
    throw new Error('Không xác định được ngôn ngữ nguồn; không thể chọn đúng mô hình dịch offline.');
  }
  const inputPath = path.join(workDir, 'translation-input.json');
  const outputPath = path.join(workDir, 'translation-output.json');
  await fs.promises.writeFile(inputPath, JSON.stringify(segments.map((segment) => segment.text)), 'utf8');
  try {
    await execFileAsync(PYTHON_PATH, [
      path.join(MODULE_DIR, 'local_translate.py'), sourceLanguage, inputPath, outputPath
    ], { timeout: Number(process.env.TRANSLATION_TIMEOUT_MS || 30 * 60 * 1000), maxBuffer: 8 * MB });
  } catch (error) {
    const detail = String(error?.stderr || error?.stdout || error?.message || '').slice(-1000);
    throw new Error(`Dịch offline thất bại. Hãy kiểm tra Argos Translate và kết nối mạng lần đầu để tải mô hình ngôn ngữ nếu chưa có. ${detail}`);
  }
  const result = JSON.parse(await fs.promises.readFile(outputPath, 'utf8'));
  if (!Array.isArray(result) || result.length !== segments.length) {
    throw new Error('Bộ dịch offline trả về số câu không khớp, đã dừng để tránh lệch phụ đề.');
  }
  return segments.map((segment, index) => ({ ...segment, text: String(result[index] || segment.text).trim() }));
}

function ffmpegSubtitleFilter(srtPath) {
  const escapedPath = srtPath.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
  return `subtitles='${escapedPath}':force_style='FontName=Arial,FontSize=22,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BorderStyle=1,Outline=2,Shadow=1,Alignment=2,MarginV=38'`;
}

async function burnSubtitles(videoPath, srtPath, outputPath) {
  await execFileAsync(FFMPEG_PATH, [
    '-hide_banner', '-loglevel', 'error', '-y', '-i', videoPath,
    '-vf', ffmpegSubtitleFilter(srtPath),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '25',
    '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart', outputPath
  ], { timeout: 30 * 60 * 1000, maxBuffer: 8 * MB });
}

/**
 * Runs Whisper.cpp locally for automatic speech/language recognition, then optionally translates
 * through the local Argos Translate runtime. No hosted AI API key is required.
 * mode is 'original', 'vietnamese', or 'burn-vietnamese'.
 */
export async function createSubtitles({ bot, fileId, fileName, mode = 'vietnamese', onProgress = async () => {} }) {
  const workDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'telegram-vietsub-'));
  try {
    const inputName = safeName(fileName);
    const inputPath = path.join(workDir, inputName);
    const audioPath = path.join(workDir, 'audio.wav');
    const outputBase = path.join(workDir, 'speech');
    const originalSrtPath = path.join(workDir, 'subtitles_original.srt');
    const vietnameseSrtPath = path.join(workDir, 'subtitles_vi.srt');
    const textPath = path.join(workDir, 'transcript.txt');
    const outputVideoPath = path.join(workDir, 'video_vietsub.mp4');

    await onProgress('⬇️ Đang tải video từ Telegram…');
    await downloadTelegramFile(bot, fileId, inputPath);
    await onProgress('🎧 Đang tách âm thanh bằng FFmpeg…');
    await extractAudio(inputPath, audioPath);
    await onProgress('🗣️ Đang nhận diện lời nói và tự phát hiện ngôn ngữ bằng mô hình cục bộ…');
    const transcription = await transcribeAudio(audioPath, outputBase);
    const originalSegments = transcription.segments;
    await fs.promises.writeFile(originalSrtPath, toSrt(originalSegments), 'utf8');

    const wantsVietnamese = mode === 'vietnamese' || mode === 'burn-vietnamese';
    const finalSegments = wantsVietnamese
      ? await (async () => {
          await onProgress(`🌐 Đã phát hiện ${transcription.sourceLanguageName}. Đang dịch offline sang tiếng Việt…`);
          return translateSegmentsLocally(originalSegments, transcription.sourceLanguage, workDir);
        })()
      : originalSegments;

    const mainSrtPath = wantsVietnamese ? vietnameseSrtPath : originalSrtPath;
    await fs.promises.writeFile(mainSrtPath, toSrt(finalSegments), 'utf8');
    const textContent = finalSegments.map((segment) => segment.text).join('\n');
    await fs.promises.writeFile(textPath, textContent, 'utf8');

    let videoPath = null;
    if (mode === 'burn-vietnamese') {
      await onProgress('🎬 Đang gắn cứng phụ đề tiếng Việt vào video…');
      await burnSubtitles(inputPath, vietnameseSrtPath, outputVideoPath);
      videoPath = outputVideoPath;
    }

    return {
      workDir,
      srtPath: mainSrtPath,
      textPath,
      videoPath,
      segmentCount: finalSegments.length,
      language: wantsVietnamese ? 'vi' : transcription.sourceLanguage,
      sourceLanguage: transcription.sourceLanguage,
      sourceLanguageName: transcription.sourceLanguageName
    };
  } catch (error) {
    await fs.promises.rm(workDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

export async function cleanupSubtitles(result) {
  if (result?.workDir) await fs.promises.rm(result.workDir, { recursive: true, force: true }).catch(() => {});
}
