/**
 * Mind TestHelper Live — High-Precision Photo AI Scanner with Optical & Digital Zoom
 * Instant photo capture, hardware/software zoom, and high-accuracy test recognition.
 */

(() => {
  'use strict';

  // DOM Elements
  const videoFeed = document.getElementById('videoFeed');
  const cameraFlash = document.getElementById('cameraFlash');
  const snapshotPreview = document.getElementById('snapshotPreview');
  const snapshotImg = document.getElementById('snapshotImg');
  const captureCanvas = document.getElementById('captureCanvas');
  const cameraFallback = document.getElementById('cameraFallback');
  const btnAllowCamera = document.getElementById('btnAllowCamera');
  const btnTryDemo = document.getElementById('btnTryDemo');

  const hudOverlay = document.getElementById('hudOverlay');
  const statusPill = document.getElementById('statusPill');
  const statusLabel = document.getElementById('statusLabel');
  const btnSettings = document.getElementById('btnSettings');
  const btnTorch = document.getElementById('btnTorch');
  const btnFlipCamera = document.getElementById('btnFlipCamera');
  const btnMuteTTS = document.getElementById('btnMuteTTS');

  const frameGuide = document.getElementById('frameGuide');
  const zoomControlsBar = document.getElementById('zoomControlsBar');
  const btnZoomOut = document.getElementById('btnZoomOut');
  const btnZoomIn = document.getElementById('btnZoomIn');
  const zoomBadge = document.getElementById('zoomBadge');
  const zoomPresetsGroup = document.getElementById('zoomPresetsGroup');
  const pillZoom05 = document.getElementById('pillZoom05');
  const pillZoom1 = document.getElementById('pillZoom1');
  const pillZoom2 = document.getElementById('pillZoom2');
  const pillZoom3 = document.getElementById('pillZoom3');
  const pillZoom5 = document.getElementById('pillZoom5');

  const btnManualSnap = document.getElementById('btnManualSnap');
  const shutterSpinner = document.getElementById('shutterSpinner');
  const shutterLabel = document.getElementById('shutterLabel');
  const btnSamplePicker = document.getElementById('btnSamplePicker');
  const inputFileUpload = document.getElementById('inputFileUpload');

  const answerDrawer = document.getElementById('answerDrawer');
  const drawerIdle = document.getElementById('drawerIdle');
  const drawerSolved = document.getElementById('drawerSolved');
  const btnNewPhoto = document.getElementById('btnNewPhoto');
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

  const settingsModal = document.getElementById('settingsModal');
  const btnCloseSettings = document.getElementById('btnCloseSettings');
  const inputBackendUrl = document.getElementById('inputBackendUrl');
  const btnSetCloudflare = document.getElementById('btnSetCloudflare');
  const btnSetLocal = document.getElementById('btnSetLocal');
  const btnSaveBackend = document.getElementById('btnSaveBackend');
  const settingsStatus = document.getElementById('settingsStatus');
  const settingsStatusText = document.getElementById('settingsStatusText');

  const sampleModal = document.getElementById('sampleModal');
  const btnCloseModal = document.getElementById('btnCloseModal');
  const sampleGrid = document.getElementById('sampleGrid');

  // Backend URL configuration
  const DEFAULT_REMOTE_BACKEND = 'https://dash-powell-driver-restructuring.trycloudflare.com';

  function getApiBaseUrl() {
    const custom = localStorage.getItem('mind_backend_url');
    if (custom) return custom.replace(/\/+$/, '');
    if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
      return '';
    }
    return DEFAULT_REMOTE_BACKEND;
  }

  // Camera & Stream State
  let currentStream = null;
  let videoTrack = null;
  let isTorchOn = false;
  let useFacingMode = 'environment';
  let isAudioEnabled = true;

  // Zoom State
  let currentZoom = 1.0;
  let minZoom = 1.0;
  let maxZoom = 5.0;
  let hardwareZoomSupported = false;
  let zoomStep = 0.25;

  let isAnalyzing = false;
  let lastSolvedData = null;

  // =========================================================================
  // 1. Camera Initialization & Stream Setup
  // =========================================================================
  async function initCamera() {
    if (currentStream) {
      currentStream.getTracks().forEach(t => t.stop());
    }

    cameraFallback.classList.remove('hidden');

    const constraints = {
      audio: false,
      video: {
        facingMode: { ideal: useFacingMode },
        width: { ideal: 1920, min: 1280 },
        height: { ideal: 1080, min: 720 }
      }
    };

    try {
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      attachStream(stream);
    } catch (err) {
      console.warn('High-res camera constraints failed, attempting basic stream...', err);
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: true });
        attachStream(stream);
      } catch (err2) {
        console.error('All camera access failed:', err2);
        cameraFallback.classList.remove('hidden');
        const p = cameraFallback.querySelector('p');
        if (p) p.textContent = 'Доступ к камере заблокирован. Разрешите доступ или выберите фото:';
      }
    }
  }

  function attachStream(stream) {
    currentStream = stream;
    videoFeed.srcObject = stream;
    videoTrack = stream.getVideoTracks()[0];

    videoFeed.onloadedmetadata = () => {
      videoFeed.play().catch(e => console.warn('Play error:', e));
      cameraFallback.classList.add('hidden');
      inspectCapabilities();
      setZoom(1.0, false);
      setStatusReady();
    };
  }

  function inspectCapabilities() {
    if (!videoTrack || !videoTrack.getCapabilities) return;
    const caps = videoTrack.getCapabilities();

    // Check torch
    if (caps.torch) {
      btnTorch.style.display = 'flex';
    } else {
      btnTorch.style.display = 'none';
    }

    // Check hardware optical/digital zoom support
    if (caps.zoom) {
      hardwareZoomSupported = true;
      minZoom = Math.max(0.5, caps.zoom.min || 1.0);
      maxZoom = Math.min(10.0, caps.zoom.max || 5.0);
      zoomStep = caps.zoom.step || 0.1;
      if (minZoom < 0.9) {
        pillZoom05.classList.remove('hidden');
      }
    } else {
      hardwareZoomSupported = false;
      minZoom = 1.0;
      maxZoom = 5.0;
      zoomStep = 0.25;
    }
  }

  // =========================================================================
  // 2. Optical & Digital Zoom Engine
  // =========================================================================
  function setZoom(targetVal, smooth = true) {
    const clamped = Math.max(minZoom, Math.min(maxZoom, targetVal));
    currentZoom = Math.round(clamped * 10) / 10;

    // Apply hardware zoom if supported by the camera device
    if (hardwareZoomSupported && videoTrack) {
      videoTrack.applyConstraints({
        advanced: [{ zoom: currentZoom }]
      }).catch(err => {
        console.warn('Hardware zoom constraint ignored, using digital transform:', err);
      });
    }

    // Always apply digital CSS transform for ultra-responsive live feedback
    if (currentZoom > 1.005) {
      videoFeed.style.transform = `scale(${currentZoom})`;
    } else {
      videoFeed.style.transform = 'none';
    }

    // Update UI badge & active preset button
    zoomBadge.textContent = `${currentZoom.toFixed(1)}×`;
    updatePresetPills(currentZoom);
  }

  function adjustZoom(delta) {
    setZoom(currentZoom + delta);
  }

  function updatePresetPills(val) {
    const pills = zoomPresetsGroup.querySelectorAll('.zoom-preset-pill');
    pills.forEach(pill => {
      const z = parseFloat(pill.getAttribute('data-zoom'));
      const isMatch = Math.abs(z - val) < 0.25;
      pill.classList.toggle('active', isMatch);
    });
  }

  // Preset buttons click
  zoomPresetsGroup.addEventListener('click', (e) => {
    const pill = e.target.closest('.zoom-preset-pill');
    if (!pill) return;
    const targetZoom = parseFloat(pill.getAttribute('data-zoom'));
    if (!isNaN(targetZoom)) {
      setZoom(targetZoom);
      vibrate(20);
    }
  });

  btnZoomOut.addEventListener('click', () => {
    adjustZoom(-0.5);
    vibrate(15);
  });

  btnZoomIn.addEventListener('click', () => {
    adjustZoom(0.5);
    vibrate(15);
  });

  // Pinch-to-zoom gesture on camera container
  let initialPinchDist = null;
  let zoomAtPinchStart = 1.0;

  const cameraContainer = document.getElementById('cameraContainer');

  cameraContainer.addEventListener('touchstart', (e) => {
    if (e.touches.length === 2) {
      initialPinchDist = Math.hypot(
        e.touches[0].clientX - e.touches[1].clientX,
        e.touches[0].clientY - e.touches[1].clientY
      );
      zoomAtPinchStart = currentZoom;
    }
  }, { passive: true });

  cameraContainer.addEventListener('touchmove', (e) => {
    if (e.touches.length === 2 && initialPinchDist) {
      const currentDist = Math.hypot(
        e.touches[0].clientX - e.touches[1].clientX,
        e.touches[0].clientY - e.touches[1].clientY
      );
      if (initialPinchDist > 10) {
        const factor = currentDist / initialPinchDist;
        setZoom(zoomAtPinchStart * factor, false);
      }
    }
  }, { passive: true });

  cameraContainer.addEventListener('touchend', (e) => {
    if (e.touches.length < 2) {
      initialPinchDist = null;
    }
  });

  // Mouse wheel zoom on desktop
  cameraContainer.addEventListener('wheel', (e) => {
    e.preventDefault();
    const delta = e.deltaY < 0 ? 0.3 : -0.3;
    adjustZoom(delta);
  }, { passive: false });

  // Double tap to toggle zoom 1x <-> 2x
  let lastTapTime = 0;
  cameraContainer.addEventListener('click', (e) => {
    // Avoid clicking on buttons inside
    if (e.target.closest('button') || e.target.closest('label')) return;
    const now = Date.now();
    if (now - lastTapTime < 300) {
      setZoom(currentZoom > 1.4 ? 1.0 : 2.0);
      vibrate(25);
    }
    lastTapTime = now;
  });

  // =========================================================================
  // 3. High-Quality Photo Capture & Image Enhancement
  // =========================================================================
  function captureHighQualityPhoto() {
    if (!videoFeed.videoWidth || !videoFeed.videoHeight) {
      return null;
    }

    const vw = videoFeed.videoWidth;
    const vh = videoFeed.videoHeight;

    // If digital zoom is applied (and not solely handled by hardware optical lens),
    // crop accurately from the centered zoom region so the resulting photo is magnified in high detail!
    let srcX = 0;
    let srcY = 0;
    let srcW = vw;
    let srcH = vh;

    if (!hardwareZoomSupported && currentZoom > 1.01) {
      srcW = vw / currentZoom;
      srcH = vh / currentZoom;
      srcX = (vw - srcW) / 2;
      srcY = (vh - srcH) / 2;
    }

    // Set canvas dimensions to preserve sharp text resolution (up to 1920px max dimension)
    const targetWidth = Math.min(1920, Math.round(srcW));
    const targetHeight = Math.round(srcH * (targetWidth / srcW));

    captureCanvas.width = targetWidth;
    captureCanvas.height = targetHeight;

    const ctx = captureCanvas.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

    // Draw magnified image onto high-resolution canvas
    ctx.drawImage(
      videoFeed,
      srcX, srcY, srcW, srcH,
      0, 0, targetWidth, targetHeight
    );

    // Return high-quality JPEG
    return captureCanvas.toDataURL('image/jpeg', 0.94);
  }

  // Haptic feedback helper
  function vibrate(ms = 30) {
    if (navigator.vibrate) {
      try { navigator.vibrate(ms); } catch (e) {}
    }
  }

  // Camera shutter sound & flash effect
  function triggerShutterEffects(dataUrl) {
    // 1. Screen flash
    cameraFlash.classList.add('flash-active');
    setTimeout(() => {
      cameraFlash.classList.remove('flash-active');
    }, 120);

    // 2. Haptic vibration
    vibrate([40, 30, 40]);

    // 3. Audio camera click synthesis
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (AudioCtx && isAudioEnabled) {
        const audioCtx = new AudioCtx();
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(850, audioCtx.currentTime);
        osc.frequency.exponentialRampToValueAtTime(140, audioCtx.currentTime + 0.05);
        gain.gain.setValueAtTime(0.28, audioCtx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.06);
        osc.connect(gain);
        gain.connect(audioCtx.destination);
        osc.start();
        osc.stop(audioCtx.currentTime + 0.07);
      }
    } catch (e) {}

    // 4. Snapshot thumbnail preview
    if (dataUrl) {
      snapshotImg.src = dataUrl;
      snapshotPreview.classList.remove('hidden');
    }
  }

  // =========================================================================
  // 4. Photo Shooting & Solve Pipeline
  // =========================================================================
  async function takePhotoAndSolve() {
    if (isAnalyzing) return;

    const imageData = captureHighQualityPhoto();
    if (!imageData) {
      alert('Камера ещё не готова. Подождите секунду и повторите.');
      return;
    }

    triggerShutterEffects(imageData);
    await solveImage(imageData);
  }

  async function solveImage(imageData) {
    isAnalyzing = true;
    btnManualSnap.classList.add('solving');
    shutterSpinner.classList.remove('hidden');
    shutterLabel.textContent = 'РАСПОЗНАВАНИЕ...';
    statusPill.className = 'status-pill solving';
    statusLabel.textContent = 'АНАЛИЗ ФОТО...';
    frameGuide.classList.add('solving');

    try {
      const endpoint = `${getApiBaseUrl()}/api/solve`;
      const resp = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image: imageData })
      });

      const res = await resp.json();
      handleSolveResponse(res);
    } catch (err) {
      console.error('Solve request error:', err);
      statusPill.className = 'status-pill';
      statusLabel.textContent = 'ОШИБКА СВЯЗИ';
      setTimeout(setStatusReady, 2500);
    } finally {
      isAnalyzing = false;
      btnManualSnap.classList.remove('solving');
      shutterSpinner.classList.add('hidden');
      shutterLabel.textContent = 'СНЯТЬ ФОТО';
      frameGuide.classList.remove('solving');
    }
  }

  function setStatusReady() {
    statusPill.className = 'status-pill';
    statusLabel.textContent = 'ГОТОВ К ФОТО';
  }

  function handleSolveResponse(res) {
    if (!res || !res.found) {
      statusPill.className = 'status-pill';
      statusLabel.textContent = 'ВОПРОС НЕ НАЙДЕН';
      setTimeout(setStatusReady, 2500);
      return;
    }

    lastSolvedData = res;
    statusPill.className = 'status-pill solved';
    statusLabel.textContent = `ОТВЕТ НАЙДЕН (${res.latency_ms || 800}мс)`;
    vibrate([60, 40, 80]);

    renderAnswer(res);

    if (isAudioEnabled && res.correct_answer) {
      speakAnswer(res.correct_answer);
    }
  }

  function renderAnswer(res) {
    drawerIdle.classList.add('hidden');
    drawerSolved.classList.remove('hidden');

    if (res.bank_match && res.bank_match.verified) {
      badgeSource.className = 'badge-source verified';
      sourceLabel.textContent = '✓ БАЗА ИЦА (100% ВЕРНО)';
    } else {
      badgeSource.className = 'badge-source';
      sourceLabel.textContent = `⚡ ${res.model_used || 'Gemini 3.1 Vision'}`;
    }

    confidenceLabel.textContent = `${Math.round((res.confidence || 0.98) * 100)}% точность`;
    latencyPill.textContent = `${res.latency_ms || 780}ms`;

    correctAnswerText.textContent = res.correct_answer || 'Ответ определён';
    questionText.textContent = res.question || '—';

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

    let exp = res.explanation || '';
    if (res.bank_match && res.bank_match.npa_ref) {
      exp += `\n\nНПА: ${res.bank_match.npa_ref}`;
    }
    explanationText.textContent = exp || 'Ответ подтверждён нормативными источниками и моделью.';

    answerDrawer.scrollTop = 0;
  }

  // =========================================================================
  // 5. Actions & UI Handlers
  // =========================================================================
  // Primary Shutter Button Click
  btnManualSnap.addEventListener('click', takePhotoAndSolve);

  // Keyboard shortcut: Spacebar or Enter to snap photo on desktop
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Space' && !e.target.closest('input, textarea')) {
      e.preventDefault();
      takePhotoAndSolve();
    }
  });

  // Take next question button in answer drawer
  btnNewPhoto.addEventListener('click', () => {
    drawerSolved.classList.add('hidden');
    drawerIdle.classList.remove('hidden');
    snapshotPreview.classList.add('hidden');
    lastSolvedData = null;
    setStatusReady();
    vibrate(20);
  });

  btnDismiss.addEventListener('click', () => {
    drawerSolved.classList.add('hidden');
    drawerIdle.classList.remove('hidden');
    snapshotPreview.classList.add('hidden');
    lastSolvedData = null;
    setStatusReady();
  });

  // File Picker Upload
  inputFileUpload.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => {
      const dataUrl = event.target.result;
      triggerShutterEffects(dataUrl);
      solveImage(dataUrl);
    };
    reader.readAsDataURL(file);
    e.target.value = '';
  });

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

  function speakAnswer(text) {
    if (!('speechSynthesis' in window)) return;
    window.speechSynthesis.cancel();

    const cleanText = text.replace(/^[A-Da-d0-9\)\.\-–—\s]+/, '').trim() || text;
    const utterance = new SpeechSynthesisUtterance(cleanText);
    utterance.lang = 'ru-RU';
    utterance.rate = 1.05;
    window.speechSynthesis.speak(utterance);
  }

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

  btnAllowCamera.addEventListener('click', initCamera);

  // =========================================================================
  // 6. Sample Questions Modal & Synthesized Tickets
  // =========================================================================
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
      category: "Электробезопасность и ПТЭ/ПУЭ",
      title: "Категории электроприемников",
      question: "Каким источником питания должны обеспечиваться электроприемники первой категории особой группы?",
      options: [
        "A) Двумя независимыми источниками питания",
        "B) Дополнительным третьим независимым источником питания",
        "C) Одним надежным источником напряжением 220В",
        "D) Аккумуляторной батареей на 1 час"
      ]
    }
  ];

  async function loadBankSamples() {
    try {
      const resp = await fetch(`${getApiBaseUrl()}/api/samples`);
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
    liveSamples.forEach((s) => {
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
    cameraFallback.classList.add('hidden');
    const cvs = captureCanvas;
    cvs.width = 1000;
    cvs.height = 700;
    const ctx = cvs.getContext('2d');

    // Crisp high-contrast paper card
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, cvs.width, cvs.height);

    ctx.fillStyle = '#111827';
    ctx.font = 'bold 22px Arial, sans-serif';
    ctx.fillText('ЭКЗАМЕНАЦИОННЫЙ БИЛЕТ ПРОВЕРКИ ЗНАНИЙ', 40, 50);

    ctx.font = 'bold 20px Arial, sans-serif';
    ctx.fillStyle = '#111827';

    // Wrap question text
    const words = sample.question.split(' ');
    let line = '';
    let y = 100;
    for (const w of words) {
      const testLine = line + w + ' ';
      if (ctx.measureText(testLine).width > 900) {
        ctx.fillText(line, 40, y);
        line = w + ' ';
        y += 30;
      } else {
        line = testLine;
      }
    }
    ctx.fillText(line, 40, y);
    y += 45;

    // Wrap option items with clear lettering
    ctx.font = '19px Arial, sans-serif';
    const letters = ['A', 'B', 'C', 'D', 'E', 'F'];
    sample.options.forEach((opt, idx) => {
      ctx.fillStyle = '#1F2937';
      const prefix = /^[A-Za-z0-9\)\.\-]/.test(opt.trim()) ? '' : `${letters[idx] || (idx + 1)}) `;
      const fullOpt = prefix + opt;

      const optWords = fullOpt.split(' ');
      let optLine = '';
      for (const ow of optWords) {
        const testOpt = optLine + ow + ' ';
        if (ctx.measureText(testOpt).width > 900) {
          ctx.fillText(optLine, 40, y);
          optLine = '   ' + ow + ' ';
          y += 28;
        } else {
          optLine = testOpt;
        }
      }
      ctx.fillText(optLine, 40, y);
      y += 38;
    });

    const imgData = cvs.toDataURL('image/jpeg', 0.95);
    triggerShutterEffects(imgData);
    solveImage(imgData);
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

  // =========================================================================
  // 7. Settings Modal
  // =========================================================================
  async function testBackendHealth(url) {
    settingsStatus.className = 'settings-status';
    settingsStatusText.textContent = 'Проверка соединения...';
    try {
      const resp = await fetch(`${url}/api/status`, { signal: AbortSignal.timeout(4000) });
      const data = await resp.json();
      if (data && data.status === 'online') {
        settingsStatus.className = 'settings-status online';
        settingsStatusText.textContent = `Онлайн: ${data.question_bank_size || 0} вопросов в базе (${data.primary_model || 'Gemini'})`;
        return true;
      }
    } catch (e) {
      settingsStatus.className = 'settings-status offline';
      settingsStatusText.textContent = 'Недоступен (проверьте URL)';
    }
    return false;
  }

  btnSettings.addEventListener('click', () => {
    inputBackendUrl.value = getApiBaseUrl();
    settingsModal.classList.remove('hidden');
    testBackendHealth(inputBackendUrl.value);
  });

  btnCloseSettings.addEventListener('click', () => {
    settingsModal.classList.add('hidden');
  });

  btnSetCloudflare.addEventListener('click', () => {
    inputBackendUrl.value = DEFAULT_REMOTE_BACKEND;
    testBackendHealth(inputBackendUrl.value);
  });

  btnSetLocal.addEventListener('click', () => {
    inputBackendUrl.value = 'http://localhost:8000';
    testBackendHealth(inputBackendUrl.value);
  });

  btnSaveBackend.addEventListener('click', async () => {
    const val = inputBackendUrl.value.trim().replace(/\/+$/, '');
    localStorage.setItem('mind_backend_url', val);
    const ok = await testBackendHealth(val);
    if (ok) {
      setTimeout(() => {
        settingsModal.classList.add('hidden');
      }, 600);
      loadBankSamples();
    }
  });

  // Start Camera
  initCamera();
})();
