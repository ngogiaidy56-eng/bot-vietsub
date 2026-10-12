# HENDY Admini Bot V3 — Vietsub cục bộ, tự nhận diện ngôn ngữ

Bot Telegram gồm 4 nút Admini, Telegram Mini App CSS tùy chỉnh, hiệu ứng màu ngẫu nhiên khi chạm, cùng pipeline tạo phụ đề video không dùng API nhận diện/dịch bên ngoài.

## Điều quan trọng về “không cần AI/API”

Phiên bản này **không cần `OPENAI_API_KEY`, không gọi API AI trả phí và không gửi âm thanh lên dịch vụ AI bên ngoài**. Nhận diện giọng nói vẫn cần mô hình học máy; dự án chạy mô hình Whisper.cpp ngay trên máy chủ. Dịch tiếng Việt chạy bằng mô hình mã nguồn mở Argos Translate trên máy chủ. Đây là xử lý AI cục bộ, chứ không phải nhận diện giọng nói bằng quy tắc không-AI.

Whisper.cpp model `base` đa ngôn ngữ được tải khi xây Docker image. Mô hình dịch Argos English → Vietnamese được cài sẵn trong Docker image; các cặp ngôn ngữ nguồn khác sẽ được tải và cache tự động khi cần nếu chưa cài; việc tải mô hình đó cần internet lúc đầu nhưng các lần sử dụng sau chạy cục bộ. Nếu ngôn ngữ nguồn không có mô hình Argos phù hợp, bot sẽ báo lỗi rõ ràng thay vì âm thầm làm sai phụ đề.

## Tính năng

- `Admini1`–`Admini4`: bốn mục điều khiển trong Telegram.
- Mini App HTML/CSS/JS: giao diện riêng, đổi màu ngẫu nhiên, hiệu ứng nhấn/hạt sáng, hỗ trợ haptic khi Telegram client cho phép.
- Xác thực dữ liệu `initData` Mini App tại backend bằng bot token; Admini yêu cầu ID có trong `ADMIN_IDS`.
- Gửi video/video note/tệp video cho bot; Whisper.cpp tự phát hiện ngôn ngữ nói, tạo mốc thời gian phụ đề và bản chép lời.
- `SRT nguyên ngữ · tự nhận diện`: xuất `.srt` và `.txt` theo ngôn ngữ được phát hiện.
- `Vietsub tiếng Việt · offline`: dịch các câu đã nhận diện sang tiếng Việt qua mô hình Argos Translate cục bộ, giữ mốc thời gian.
- `MP4 gắn phụ đề Việt · offline`: tạo SRT tiếng Việt rồi dùng FFmpeg gắn cứng vào video.
- Nút `⚙️ Cài đặt bot` trong menu và lệnh `/settings`: chọn hỏi mỗi lần, SRT nguyên ngữ, Vietsub tiếng Việt hoặc MP4 gắn phụ đề. Các chế độ ngoài “Hỏi mỗi lần” tự chạy khi gửi video tiếp theo.
- Cài đặt theo từng người dùng được lưu trong `data/user-settings.json` (không đưa file chứa Telegram ID lên GitHub).
- `/help`, `/menu` và endpoint health `GET /api/health`.

## Menu Cài đặt bot

Trong menu `/start` hoặc `/menu`, bấm **⚙️ Cài đặt bot** hoặc gửi `/settings`. Chọn chế độ mặc định: Hỏi mỗi lần, SRT nguyên ngữ, Vietsub tiếng Việt hoặc MP4 gắn phụ đề. Khi chọn một chế độ cụ thể, video mới gửi sẽ tự chạy theo chế độ đó; chọn “Hỏi mỗi lần” để xem menu lựa chọn sau mỗi video. Nhận diện ngôn ngữ vẫn luôn tự động. Cài đặt được lưu ở `data/user-settings.json`; trên Render nên gắn Persistent Disk nếu cần giữ tệp qua lần deploy.

## Cài đặt trên máy riêng bằng Docker

Yêu cầu: Docker có quyền tải image/model. Ở thư mục dự án:

```bash
docker build -t hendy-admini-vietsub .
docker run --rm -p 3000:3000 \
  -e BOT_TOKEN="TOKEN_TELEGRAM" \
  -e ADMIN_IDS="123456789" \
  -e WEB_APP_URL="https://your-https-domain.example" \
  hendy-admini-vietsub
```

