(() => {
  'use strict';

  const DURATION = 15;
  const SAMPLE_STEP = 0.1;
  const INITIAL_RATE_WINDOW = 3;
  const KM_MILLIMOLAR = 45;
  const KCAT_PER_SECOND = 0.72;
  const COLORS = { substrate: '#43ad67', enzyme: '#3b85d1', product: '#e6b527', inhibitor: '#ed8176' };
  const TRACE_COLORS = ['#db8f37', '#427dc0', '#896bc4', '#cb625e', '#338f81'];
  const $ = (id) => document.getElementById(id);
  const els = {
    controls: $('controlsFieldset'), temp: $('tempRange'), ph: $('phRange'), substrate: $('substrateRange'), enzyme: $('enzymeRange'), inhibitor: $('inhibitorSelect'),
    tempValue: $('tempValue'), phValue: $('phValue'), substrateValue: $('substrateValue'), enzymeValue: $('enzymeValue'), runButton: $('runButton'), runHint: $('runHint'),
    runProgress: $('runProgress'), runStateText: $('runStateText'), timeReadout: $('timeReadout'), progressTrack: $('progressTrack'), progressFill: $('progressFill'),
    productResult: $('productResult'), rateResult: $('rateResult'), repeatStatus: $('repeatStatus'), trialCount: $('trialCount'), trialRows: $('trialRows'),
    downloadButton: $('downloadButton'), clearButton: $('clearButton'), graphCanvas: $('graphCanvas'), chamberCanvas: $('chamberCanvas'), collisionNote: $('collisionNote'),
    traceIndicator: $('traceIndicator'), compareStatus: $('compareStatus'), toast: $('toast')
  };
  const spriteSources = {
    enzyme: { storage: '/manus-storage/enzyme-molecule_4a859392.png', fallback: '/public/assets/enzyme-molecule.png' },
    substrate: { storage: '/manus-storage/substrate-molecule_20873cab.png', fallback: '/public/assets/substrate-molecule.png' },
    product: { storage: '/manus-storage/product-molecule_591bf173.png', fallback: '/public/assets/product-molecule.png' }
  };
  function loadSprite(source) {
    const image = new Image();
    let triedFallback = false;
    image.addEventListener('error', () => {
      if (!triedFallback) {
        triedFallback = true;
        image.src = source.fallback;
      }
    });
    image.src = source.storage;
    return image;
  }
  const moleculeSprites = Object.fromEntries(Object.entries(spriteSources).map(([name, source]) => [name, loadSprite(source)]));
  const heroImage = document.querySelector('img[data-storage]');
  if (heroImage) {
    const storageImage = new Image();
    storageImage.addEventListener('load', () => { heroImage.src = storageImage.src; }, { once: true });
    storageImage.src = heroImage.dataset.storage;
  }

  const state = {
    records: [], selectedTrials: new Set(), running: false, runStartedAt: 0, intervalId: null, samples: [], simulatedTime: 0, simulatedProduct: 0,
    currentConditions: null, variation: 1, currentRate: 0, graphMaxProduct: 10, particles: [], chamberSize: { width: 0, height: 0 },
    lastFrame: 0, toastTimeout: null, stirPulse: null, stopTimeoutId: null
  };

  function readConditions() {
    return {
      temp: Number(els.temp.value),
      ph: Number(Number(els.ph.value).toFixed(1)),
      substrate: Number(els.substrate.value),
      enzyme: Number(Number(els.enzyme.value).toFixed(1)),
      inhibitor: els.inhibitor.value
    };
  }

  function conditionKey(c) {
    return `${c.temp}|${c.ph.toFixed(1)}|${c.substrate}|${c.enzyme.toFixed(1)}|${c.inhibitor}`;
  }

  function inhibitorLabel(value) {
    return value === 'competitive' ? 'Competitive' : value === 'noncompetitive' ? 'Non-Competitive' : 'None';
  }

  function activityFactors(c) {
    const tempFactor = c.temp <= 37
      ? Math.exp(-(37 - c.temp) / 22)
      : Math.exp(-Math.pow((c.temp - 37) / 15, 2));
    const phFactor = Math.exp(-0.5 * Math.pow((c.ph - 7) / 2, 2));
    const km = c.inhibitor === 'competitive' ? KM_MILLIMOLAR * 3.2 : KM_MILLIMOLAR;
    const vmaxFactor = c.inhibitor === 'noncompetitive' ? 0.52 : 1;
    return { tempFactor, phFactor, km, vmaxFactor };
  }

  function reactionRate(c, substrateM, variation = 1) {
    const { tempFactor, phFactor, km, vmaxFactor } = activityFactors(c);
    const michaelisFactor = substrateM / (km + substrateM);
    return KCAT_PER_SECOND * c.enzyme * tempFactor * phFactor * vmaxFactor * michaelisFactor * variation;
  }

  function updateSliderFill(input) {
    const min = Number(input.min);
    const max = Number(input.max);
    const ratio = (Number(input.value) - min) / (max - min) * 100;
    input.style.setProperty('--range-progress', `${ratio}%`);
  }

  function updateControlOutputs() {
    const c = readConditions();
    els.tempValue.value = `${c.temp}°C`;
    els.tempValue.textContent = `${c.temp}°C`;
    els.phValue.value = c.ph.toFixed(1);
    els.phValue.textContent = c.ph.toFixed(1);
    els.substrateValue.value = `${c.substrate} mM`;
    els.substrateValue.textContent = `${c.substrate} mM`;
    els.enzymeValue.value = `${Number.isInteger(c.enzyme) ? c.enzyme.toFixed(0) : c.enzyme.toFixed(1)} µM`;
    els.enzymeValue.textContent = `${Number.isInteger(c.enzyme) ? c.enzyme.toFixed(0) : c.enzyme.toFixed(1)} µM`;
    [els.temp, els.ph, els.substrate, els.enzyme].forEach(updateSliderFill);
    updateRepeatStatus();
    syncParticles(c);
    drawGraph();
  }

  function updateRepeatStatus() {
    const c = readConditions();
    const completed = state.records.filter((r) => r.conditionKey === conditionKey(c)).length;
    if (completed < 5) {
      els.repeatStatus.innerHTML = `Repeat ${completed + 1} of 5 <span>· same conditions</span>`;
    } else {
      els.repeatStatus.innerHTML = `5 repeats complete <span>· additional runs welcome</span>`;
    }
  }

  function updateCompareStatus() {
    const ids = [...state.selectedTrials].sort((a, b) => a - b);
    if (ids.length === 0) {
      els.compareStatus.textContent = 'Select a trial number below to overlay its curve here.';
      return;
    }
    els.compareStatus.textContent = `Comparing trial${ids.length === 1 ? '' : 's'} ${ids.map((id) => `#${id}`).join(', ')} · tap a selected number to remove its curve.`;
  }

  function sampleNextPoint() {
    const dt = Math.min(SAMPLE_STEP, DURATION - state.simulatedTime);
    if (dt <= 0) return;
    const rate = reactionRate(state.currentConditions, state.currentConditions.substrate - state.simulatedProduct / 1000, state.variation);
    state.simulatedProduct += rate * dt;
    state.simulatedTime = Math.min(DURATION, state.simulatedTime + dt);
    state.samples.push({ time: state.simulatedTime, product: state.simulatedProduct });
  }

  function linearRegressionSlope(points) {
    if (points.length < 2) return 0;
    const meanX = points.reduce((sum, p) => sum + p.time, 0) / points.length;
    const meanY = points.reduce((sum, p) => sum + p.product, 0) / points.length;
    let numerator = 0;
    let denominator = 0;
    points.forEach((p) => {
      numerator += (p.time - meanX) * (p.product - meanY);
      denominator += Math.pow(p.time - meanX, 2);
    });
    return denominator === 0 ? 0 : numerator / denominator;
  }

  function runTrial() {
    if (state.running) return;
    state.running = true;
    state.currentConditions = readConditions();
    state.variation = 0.97 + Math.random() * 0.06;
    state.simulatedTime = 0;
    state.simulatedProduct = 0;
    state.currentRate = reactionRate(state.currentConditions, state.currentConditions.substrate, state.variation);
    state.samples = [{ time: 0, product: 0 }];
    state.graphMaxProduct = Math.max(10, Math.ceil((state.currentRate * DURATION * 1.12) / 10) * 10);
    state.runStartedAt = performance.now();
    state.particles = state.particles.filter((p) => p.kind !== 'product');
    syncParticles(state.currentConditions);
    els.controls.disabled = true;
    renderTable();
    els.runButton.disabled = true;
    els.runButton.innerHTML = '<span class="play-icon" aria-hidden="true">●</span><span>Trial in progress…</span>';
    els.runHint.textContent = 'Conditions are locked during a run so your data stay consistent.';
    els.runProgress.hidden = false;
    els.runStateText.textContent = 'Reaction running';
    els.productResult.textContent = '…';
    els.rateResult.textContent = '…';
    els.traceIndicator.classList.add('active');
    els.progressFill.style.width = '0%';
    els.progressTrack.setAttribute('aria-valuenow', '0');
    updateRunClock(0);
    drawGraph();
    state.stopTimeoutId = window.setTimeout(finishTrial, DURATION * 1000);
    state.intervalId = window.setInterval(updateTrial, 50);
  }

  function updateRunClock(elapsed) {
    const safe = Math.min(DURATION, Math.max(0, elapsed));
    els.timeReadout.textContent = `${safe.toFixed(1)} / ${DURATION.toFixed(1)} s`;
    els.progressFill.style.width = `${safe / DURATION * 100}%`;
    els.progressTrack.setAttribute('aria-valuenow', safe.toFixed(1));
  }

  function updateTrial() {
    const elapsed = Math.min(DURATION, (performance.now() - state.runStartedAt) / 1000);
    const target = Math.floor((elapsed + 1e-7) / SAMPLE_STEP) * SAMPLE_STEP;
    while (state.simulatedTime + 1e-6 < target) sampleNextPoint();
    updateRunClock(elapsed);
    syncParticles(state.currentConditions);
    if (elapsed >= DURATION) finishTrial();
    else drawGraph();
  }

  function finishTrial() {
    if (!state.running) return;
    while (state.simulatedTime + 1e-6 < DURATION) sampleNextPoint();
    state.samples[state.samples.length - 1] = { time: DURATION, product: state.simulatedProduct };
    const firstSeconds = state.samples.filter((point) => point.time <= INITIAL_RATE_WINDOW + 1e-6);
    const initialRate = Math.max(0, linearRegressionSlope(firstSeconds));
    const c = state.currentConditions;
    const record = {
      trial: state.records.length + 1,
      temp: c.temp,
      ph: c.ph,
      substrate: c.substrate,
      enzyme: c.enzyme,
      inhibitor: inhibitorLabel(c.inhibitor),
      product: state.simulatedProduct,
      initialRate,
      conditionKey: conditionKey(c),
      trace: state.samples.map((point) => ({ time: point.time, product: point.product }))
    };
    state.records.push(record);
    state.running = false;
    window.clearInterval(state.intervalId);
    state.intervalId = null;
    window.clearTimeout(state.stopTimeoutId);
    state.stopTimeoutId = null;
    els.controls.disabled = false;
    els.runButton.disabled = false;
    els.runButton.innerHTML = '<span class="play-icon" aria-hidden="true">▶</span><span>Run 15-Second Trial</span><span class="button-arrow" aria-hidden="true">↗</span>';
    els.runHint.textContent = 'Trial complete. Keep these settings for repeats, or adjust one condition.';
    els.runProgress.hidden = false;
    els.runStateText.textContent = 'Trial complete';
    updateRunClock(DURATION);
    els.productResult.textContent = record.product.toFixed(2);
    els.rateResult.textContent = record.initialRate.toFixed(3);
    els.traceIndicator.classList.add('active');
    renderTable();
    updateRepeatStatus();
    syncParticles(readConditions());
    drawGraph();
  }

  function canvasContext(canvas) {
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    const ratio = Math.max(1, Math.min(window.devicePixelRatio || 1, 2));
    const width = Math.round(rect.width * ratio);
    const height = Math.round(rect.height * ratio);
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    return { ctx, width: rect.width, height: rect.height };
  }

  function drawGraph() {
    if (!els.graphCanvas) return;
    const surface = canvasContext(els.graphCanvas);
    if (!surface) return;
    const { ctx, width: w, height: h } = surface;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
    const pad = { left: 82, right: 20, top: 20, bottom: 42 };
    const plotW = w - pad.left - pad.right;
    const plotH = h - pad.top - pad.bottom;
    if (plotW <= 0 || plotH <= 0) return;
    const current = state.currentConditions || readConditions();
    const predicted = reactionRate(current, current.substrate, state.running ? state.variation : 1) * DURATION;
    const selectedRecords = state.records.filter((record) => state.selectedTrials.has(record.trial));
    const largestSelected = selectedRecords.reduce((maximum, record) => Math.max(maximum, record.product), 0);
    const liveMax = state.samples.length > 1 ? state.graphMaxProduct : 0;
    const yMax = Math.max(10, Math.ceil(Math.max(predicted * 1.12, liveMax, largestSelected * 1.12) / 10) * 10);
    const x = (value) => pad.left + (value / DURATION) * plotW;
    const y = (value) => pad.top + plotH - (value / yMax) * plotH;

    ctx.font = '20px "DM Mono", monospace';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'right';
    for (let i = 0; i <= 4; i += 1) {
      const value = yMax * i / 4;
      const yy = y(value);
      ctx.beginPath();
      ctx.moveTo(pad.left, yy);
      ctx.lineTo(w - pad.right, yy);
      ctx.strokeStyle = i === 0 ? '#cbd6d5' : '#edf1f0';
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.fillStyle = '#687d80';
      ctx.fillText(value.toFixed(value < 10 && yMax < 40 ? 1 : 0), pad.left - 10, yy);
    }
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (let i = 0; i <= 5; i += 1) {
      const value = i * 3;
      const xx = x(value);
      ctx.beginPath();
      ctx.moveTo(xx, pad.top);
      ctx.lineTo(xx, pad.top + plotH);
      ctx.strokeStyle = i === 0 ? '#cbd6d5' : '#f1f4f3';
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.fillStyle = '#687d80';
      ctx.fillText(String(value), xx, pad.top + plotH + 8);
    }
    ctx.save();
    ctx.translate(23, pad.top + plotH / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#536b70';
    ctx.font = '20px "DM Mono", monospace';
    ctx.fillText('Product (µM)', 0, 0);
    ctx.restore();

    const drawTrace = (points, color, width, dash = []) => {
      if (!points || points.length < 2) return;
      ctx.beginPath();
      points.forEach((point, index) => {
        if (index === 0) ctx.moveTo(x(point.time), y(point.product));
        else ctx.lineTo(x(point.time), y(point.product));
      });
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.setLineDash(dash);
      ctx.stroke();
      ctx.setLineDash([]);
    };

    if (state.samples.length > 1) {
      const points = state.samples;
      const last = points[points.length - 1];
      const gradient = ctx.createLinearGradient(0, pad.top, 0, pad.top + plotH);
      gradient.addColorStop(0, 'rgba(20, 135, 126, .16)');
      gradient.addColorStop(1, 'rgba(20, 135, 126, .01)');
      ctx.beginPath();
      ctx.moveTo(x(points[0].time), y(0));
      points.forEach((point) => ctx.lineTo(x(point.time), y(point.product)));
      ctx.lineTo(x(last.time), y(0));
      ctx.closePath();
      ctx.fillStyle = gradient;
      ctx.fill();
      drawTrace(points, '#14877e', 3);
      ctx.beginPath();
      ctx.arc(x(last.time), y(last.product), 5, 0, Math.PI * 2);
      ctx.fillStyle = '#14877e';
      ctx.fill();
    }

    selectedRecords.forEach((record) => {
      const color = TRACE_COLORS[(record.trial - 1) % TRACE_COLORS.length];
      drawTrace(record.trace, color, 3, [9, 6]);
    });

    if (state.samples.length <= 1 && selectedRecords.length === 0) {
      ctx.setLineDash([7, 6]);
      ctx.beginPath();
      ctx.moveTo(pad.left, pad.top + plotH - 9);
      ctx.lineTo(w - pad.right, pad.top + plotH - 9);
      ctx.strokeStyle = '#d7e5e3';
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#647a7d';
      ctx.font = '700 22px "DM Sans", sans-serif';
      ctx.fillText('Run a trial', pad.left + plotW / 2, pad.top + plotH / 2 - 13);
      ctx.fillStyle = '#7c8e90';
      ctx.font = '20px "DM Sans", sans-serif';
      if (plotW >= 190) ctx.fillText('Product curve', pad.left + plotW / 2, pad.top + plotH / 2 + 17);
    }
  }

  function randomParticle(kind, width, height) {
    const r = kind === 'enzyme' ? 10 + Math.random() * 2 : kind === 'substrate' ? 3.3 + Math.random() * 1.3 : kind === 'product' ? 3.7 : 3.4;
    const speed = kind === 'enzyme' ? 11 : 19 + Math.random() * 15;
    const angle = Math.random() * Math.PI * 2;
    return { kind, x: 24 + Math.random() * Math.max(1, width - 48), y: 32 + Math.random() * Math.max(1, height - 62), vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed, r, phase: Math.random() * Math.PI * 2, cooldown: 0, flash: 0 };
  }

  function syncParticles(c) {
    const rect = els.chamberCanvas.getBoundingClientRect();
    const width = rect.width || 500;
    const height = rect.height || 300;
    const desired = {
      enzyme: Math.max(3, Math.round(2.5 + c.enzyme * 0.45)),
      substrate: Math.min(32, 8 + Math.round((c.substrate - 10) / 6)),
      inhibitor: c.inhibitor === 'competitive' ? 6 : c.inhibitor === 'noncompetitive' ? 4 : 0
    };
    for (const [kind, count] of Object.entries(desired)) {
      const current = state.particles.filter((p) => p.kind === kind);
      if (current.length > count) {
        let remove = current.length - count;
        for (let i = state.particles.length - 1; i >= 0 && remove > 0; i -= 1) {
          if (state.particles[i].kind === kind) { state.particles.splice(i, 1); remove -= 1; }
        }
      } else {
        for (let i = current.length; i < count; i += 1) state.particles.push(randomParticle(kind, width, height));
      }
    }
    state.chamberSize = { width, height };
    const cNote = c.substrate >= 150 ? 'Frequent collisions' : c.substrate <= 30 ? 'Fewer collisions' : 'Particles in motion';
    if (!state.stirPulse) els.collisionNote.textContent = cNote;
  }

  function drawSprite(ctx, p, width, height) {
    const sprite = moleculeSprites[p.kind];
    if (sprite && sprite.complete && sprite.naturalWidth > 0) {
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(Math.sin(performance.now() / 1200 + p.phase) * (p.kind === 'enzyme' ? .035 : .12));
      ctx.globalAlpha = p.kind === 'product' ? .96 : .98;
      ctx.shadowColor = 'rgba(4, 20, 31, .42)';
      ctx.shadowBlur = p.kind === 'enzyme' ? 9 : 5;
      ctx.drawImage(sprite, -width / 2, -height / 2, width, height);
      ctx.restore();
      return true;
    }
    return false;
  }

  function drawEnzyme(ctx, p, t, dt) {
    const pulse = 1 + Math.sin(t * 2 + p.phase) * .025;
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.scale(pulse, pulse);
    if (p.flash > 0) {
      ctx.beginPath();
      ctx.arc(0, 0, p.r + 8, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(232,255,248,${Math.min(.8, p.flash * 1.8)})`;
      ctx.lineWidth = 3;
      ctx.stroke();
      p.flash = Math.max(0, p.flash - dt);
    }
    ctx.restore();
    if (!drawSprite(ctx, p, p.r * 3.9, p.r * 4.2)) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fillStyle = COLORS.enzyme;
      ctx.fill();
      ctx.beginPath();
      ctx.arc(p.x + p.r * .48, p.y - p.r * .5, p.r * .28, .7, 2.3);
      ctx.strokeStyle = '#e2f5ff';
      ctx.lineWidth = 3;
      ctx.stroke();
    }
  }

  function handleChamberStir(event) {
    const rect = els.chamberCanvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    const radius = Math.max(120, Math.min(190, rect.width * .34));
    state.particles.forEach((particle) => {
      const dx = particle.x - x;
      const dy = particle.y - y;
      const distance = Math.max(1, Math.sqrt(dx * dx + dy * dy));
      if (distance > radius) return;
      const strength = (1 - distance / radius) * 155;
      particle.vx += dx / distance * strength;
      particle.vy += dy / distance * strength;
      if (particle.kind === 'enzyme') particle.flash = .65;
      if (particle.kind === 'substrate') particle.cooldown = 0;
    });
    state.stirPulse = { x, y, start: performance.now() };
    els.collisionNote.textContent = 'Chamber stirred';
    showToast('Chamber stirred. Watch for an active-site encounter.');
  }

  function drawChamber(now) {
    const surface = canvasContext(els.chamberCanvas);
    if (!surface) return;
    const { ctx, width: w, height: h } = surface;
    const seconds = now / 1000;
    const dt = state.lastFrame ? Math.min(.045, Math.max(0, (now - state.lastFrame) / 1000)) : .016;
    state.lastFrame = now;
    const c = state.running ? state.currentConditions : readConditions();
    const speedScale = .65 + c.temp / 100;
    ctx.clearRect(0, 0, w, h);
    const bg = ctx.createLinearGradient(0, 0, w, h);
    bg.addColorStop(0, '#12263a');
    bg.addColorStop(1, '#0b192b');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = 'rgba(170,205,211,.045)';
    ctx.lineWidth = 1;
    for (let x = 18; x < w; x += 32) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke(); }
    for (let y = 18; y < h; y += 32) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); }
    ctx.strokeStyle = 'rgba(173,213,213,.24)';
    ctx.lineWidth = 2;
    ctx.strokeRect(1, 1, w - 2, h - 2);
    ctx.fillStyle = 'rgba(233,246,248,.86)';
    ctx.font = '700 20px "DM Mono", monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText('REACTION', 15, 20);
    if (w >= 340) {
      ctx.textAlign = 'right';
      ctx.fillStyle = 'rgba(233,246,248,.76)';
      ctx.fillText(`${c.temp}°C · pH ${c.ph.toFixed(1)}`, w - 15, 20);
    }

    const enzymes = state.particles.filter((p) => p.kind === 'enzyme');
    const substrates = state.particles.filter((p) => p.kind === 'substrate');
    for (const enzyme of enzymes) {
      for (const substrate of substrates) {
        const dx = substrate.x - enzyme.x;
        const dy = substrate.y - enzyme.y;
        const distance = Math.sqrt(dx * dx + dy * dy);
        if (distance < 54) {
          ctx.beginPath();
          ctx.moveTo(enzyme.x, enzyme.y);
          ctx.lineTo(substrate.x, substrate.y);
          ctx.strokeStyle = `rgba(151,231,213,${(1 - distance / 54) * .45})`;
          ctx.lineWidth = 2;
          ctx.stroke();
        }
      }
    }

    const factors = activityFactors(c);
    const substrateOccupancy = c.substrate / (factors.km + c.substrate);
    const catalysisChance = Math.min(.4, .35 * factors.tempFactor * factors.phFactor * factors.vmaxFactor * substrateOccupancy);
    let productCount = state.particles.filter((p) => p.kind === 'product').length;
    for (const substrate of substrates) {
      substrate.cooldown = Math.max(0, (substrate.cooldown || 0) - dt);
      if (substrate.cooldown > 0) continue;
      for (const enzyme of enzymes) {
        const dx = substrate.x - enzyme.x;
        const dy = substrate.y - enzyme.y;
        if (dx * dx + dy * dy > Math.pow(enzyme.r + substrate.r + 5, 2)) continue;
        substrate.cooldown = .55;
        enzyme.flash = .35;
        if (!state.running || productCount >= 18 || Math.random() >= catalysisChance) break;
        const angle = Math.atan2(dy, dx);
        substrate.kind = 'product';
        substrate.r = 3.8;
        substrate.vx += Math.cos(angle) * 18;
        substrate.vy += Math.sin(angle) * 18;
        substrate.phase = Math.random() * Math.PI * 2;
        productCount += 1;
        state.particles.push(randomParticle('substrate', w, h));
        break;
      }
    }

    for (const particle of state.particles) {
      const currentSpeed = Math.sqrt(particle.vx * particle.vx + particle.vy * particle.vy);
      const maxSpeed = particle.kind === 'enzyme' ? 14 : 42;
      particle.x += particle.vx * dt * speedScale;
      particle.y += particle.vy * dt * speedScale;
      const margin = particle.r + 5;
      if (particle.x < margin) { particle.x = margin; particle.vx = Math.abs(particle.vx); }
      if (particle.x > w - margin) { particle.x = w - margin; particle.vx = -Math.abs(particle.vx); }
      if (particle.y < 39 + particle.r) { particle.y = 39 + particle.r; particle.vy = Math.abs(particle.vy); }
      if (particle.y > h - margin - 24) { particle.y = h - margin - 24; particle.vy = -Math.abs(particle.vy); }
      if (currentSpeed > maxSpeed) { particle.vx *= maxSpeed / currentSpeed; particle.vy *= maxSpeed / currentSpeed; }
      if (particle.kind === 'enzyme') {
        drawEnzyme(ctx, particle, seconds, dt);
        continue;
      }
      if (particle.kind === 'substrate') {
        if (!drawSprite(ctx, particle, particle.r * 5.3, particle.r * 4.8)) {
          ctx.beginPath();
          ctx.arc(particle.x, particle.y, particle.r, 0, Math.PI * 2);
          ctx.fillStyle = COLORS.substrate;
          ctx.fill();
        }
      } else if (particle.kind === 'product') {
        if (!drawSprite(ctx, particle, particle.r * 5.1, particle.r * 4.5)) {
          ctx.beginPath();
          ctx.arc(particle.x, particle.y, particle.r, 0, Math.PI * 2);
          ctx.fillStyle = COLORS.product;
          ctx.fill();
        }
      } else {
        ctx.save();
        ctx.translate(particle.x, particle.y);
        ctx.rotate(Math.sin(seconds + particle.phase) * .15);
        ctx.fillStyle = COLORS.inhibitor;
        ctx.beginPath();
        ctx.arc(-4, 0, 5, 0, Math.PI * 2);
        ctx.arc(4, 0, 5, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
    }

    if (state.stirPulse) {
      const progress = Math.min(1, (now - state.stirPulse.start) / 850);
      if (progress < 1) {
        ctx.beginPath();
        ctx.arc(state.stirPulse.x, state.stirPulse.y, 18 + progress * 94, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(170,239,227,${(1 - progress) * .7})`;
        ctx.lineWidth = 3;
        ctx.stroke();
      } else {
        state.stirPulse = null;
        syncParticles(readConditions());
      }
    }
    ctx.fillStyle = 'rgba(233,246,248,.78)';
    ctx.font = '700 20px "DM Mono", monospace';
    ctx.textAlign = 'left';
    ctx.fillText(`ENZ ${enzymes.length}`, 15, h - 17);
    ctx.textAlign = 'right';
    ctx.fillText(`SUB ${substrates.length}`, w - 15, h - 17);
    window.requestAnimationFrame(drawChamber);
  }

  function renderTable() {
    els.trialCount.textContent = String(state.records.length);
    els.downloadButton.disabled = state.records.length === 0 || state.running;
    els.clearButton.disabled = state.records.length === 0 || state.running;
    if (state.records.length === 0) {
      els.trialRows.innerHTML = '<tr class="empty-row"><td colspan="8"><span class="empty-mark">↗</span><span>Your first trial will appear here.</span></td></tr>';
      updateCompareStatus();
      return;
    }
    els.trialRows.innerHTML = state.records.map((r) => {
      const selected = state.selectedTrials.has(r.trial);
      return `<tr class="${selected ? 'trace-selected' : ''}">
        <td><button class="trial-trace-button" type="button" data-trial="${r.trial}" aria-pressed="${selected}" aria-label="Toggle trial ${r.trial} comparison curve">${r.trial}</button></td><td>${r.temp}</td><td>${r.ph.toFixed(1)}</td><td>${r.substrate}</td><td>${Number.isInteger(r.enzyme) ? r.enzyme.toFixed(0) : r.enzyme.toFixed(1)}</td><td>${r.inhibitor}</td><td>${r.product.toFixed(2)}</td><td>${r.initialRate.toFixed(3)}</td>
      </tr>`;
    }).join('');
    updateCompareStatus();
  }

  function toggleTrialTrace(trialNumber) {
    if (state.selectedTrials.has(trialNumber)) {
      state.selectedTrials.delete(trialNumber);
    } else {
      if (state.selectedTrials.size >= 5) {
        showToast('Compare up to five recorded trial curves at a time.');
        return;
      }
      state.selectedTrials.add(trialNumber);
    }
    renderTable();
    drawGraph();
  }

  function downloadCSV() {
    if (!state.records.length) return;
    const headings = ['Trial #', 'Temp (°C)', 'pH', '[Substrate] (mM)', '[Enzyme] (µM)', 'Inhibitor', 'Product at 15s (µM)', 'Initial Rate (µM/s)'];
    const rows = state.records.map((r) => [r.trial, r.temp, r.ph.toFixed(1), r.substrate, r.enzyme, r.inhibitor, r.product.toFixed(2), r.initialRate.toFixed(3)]);
    const quote = (value) => `"${String(value).replaceAll('"', '""')}"`;
    const csv = '\ufeff' + [headings, ...rows].map((row) => row.map(quote).join(',')).join('\r\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `ib-biology-c1-1-enzyme-trials-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    showToast('CSV downloaded. Your trial data is ready to analyze.');
  }

  function clearTrials() {
    if (!state.records.length || state.running) return;
    state.records = [];
    state.selectedTrials.clear();
    state.samples = [];
    state.particles = state.particles.filter((p) => p.kind !== 'product');
    state.simulatedProduct = 0;
    state.simulatedTime = 0;
    els.productResult.textContent = '—';
    els.rateResult.textContent = '—';
    els.runHint.textContent = 'A trial runs for exactly 15.0 seconds. Keep the same settings for five repeats.';
    els.runProgress.hidden = true;
    els.traceIndicator.classList.remove('active');
    renderTable();
    updateRepeatStatus();
    syncParticles(readConditions());
    drawGraph();
    showToast('Recorded trials cleared. Ready for a new investigation.');
  }

  function showToast(message) {
    els.toast.textContent = message;
    els.toast.classList.add('visible');
    window.clearTimeout(state.toastTimeout);
    state.toastTimeout = window.setTimeout(() => els.toast.classList.remove('visible'), 3600);
  }

  [els.temp, els.ph, els.substrate, els.enzyme].forEach((input) => input.addEventListener('input', updateControlOutputs));
  els.inhibitor.addEventListener('change', updateControlOutputs);
  els.runButton.addEventListener('click', runTrial);
  els.downloadButton.addEventListener('click', downloadCSV);
  els.clearButton.addEventListener('click', clearTrials);
  els.trialRows.addEventListener('click', (event) => {
    const button = event.target.closest('.trial-trace-button');
    if (button) toggleTrialTrace(Number(button.dataset.trial));
  });
  els.chamberCanvas.addEventListener('pointerdown', handleChamberStir);
  window.addEventListener('resize', () => { syncParticles(readConditions()); drawGraph(); });

  updateControlOutputs();
  renderTable();
  drawGraph();
  window.requestAnimationFrame(drawChamber);
})();
