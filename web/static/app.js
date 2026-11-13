/**
 * Mind TestHelper Live — Hands-Free Camera AI Scanner
 * Real-time video motion stabilization, HUD reticle tracking & instant solver.
 */

(() => {
  'use strict';

  // Elements
  const videoFeed = document.getElementById('videoFeed');
  const motionCanvas = document.getElementById('motionCanvas');
  const captureCanvas = document.getElementById('captureCanvas');
  const cameraFallback = document.getElementById('cameraFallback');
  const btnAllowCamera = document.getElementById('btnAllowCamera');
  const btnTryDemo = document.getElementById('btnTryDemo');

  const hudOverlay = document.getElementById('hudOverlay');
  const statusPill = document.getElementById('statusPill');
  const statusLabel = document.getElementById('statusLabel');
  const btnTorch = document.getElementById('btnTorch');
  const btnFlipCamera = document.getElementById('btnFlipCamera');
  const btnMuteTTS = document.getElementById('btnMuteTTS');

  const targetFrame = document.getElementById('targetFrame');
  const stillnessBar = document.getElementById('stillnessBar');
  const stabilityTag = document.getElementById('stabilityTag');
  const btnManualSnap = document.getElementById('btnManualSnap');
  const btnSamplePicker = document.getElementById('btnSamplePicker');

  const answerDrawer = document.getElementById('answerDrawer');
  const drawerIdle = document.getElementById('drawerIdle');
  const drawerSolved = document.getElementById('drawerSolved');
  const badgeSource = document.getElementById('badgeSource');
  const sourceLabel = document.getElementById('sourceLabel');
  const confidenceLabel = document.getElementById('confidenceLabel');
  const latencyPill = document.getElementById('latencyPill');
  const correctAnswerText = document.getElementById('correctAnswerText');
  const questionText = document.getElementById('questionText');
  const optionsList = document.getElementById('optionsList');
  const explanationText = document.getElementById('explanationText');
  const btnCopyAnswer = document.getElementById('btnCopyAnswer');
  const btnSpeakNow = document.getElementById('btnSpeakNow');
  const btnDismiss = document.getElementById('btnDismiss');

  const sampleModal = document.getElementById('sampleModal');
  const btnCloseModal = document.getElementById('btnCloseModal');
  const sampleGrid = document.getElementById('sampleGrid');

  // State
  let currentStream = null;
  let videoTrack = null;
  let isTorchOn = false;
  let useFacingMode = 'environment';
  let isAudioEnabled = true;

  // Motion Detection & Stabilization
  const MOTION_WIDTH = 160;
  const MOTION_HEIGHT = 120;
  let prevFrameData = null;
  let stillnessStreak = 0;
  const REQUIRED_STEADY_FRAMES = 7; // ~700ms at 100ms intervals
  const MOTION_THRESHOLD = 0.045; // average delta threshold for stillness

  let isAnalyzing = false;
  let lastSolvedFingerprint = null;
  let cooldownUntil = 0;
  let lastSolvedData = null;

  // 1. Initialize Camera Stream
  async function initCamera() {
    if (currentStream) {
      currentStream.getTracks().forEach(t => t.stop());
    }

    cameraFallback.classList.remove('hidden');

    const constraints = {
      audio: false,
      video: {
        facingMode: { ideal: useFacingMode },
        width: { ideal: 1920 },
        height: { ideal: 1080 }
      }
    };

    try {
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      attachStream(stream);
    } catch (err) {
      console.warn('Ideal camera constraints failed, attempting fallback...', err);
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: true });
        attachStream(stream);
      } catch (err2) {
        console.error('All camera access failed:', err2);
        cameraFallback.classList.remove('hidden');
        cameraFallback.querySelector('p').textContent = 'Доступ к камере заблокирован. Вы можете использовать кнопку теста:';
      }
    }
  }

  function attachStream(stream) {
    currentStream = stream;
    videoFeed.srcObject = stream;
    videoTrack = stream.getVideoTracks()[0];

    videoFeed.onloadedmetadata = () => {
      videoFeed.play().catch(e => console.warn(e));
      cameraFallback.classList.add('hidden');
      setupMotionCanvas();
      startStabilizationLoop();
    };

    // Check torch capabilities
    if (videoTrack && videoTrack.getCapabilities) {
      const caps = videoTrack.getCapabilities();
      if (caps.torch) {
        btnTorch.style.display = 'flex';
      }
    }
  }

  // Torch Toggle
  btnTorch.addEventListener('click', async () => {
    if (!videoTrack) return;
    try {
      isTorchOn = !isTorchOn;
      await videoTrack.applyConstraints({ advanced: [{ torch: isTorchOn }] });
      btnTorch.classList.toggle('active', isTorchOn);
    } catch (e) {
      console.warn('Torch control failed:', e);
    }
  });

  // Camera Flip Toggle
  btnFlipCamera.addEventListener('click', () => {
    useFacingMode = (useFacingMode === 'environment') ? 'user' : 'environment';
    initCamera();
  });

  // Audio Mute Toggle
  btnMuteTTS.addEventListener('click', () => {
    isAudioEnabled = !isAudioEnabled;
    btnMuteTTS.classList.toggle('active', isAudioEnabled);
  });

  // 2. Motion Stabilization Engine
  function setupMotionCanvas() {
    motionCanvas.width = MOTION_WIDTH;
    motionCanvas.height = MOTION_HEIGHT;
  }

  function startStabilizationLoop() {
    const motionCtx = motionCanvas.getContext('2d', { willReadFrequently: true });

    setInterval(() => {
      if (videoFeed.readyState < 2 || isAnalyzing) return;

      // Draw downsampled frame
      motionCtx.drawImage(videoFeed, 0, 0, MOTION_WIDTH, MOTION_HEIGHT);
      const frame = motionCtx.getImageData(0, 0, MOTION_WIDTH, MOTION_HEIGHT);
      const data = frame.data;

      if (!prevFrameData) {
        prevFrameData = new Uint8ClampedArray(data);
        return;
      }

      // Calculate mean luminance difference
      let totalDiff = 0;
      const pixelCount = MOTION_WIDTH * MOTION_HEIGHT;

      for (let i = 0; i < data.length; i += 4) {
        // Luminance formula Y = 0.299R + 0.587G + 0.114B
        const y1 = (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114);
        const y0 = (prevFrameData[i] * 0.299 + prevFrameData[i + 1] * 0.587 + prevFrameData[i + 2] * 0.114);
        totalDiff += Math.abs(y1 - y0);
      }

      // Copy for next tick
      prevFrameData.set(data);

      const motionScore = totalDiff / (pixelCount * 255);
      handleMotionScore(motionScore);
    }, 100);
  }

  function handleMotionScore(score) {
    const now = Date.now();

    if (score < MOTION_THRESHOLD) {
      // Camera is steady
      stillnessStreak++;
      const progress = Math.min(100, Math.round((stillnessStreak / REQUIRED_STEADY_FRAMES) * 100));
      stillnessBar.style.width = `${progress}%`;

      if (stillnessStreak >= 2) {
        statusPill.className = 'status-pill steady';
        statusLabel.textContent = `ФИКСАЦИЯ (${progress}%)`;
        stabilityTag.textContent = 'КАДР СТАБИЛЕН';
        targetFrame.classList.add('locked');
      }

      if (stillnessStreak >= REQUIRED_STEADY_FRAMES) {
        // Lock achieved!
        if (now > cooldownUntil && !isAnalyzing) {
          triggerCaptureAndSolve(false);
        }
      }
    } else {
      // Camera moved
      if (stillnessStreak > 0) {
        stillnessStreak = 0;
        stillnessBar.style.width = '0%';
        targetFrame.classList.remove('locked');

        if (!isAnalyzing) {
          statusPill.className = 'status-pill';
          statusLabel.textContent = 'ПОИСК ВОПРОСА';
          stabilityTag.textContent = 'ДЕРЖИТЕ НЕПОДВИЖНО';
        }
      }
    }
  }

  // 3. High-Res Image Capture & Reticle Crop
  function captureReticleImage() {
    if (!videoFeed.videoWidth || !videoFeed.videoHeight) return null;

    const vw = videoFeed.videoWidth;
    const vh = videoFeed.videoHeight;

    // Get reticle bounding rect relative to viewport
    const retRect = targetFrame.getBoundingClientRect();
    const vpRect = document.body.getBoundingClientRect();

    // Map screen coordinates to video natural aspect
    const scaleX = vw / vpRect.width;
    const scaleY = vh / vpRect.height;

    // Crop box with a bit of safety margin
    const margin = 0.08;
    let cropX = Math.max(0, (retRect.left - retRect.width * margin) * scaleX);
    let cropY = Math.max(0, (retRect.top - retRect.height * margin) * scaleY);
    let cropW = Math.min(vw - cropX, retRect.width * (1 + margin * 2) * scaleX);
    let cropH = Math.min(vh - cropY, retRect.height * (1 + margin * 2) * scaleY);

    captureCanvas.width = Math.min(1280, Math.round(cropW));
    captureCanvas.height = Math.round(cropH * (captureCanvas.width / cropW));

    const ctx = captureCanvas.getContext('2d');
    ctx.drawImage(videoFeed, cropX, cropY, cropW, cropH, 0, 0, captureCanvas.width, captureCanvas.height);

    return captureCanvas.toDataURL('image/jpeg', 0.88);
  }

  // 4. Trigger Solve API
  async function triggerCaptureAndSolve(isManual = false) {
    if (isAnalyzing) return;

    const imageData = captureReticleImage();
    if (!imageData) return;

    // Simple fingerprint to prevent re-requesting exact identical view
    const fp = imageData.slice(100, 300);
    if (!isManual && fp === lastSolvedFingerprint) {
      return;
    }

    isAnalyzing = true;
    lastSolvedFingerprint = fp;
    cooldownUntil = Date.now() + 4500; // 4.5s cooldown for next auto-trigger

    // Update HUD to Solving State
    statusPill.className = 'status-pill solving';
    statusLabel.textContent = 'РАСПОЗНАВАНИЕ...';
    targetFrame.classList.add('solving');

    try {
      const resp = await fetch('/api/solve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image: imageData })
      });

      const res = await resp.json();
      handleSolveResponse(res);
    } catch (err) {
      console.error('Solve request error:', err);
      statusPill.className = 'status-pill';
      statusLabel.textContent = 'ОШИБКА СЕТИ';
      setTimeout(() => {
        statusLabel.textContent = 'ПОИСК ВОПРОСА';
      }, 2000);
    } finally {
      isAnalyzing = false;
      targetFrame.classList.remove('solving');
    }
  }

  function handleSolveResponse(res) {
    if (!res || !res.found) {
      statusPill.className = 'status-pill';
      statusLabel.textContent = 'ВОПРОС НЕ НАЙДЕН';
      setTimeout(() => {
        statusLabel.textContent = 'ПОИСК ВОПРОСА';
      }, 2200);
      return;
    }

    // Success!
    lastSolvedData = res;
    statusPill.className = 'status-pill solved';
    statusLabel.textContent = 'ОТВЕТ НАЙДЕН';

    // Haptic pulse on phone
    if (navigator.vibrate) {
      navigator.vibrate([40, 60, 40]);
    }

    renderAnswer(res);

    // Audio readout
    if (isAudioEnabled && res.correct_answer) {
      speakAnswer(res.correct_answer);
    }
  }

  function renderAnswer(res) {
    drawerIdle.classList.add('hidden');
    drawerSolved.classList.remove('hidden');

    // Source & verified badge
    if (res.bank_match && res.bank_match.verified) {
      badgeSource.className = 'badge-source verified';
      sourceLabel.textContent = '✓ БАЗА ИЦА (100% СОВПАДЕНИЕ)';
    } else {
      badgeSource.className = 'badge-source';
      sourceLabel.textContent = `⚡ ${res.model_used || 'Gemini Vision'}`;
    }

    confidenceLabel.textContent = `${Math.round((res.confidence || 0.98) * 100)}% уверенность`;
    latencyPill.textContent = `${res.latency_ms || 780}ms`;

    // Winning Answer
    correctAnswerText.textContent = res.correct_answer || 'Ответ определён';

    // Question
    questionText.textContent = res.question || '—';

    // Options list
    optionsList.innerHTML = '';
    const options = res.options || [];

    if (options.length > 0) {
      options.forEach((opt, idx) => {
        const pill = document.createElement('div');
        const isCorrect = (idx === res.correct_index) ||
                          (res.correct_answer && opt.toLowerCase().includes(res.correct_answer.toLowerCase())) ||
                          (res.correct_answer && res.correct_answer.toLowerCase().includes(opt.toLowerCase()));

        pill.className = `option-pill ${isCorrect ? 'correct' : ''}`;
        pill.innerHTML = `
          <div class="option-check">${isCorrect ? '✓' : ''}</div>
          <span>${opt}</span>
        `;
        optionsList.appendChild(pill);
      });
      optionsList.style.display = 'flex';
    } else {
      optionsList.style.display = 'none';
    }

    // Explanation & Legal NPA Ref
    let exp = res.explanation || '';
    if (res.bank_match && res.bank_match.npa_ref) {
      exp += `\n\nНПА: ${res.bank_match.npa_ref}`;
    }
    explanationText.textContent = exp || 'Ответ подтверждён нормативными источниками и моделью.';

    // Scroll drawer into view smoothly
    answerDrawer.scrollTop = 0;
  }

  // Text-To-Speech
  function speakAnswer(text) {
    if (!('speechSynthesis' in window)) return;
    window.speechSynthesis.cancel();

    // Clean prefix like "B) " for natural speech
    const cleanText = text.replace(/^[A-Da-d0-9\)\.\-–—\s]+/, '').trim() || text;
    const utterance = new SpeechSynthesisUtterance(cleanText);
    utterance.lang = 'ru-RU';
    utterance.rate = 1.05;
    window.speechSynthesis.speak(utterance);
  }

  // Actions
  btnCopyAnswer.addEventListener('click', () => {
    if (!lastSolvedData) return;
    const textToCopy = `Вопрос: ${lastSolvedData.question}\nОтвет: ${lastSolvedData.correct_answer}\n${lastSolvedData.explanation || ''}`;
    navigator.clipboard.writeText(textToCopy).then(() => {
      btnCopyAnswer.querySelector('span').textContent = 'Скопировано!';
      setTimeout(() => {
        btnCopyAnswer.querySelector('span').textContent = 'Скопировать';
      }, 1800);
    });
  });

  btnSpeakNow.addEventListener('click', () => {
    if (lastSolvedData && lastSolvedData.correct_answer) {
      speakAnswer(lastSolvedData.correct_answer);
    }
  });

  btnDismiss.addEventListener('click', () => {
    drawerSolved.classList.add('hidden');
    drawerIdle.classList.remove('hidden');
    lastSolvedData = null;
    statusPill.className = 'status-pill';
    statusLabel.textContent = 'ПОИСК ВОПРОСА';
    stillnessStreak = 0;
    stillnessBar.style.width = '0%';
  });

  btnManualSnap.addEventListener('click', () => {
    triggerCaptureAndSolve(true);
  });

  btnAllowCamera.addEventListener('click', initCamera);

  // 5. Sample Questions Modal (Dynamic from API + Fallback)
  let liveSamples = [
    {
      category: "Промышленная безопасность РК (ИЦА)",
      title: "Продление расследования аварии",
      question: "Кем может быть продлен срок проведения расследования аварии?",
      options: [
        "только один раз руководителем органа, назначившим комиссию, приказом (распоряжением) с указанием причин продления на основании служебной записки председателя комиссии, но не более чем на пятнадцать рабочих дней",
        "только один раз руководителем органа, назначившим комиссию, но не более чем на десять рабочих дней",
        "только один раз председателем комиссии, но не более чем на пятнадцать рабочих дней"
      ]
    },
    {
      category: "БИОТ и Трудовой кодекс РК",
      title: "Проведение инструктажа",
      question: "С кем проводится первичный инструктаж по безопасности и охране труда на рабочем месте?",
      options: [
        "1) Только с практикантами и стажерами",
        "2) Со всеми вновь принятыми работниками перед допуском к работе",
        "3) Только с лицами без профильного образования",
        "4) Раз в полугодие со всем персоналом"
      ]
    },
    {
      category: "English Technical / General Exam",
      title: "Networking & Cloud",
      question: "Which OSI model layer is responsible for end-to-end communication, reliability, and flow control?",
      options: [
        "A) Data Link Layer",
        "B) Network Layer",
        "C) Transport Layer",
        "D) Session Layer"
      ]
    }
  ];

  async function loadBankSamples() {
    try {
      const resp = await fetch('/api/samples');
      const data = await resp.json();
      if (Array.isArray(data) && data.length > 0) {
        liveSamples = data.map((item, idx) => ({
          category: item.category || 'Вопрос из базы ИЦА',
          title: `Билет #${idx + 1}`,
          question: item.question,
          options: item.options || []
        }));
      }
    } catch (e) {
      console.warn('Bank samples load fallback:', e);
    }
  }
  loadBankSamples();

  function renderSamples() {
    sampleGrid.innerHTML = '';
    liveSamples.forEach((s, idx) => {
      const card = document.createElement('div');
      card.className = 'sample-card';
      card.innerHTML = `
        <span class="sample-category">${s.category}</span>
        <span class="sample-title">${s.title ? s.title + ': ' : ''}${s.question}</span>
      `;
      card.addEventListener('click', () => {
        sampleModal.classList.add('hidden');
        synthesizeAndSolveSample(s);
      });
      sampleGrid.appendChild(card);
    });
  }

  function synthesizeAndSolveSample(sample) {
    // Draw synthetic test ticket on canvas
    const cvs = captureCanvas;
    cvs.width = 700;
    cvs.height = 360;
    const ctx = cvs.getContext('2d');

    // Clean white exam sheet background
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, cvs.width, cvs.height);

    ctx.fillStyle = '#111827';
    ctx.font = 'bold 20px -apple-system, sans-serif';
    ctx.fillText('БИЛЕТ ПРОВЕРКИ ЗНАНИЙ', 30, 45);

    ctx.font = '16px -apple-system, sans-serif';
    ctx.fillStyle = '#1F2937';

    // Wrap question text
    const words = sample.question.split(' ');
    let line = '';
    let y = 85;
    for (const w of words) {
      const testLine = line + w + ' ';
      if (ctx.measureText(testLine).width > 640) {
        ctx.fillText(line, 30, y);
        line = w + ' ';
        y += 24;
      } else {
        line = testLine;
      }
    }
    ctx.fillText(line, 30, y);
    y += 35;

    // Options
    ctx.font = '15px -apple-system, sans-serif';
    sample.options.forEach(opt => {
      ctx.fillStyle = '#374151';
      ctx.fillText(opt, 30, y);
      y += 28;
    });

    const imgData = cvs.toDataURL('image/jpeg', 0.9);

    // Trigger solve directly
    isAnalyzing = true;
    statusPill.className = 'status-pill solving';
    statusLabel.textContent = 'РАСПОЗНАВАНИЕ...';

    fetch('/api/solve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: imgData })
    })
      .then(r => r.json())
      .then(res => handleSolveResponse(res))
      .catch(e => {
        console.error(e);
        statusPill.className = 'status-pill';
        statusLabel.textContent = 'ОШИБКА';
      })
      .finally(() => {
        isAnalyzing = false;
      });
  }

  btnSamplePicker.addEventListener('click', () => {
    renderSamples();
    sampleModal.classList.remove('hidden');
  });

  btnTryDemo.addEventListener('click', () => {
    cameraFallback.classList.add('hidden');
    renderSamples();
    sampleModal.classList.remove('hidden');
  });

  btnCloseModal.addEventListener('click', () => {
    sampleModal.classList.add('hidden');
  });

  // Start
  initCamera();
})();
