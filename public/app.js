(() => {
  const tg = window.Telegram?.WebApp;
  const root = document.documentElement;
  const toast = document.getElementById('toast');
  const confettiLayer = document.getElementById('confetti-layer');
  const connectionLabel = document.getElementById('connection-label');
  const sessionLabel = document.getElementById('session-label');
  let session = { isAdmin: false, user: null, isTelegram: false };
  let toastTimer;

  const colors = [
    { name: 'xanh ngọc', hue: 169, hex: '#42d9bd' },
    { name: 'xanh dương', hue: 210, hex: '#55a9ff' },
    { name: 'tím', hue: 257, hex: '#a28aff' },
    { name: 'cam', hue: 29, hex: '#ffad68' },
    { name: 'hồng', hue: 330, hex: '#ff78b9' },
    { name: 'vàng chanh', hue: 72, hex: '#d6ed72' },
    { name: 'đỏ san hô', hue: 4, hex: '#ff777f' }
  ];

  function randomColor(exceptHue) {
    const options = colors.filter((color) => color.hue !== exceptHue);
    return options[Math.floor(Math.random() * options.length)];
  }

  function applyColor(color) {
    root.style.setProperty('--accent', `hsl(${color.hue} 72% 58%)`);
    // RGB is used by glow/ripple effects.
    const rgb = hexToRgb(color.hex);
    root.style.setProperty('--accent-rgb', `${rgb.r}, ${rgb.g}, ${rgb.b}`);
    if (tg?.setHeaderColor) {
      try { tg.setHeaderColor('#' + hslToHex(color.hue, 72, 13)); } catch { /* older Telegram clients */ }
    }
    return color;
  }

  function hexToRgb(hex) {
    const value = hex.replace('#', '');
    return { r: parseInt(value.slice(0, 2), 16), g: parseInt(value.slice(2, 4), 16), b: parseInt(value.slice(4, 6), 16) };
  }
  function hslToHex(h, s, l) {
    s /= 100; l /= 100;
    const k = n => (n + h / 30) % 12;
    const a = s * Math.min(l, 1 - l);
    const f = n => {
      const v = l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
      return Math.round(255 * v).toString(16).padStart(2, '0');
    };
    return `${f(0)}${f(8)}${f(4)}`;
  }

  function showToast(message) {
    toast.textContent = message;
    toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('show'), 2600);
  }

  function burst(element, color) {
    const rect = element.getBoundingClientRect();
    const originX = rect.left + rect.width / 2;
    const originY = rect.top + rect.height / 2;
    for (let i = 0; i < 12; i++) {
      const dot = document.createElement('span');
      dot.className = 'spark';
      dot.style.left = `${originX}px`;
      dot.style.top = `${originY}px`;
      dot.style.background = i % 2 ? color.hex : '#ffffff';
      dot.style.setProperty('--x', `${(Math.random() - 0.5) * 170}px`);
      dot.style.setProperty('--y', `${(Math.random() - 0.5) * 150}px`);
      confettiLayer.appendChild(dot);
      dot.addEventListener('animationend', () => dot.remove(), { once: true });
    }
  }

  function haptic(kind = 'light') {
    try { tg?.HapticFeedback?.impactOccurred(kind); } catch { /* optional native feature */ }
  }

  async function loadSession() {
    if (!tg) {
      connectionLabel.textContent = 'PREVIEW';
      sessionLabel.textContent = 'Chế độ xem trước · mở trong Telegram để xác thực';
      return;
    }
    try {
      tg.ready();
      tg.expand();
      try { tg.setBackgroundColor('#0a171c'); } catch { /* optional */ }
      connectionLabel.textContent = 'TELEGRAM';
      session.isTelegram = true;
      if (!tg.initData) {
        sessionLabel.textContent = 'Không có dữ liệu phiên Telegram';
        return;
      }
      const response = await fetch('/api/miniapp/session', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ initData: tg.initData })
      });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || 'Không xác thực được');
      session = { ...session, ...data, isTelegram: true };
      sessionLabel.textContent = session.isAdmin
        ? `Đã xác thực Admin · ${session.user.firstName}`
        : `Đã kết nối Telegram · ${session.user.firstName} (chỉ xem)`;
    } catch (error) {
      sessionLabel.textContent = `Phiên chưa xác thực: ${error.message}`;
    }
  }

  document.getElementById('randomize-all').addEventListener('click', (event) => {
    const currentHue = Number((getComputedStyle(root).getPropertyValue('--accent').match(/hsl\(\s*(\d+)/) || [])[1] || -1);
    const color = applyColor(randomColor(currentHue));
    burst(event.currentTarget, color);
    haptic('medium');
    showToast(`✦ Giao diện đổi sang màu ${color.name}`);
  });

  document.querySelectorAll('.module-card').forEach((card) => {
    card.addEventListener('click', async () => {
      const color = applyColor(randomColor(Number(card.dataset.lastHue || -1)));
      card.dataset.lastHue = String(color.hue);
      card.style.setProperty('--card-color', color.hex);
      card.classList.remove('pulse');
      void card.offsetWidth;
      card.classList.add('pulse');
      burst(card, color);
      haptic('light');
      const action = card.dataset.action;
      const label = card.querySelector('strong')?.textContent || action;

      if (!session.isTelegram) {
        showToast(`${label} · hiệu ứng ${color.name} (chế độ xem trước)`);
        return;
      }
      if (!session.isAdmin) {
        showToast('⛔ Tài khoản này chưa được cấp quyền Admin.');
        return;
      }
      try {
        const response = await fetch('/api/miniapp/action', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ initData: tg.initData, action })
        });
        const data = await response.json();
        if (!response.ok || !data.ok) throw new Error(data.error || 'Thao tác thất bại');
        showToast(`${color.name} · ${data.message}`);
      } catch (error) {
        showToast(error.message);
      }
    });
  });

  document.getElementById('subtitle-help').addEventListener('click', () => {
    haptic('light');
    const message = 'Gửi video cho bot Telegram, sau đó chọn SRT nguyên ngữ, dịch SRT sang tiếng Việt hoặc video đã gắn cứng phụ đề.';
    if (tg?.showPopup) {
      tg.showPopup({ title: 'Phụ đề video', message, buttons: [{ type: 'ok', text: 'Đã hiểu' }] });
    } else {
      showToast(message);
    }
  });

  loadSession();
})();
