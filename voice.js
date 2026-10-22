// マイクボタンの長押しで録音、離したら送信（仕様書4章）。ブラウザの音声認識（Web Speech API）を使う。
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

export function voiceSupported() {
  return Boolean(SR);
}

export function setupVoice(button, { onResult, onMessage }) {
  const overlay = document.createElement('div');
  overlay.className = 'voice-overlay';
  overlay.innerHTML = `<div class="voice-orb"></div><div class="voice-text">聞いています…</div><div class="voice-hint">指を離すと送信</div>`;
  document.body.appendChild(overlay);
  const $text = overlay.querySelector('.voice-text');

  let rec = null;
  let base = ''; // 自動で止まって再開した時の、それまでの文字起こし
  let finalText = '';
  let interim = '';
  let pressedAt = 0;
  let released = false;
  let finished = false;
  let fallbackTimer = null;
  let restarts = 0;

  const unsupportedMsg = 'この端末では音声認識が使えません。キーボードのマイクで入力してね';

  function finish() {
    if (finished) return;
    finished = true;
    clearTimeout(fallbackTimer);
    overlay.classList.remove('show');
    button.classList.remove('recording');
    const text = (base + finalText + interim).trim();
    rec = null;
    if (text) onResult(text);
    else if (Date.now() - pressedAt > 600) onMessage('聞き取れませんでした');
  }

  function start(e) {
    e.preventDefault();
    if (!SR) return onMessage(unsupportedMsg);
    if (rec) return;
    try { button.setPointerCapture(e.pointerId); } catch { /* 古いブラウザ */ }
    base = '';
    restarts = 0;
    finalText = '';
    interim = '';
    released = false;
    finished = false;
    pressedAt = Date.now();
    $text.textContent = '聞いています…';

    rec = new SR();
    rec.lang = 'ja-JP';
    rec.interimResults = true;
    rec.continuous = true;
    rec.onresult = (ev) => {
      let f = '';
      let i = '';
      for (let k = 0; k < ev.results.length; k++) {
        const r = ev.results[k];
        if (r.isFinal) f += r[0].transcript;
        else i += r[0].transcript;
      }
      finalText = f;
      interim = i;
      $text.textContent = (base + f + i) || '聞いています…';
    };
    rec.onerror = (ev) => {
      // 無音（no-speech）や中断（aborted）は続けてよい。それ以外は止めて理由を伝える
      if (ev.error === 'no-speech' || ev.error === 'aborted') return;
      finished = true;
      clearTimeout(fallbackTimer);
      overlay.classList.remove('show');
      button.classList.remove('recording');
      rec = null;
      onMessage({
        'not-allowed': 'マイクの使用が許可されていません。設定アプリで許可するか、キーボードのマイクを使ってね',
        'network': '音声認識につながりませんでした。キーボードのマイクで入力してね',
      }[ev.error] || unsupportedMsg);
    };
    rec.onend = () => {
      // iPhoneは無音が続くと勝手に止まることがある。押している間は続ける
      if (!released && !finished && rec && restarts++ < 20) {
        base += finalText + interim;
        finalText = '';
        interim = '';
        try { rec.start(); return; } catch { /* もう一度は開始できない */ }
      }
      finish();
    };
    try {
      rec.start();
    } catch {
      rec = null;
      return onMessage(unsupportedMsg);
    }
    overlay.classList.add('show');
    button.classList.add('recording');
  }

  function stop() {
    if (!rec || released) return;
    released = true;
    if (Date.now() - pressedAt < 350 && !base && !finalText && !interim) {
      // 短いタップ
      finished = true;
      try { rec.abort(); } catch { /* 無視 */ }
      rec = null;
      overlay.classList.remove('show');
      button.classList.remove('recording');
      return onMessage('マイクは長押ししながら話してね');
    }
    try { rec.stop(); } catch { finish(); }
    // onend が来ない端末への保険
    fallbackTimer = setTimeout(finish, 2500);
  }

  button.addEventListener('pointerdown', start);
  button.addEventListener('pointerup', stop);
  button.addEventListener('pointercancel', stop);
  button.addEventListener('contextmenu', (e) => e.preventDefault());
}