Thay token và Telegram ID bằng giá trị thật. Không commit `.env` lên GitHub.

## Triển khai lên Render

Dự án đã có `render.yaml` dùng Docker. Cách làm:

1. Đẩy toàn bộ mã nguồn lên GitHub.
2. Trên Render chọn **New → Blueprint** và kết nối repository, hoặc tạo Web Service dùng Dockerfile.
3. Đặt biến `BOT_TOKEN`, `ADMIN_IDS`, `SUBTITLE_ALLOWED_IDS`, `WEB_APP_URL` trong Environment.
4. Đợi Docker build hoàn tất; build đầu tiên có thể mất thời gian vì biên dịch Whisper.cpp và tải model nhận diện.
5. Kiểm tra `https://TEN-DICH-VU.onrender.com/api/health` trả về `ok: true`.
6. Trong Telegram, gửi `/start`; gửi video cho bot để mở các tuỳ chọn phụ đề.

Biến môi trường:

| Biến | Ý nghĩa |
|---|---|
| `BOT_TOKEN` | Token lấy từ `@BotFather` |
| `ADMIN_IDS` | Danh sách Telegram ID quản trị, phân cách bằng dấu phẩy |
| `SUBTITLE_ALLOWED_IDS` | ID được phép xử lý phụ đề ngoài admin; để trống là chỉ admin |
| `WEB_APP_URL` | URL HTTPS của Web Service để mở Mini App |
| `MAX_VIDEO_MB` | Giới hạn tải video theo Bot API cloud; mặc định 20 MB |
| `SETTINGS_FILE` | Đường dẫn lưu cài đặt cá nhân; mặc định `data/user-settings.json` |
| `WHISPER_CPP_PATH` | Đường dẫn `whisper-cli`; đã cấu hình mặc định trong Dockerfile |
| `WHISPER_MODEL_PATH` | Đường dẫn model đa ngôn ngữ; mặc định model `base` |
| `FFMPEG_PATH` | Đường dẫn FFmpeg dùng để tách âm thanh/render phụ đề |

## Giới hạn và vận hành

- Bot API cloud thường chỉ cho bot tải file nguồn đến 20 MB. Có thể cân nhắc Telegram Local Bot API server nếu cần video lớn hơn, nhưng phải triển khai thêm dịch vụ đó.
- Whisper.cpp chạy CPU có thể mất nhiều thời gian với video dài; nâng cấp tài nguyên Render hoặc tăng thời hạn timeout nếu cần.
- Dịch Argos phụ thuộc mô hình có sẵn cho cặp ngôn ngữ nguồn → tiếng Việt hoặc đường vòng nguồn → English → tiếng Việt. Các mô hình được tải lần đầu cần kết nối mạng. Bản build này không dùng API tính phí.
- Render filesystem mặc định có thể không bền vững qua lần deploy. Các mô hình Argos tải động có thể phải tải lại sau khi tạo instance/image mới; nếu muốn lưu cache lâu dài, cần gắn persistent disk và cấu hình thư mục mô hình Argos tương ứng.
- Bot không thể tự gắn phụ đề lên video ngay trong trình phát Telegram của người dùng. Hãy gửi/chuyển tiếp video cho bot; bot trả lại `.srt` hoặc video MP4 mới đã gắn phụ đề.
- Tác vụ quản trị Admini vẫn là các điểm nối nghiệp vụ; cần tích hợp database và quy tắc nghiệp vụ thật trước khi dùng để quản lý dữ liệu người dùng.

## Cấu trúc

```text
telegram-admini-bot/
├── Dockerfile
├── render.yaml
├── data/                     # Được tạo tự động để lưu cài đặt người dùng, không commit JSON
├── public/
│   ├── index.html
│   ├── style.css
│   └── app.js
└── src/
    ├── index.js              # HTTP server, Telegram bot, Mini App, callback actions
    ├── subtitles.js          # FFmpeg + Whisper.cpp + SRT + Vietsub + burn-in
    └── local_translate.py    # Auto-install and run Argos translation models locally
```

## Upstream projects

- Whisper.cpp: https://github.com/ggml-org/whisper.cpp
- Argos Translate: https://github.com/argosopentech/argos-translate
- Telegraf: https://telegraf.js.org/
