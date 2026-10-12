FROM node:20-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    WHISPER_CPP_PATH=/opt/whisper.cpp/build/bin/whisper-cli \
    WHISPER_MODEL_PATH=/opt/whisper.cpp/models/ggml-base.bin \
    FFMPEG_PATH=/usr/bin/ffmpeg \
    PYTHON_PATH=python3

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates git cmake build-essential pkg-config curl ffmpeg python3 python3-pip \
    libgomp1 libstdc++6 fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/*

RUN pip3 install --break-system-packages --no-cache-dir argostranslate \
    && python3 -c "import argostranslate.package as p; ok = p.install_package_for_language_pair('en', 'vi'); print('Argos en->vi installed:', ok); assert ok, 'Argos en->vi package unavailable'"

RUN git clone --depth 1 https://github.com/ggml-org/whisper.cpp.git /opt/whisper.cpp \
    && cmake -S /opt/whisper.cpp -B /opt/whisper.cpp/build \
       -DCMAKE_BUILD_TYPE=Release -DWHISPER_BUILD_TESTS=OFF -DWHISPER_BUILD_EXAMPLES=ON -DWHISPER_BUILD_SERVER=OFF \
    && cmake --build /opt/whisper.cpp/build --config Release -j2 --target whisper-cli \
    && bash /opt/whisper.cpp/models/download-ggml-model.sh base \
    && test -x /opt/whisper.cpp/build/bin/whisper-cli \
    && test -s /opt/whisper.cpp/models/ggml-base.bin

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY . .
RUN mkdir -p /app/data

ENV NODE_ENV=production PORT=3000
EXPOSE 3000
CMD ["npm", "start"]
