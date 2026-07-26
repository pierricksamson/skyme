(() => {
  const statusPanel = document.getElementById('statusPanel');
  const statusText = document.getElementById('statusText');
  const errorPanel = document.getElementById('errorPanel');
  const errorText = document.getElementById('errorText');
  const mainContent = document.getElementById('mainContent');
  const bottomNav = document.getElementById('bottomNav');
  const locLine = document.getElementById('locLine');
  const refreshBtn = document.getElementById('refreshBtn');
  const retryBtn = document.getElementById('retryBtn');

  const BASE_PX_PER_MIN = 2.4;
  const ZOOM_MIN = 0.5;
  const ZOOM_MAX = 3;
  const ZOOM_STEP = 0.25;

  // Tous les réglages persistants (zoom, plage horaire, altitude min,
  // mode nocturne...) vivent désormais côté serveur (SQLite), rien n'est
  // stocké dans localStorage. settingsCache est rempli par
  // loadSettingsFromServer() avant toute utilisation.
  let settingsCache = {
    zoom_mode: 'auto',
    zoom_value: 1,
    pref_mode: 'margin',
    pref_margin: 30,
    pref_fixed_start: '20:00',
    pref_fixed_end: '06:00',
    pref_min_alt: 10,
    red_filter: false,
  };

  let zoomMode = 'auto';
  let zoomLevel = 1; // valeur réelle courante, recalculée si zoomMode === 'auto'

  let currentData = null;
  let nowLineTimer = null;

  const AGENDA_DAYS = 30;

  async function loadSettingsFromServer() {
    try {
      const res = await fetch('/api/settings');
      if (res.ok) {
        const data = await res.json();
        settingsCache = { ...settingsCache, ...data };
      }
    } catch (e) {
      // hors-ligne / erreur réseau : on garde les valeurs par défaut
    }

    zoomMode = settingsCache.zoom_mode === 'manual' ? 'manual' : 'auto';
    zoomLevel = zoomMode === 'manual'
      ? Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, parseFloat(settingsCache.zoom_value) || 1))
      : 1;

    applyRedFilter(!!settingsCache.red_filter);
  }

  async function saveSettings(updates) {
    settingsCache = { ...settingsCache, ...updates };
    try {
      await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates),
      });
    } catch (e) {
      // best effort : la valeur reste appliquée localement pour cette session
    }
  }

  function applyRedFilter(enabled) {
    document.body.classList.toggle('red-filter', enabled);
    const btn = document.getElementById('redFilterBtn');
    if (btn) btn.value = enabled ? 'Désactiver' : 'Activer';
  }

  const WEEKDAY_LABELS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
  let currentLat = null;
  let currentLon = null;
  let currentElev = 0;
  let catalogStats = null;

  const today0 = new Date();
  today0.setHours(0, 0, 0, 0);
  const agendaLastDay = new Date(today0);
  agendaLastDay.setDate(agendaLastDay.getDate() + AGENDA_DAYS - 1);
  let agendaViewMonth = new Date(today0.getFullYear(), today0.getMonth(), 1);

  function getObsMode() {
    return settingsCache.pref_mode || 'margin';
  }

  function getObsMargin() {
    const stored = settingsCache.pref_margin;
    return stored !== null && stored !== undefined ? parseInt(stored, 10) : 30;
  }

  function getFixedStart() {
    return settingsCache.pref_fixed_start || '20:00';
  }

  function getFixedEnd() {
    return settingsCache.pref_fixed_end || '06:00';
  }

  function getMinAlt() {
    const stored = settingsCache.pref_min_alt;
    return stored !== null && stored !== undefined ? parseFloat(stored) : 10;
  }

  function fmtTime(iso) {
    const d = new Date(iso);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function fmtDuration(mins) {
    const h = Math.floor(mins / 60);
    const m = Math.round(mins % 60);
    if (h <= 0) return `${m}m`;
    return `${h}h ${m}m`;
  }

  function capitalize(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

  function setStatus(msg) { statusText.textContent = msg; }

  function showError(msg) {
    statusPanel.classList.add('hidden');
    mainContent.classList.add('hidden');
    bottomNav.classList.add('hidden');
    errorPanel.classList.remove('hidden');
    errorText.textContent = msg;
  }

  function start() {
    errorPanel.classList.add('hidden');
    mainContent.classList.add('hidden');
    bottomNav.classList.add('hidden');
    statusPanel.classList.remove('hidden');
    setStatus('Requesting GPS location…');

    if (!navigator.geolocation) {
      showError('Geolocation is not supported by this browser.');
      return;
    }

    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const { latitude, longitude, altitude } = pos.coords;
        currentLat = latitude;
        currentLon = longitude;
        currentElev = altitude || 0;
        locLine.textContent = `${latitude.toFixed(3)}°, ${longitude.toFixed(3)}°`;
        setStatus('Calculating tonight\u2019s sky…');
        fetchSky(currentLat, currentLon, currentElev);
      },
      () => showError('Location access denied. Enable GPS/location permissions and try again.'),
      { enableHighAccuracy: true, timeout: 15000 }
    );
  }

  async function fetchSky(lat, lon, elev, dateStr) {
    try {
      const mode = getObsMode();
      const margin = getObsMargin();

      // Construction des dates exactes dans le fuseau local si on est en mode 'fixed'
      let dateToUse = new Date();
      if (dateStr) {
        const parts = dateStr.split('-');
        dateToUse = new Date(parts[0], parts[1] - 1, parts[2]);
      }
      
      let startFixed = new Date(dateToUse);
      const startStr = getFixedStart().split(':');
      startFixed.setHours(parseInt(startStr[0], 10), parseInt(startStr[1], 10), 0, 0);
      
      let endFixed = new Date(dateToUse);
      const endStr = getFixedEnd().split(':');
      endFixed.setHours(parseInt(endStr[0], 10), parseInt(endStr[1], 10), 0, 0);

      // Si l'heure de fin est inférieure ou égale à l'heure de début (ex: 20h -> 6h), 
      // on comprend que la fin se trouve le jour suivant.
      if (endFixed <= startFixed) {
        endFixed.setDate(endFixed.getDate() + 1);
      }

      const minAlt = getMinAlt();

      let url = `/api/sky?lat=${lat}&lon=${lon}&elev=${elev}&mode=${mode}&margin=${margin}&min_alt=${minAlt}`; // NOUVEAU (ajout de &min_alt)
      url += `&fixed_start=${startFixed.toISOString()}&fixed_end=${endFixed.toISOString()}`;
      if (dateStr) url += `&date=${dateStr}`;
      
      const res = await fetch(url);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Server error (${res.status})`);
      }
      currentData = await res.json();
      render(currentData);
    } catch (e) {
      showError(e.message || 'Could not compute sky data.');
    }
  }

  function render(data) {
    statusPanel.classList.add('hidden');
    errorPanel.classList.add('hidden');
    mainContent.classList.remove('hidden');
    bottomNav.classList.remove('hidden');

    document.getElementById('sunsetTime').textContent = fmtTime(data.sunset);
    document.getElementById('sunriseTime').textContent = fmtTime(data.sunrise);
    document.getElementById('objectCount').textContent = data.objects.length;
    document.getElementById('tlDate').textContent = new Date(data.sunset)
      .toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });

    renderTimeline(data);
    renderLegend(data);
    renderSchedule(data);
    renderAgendaCalendar();
    renderLibraryStats();

    if (nowLineTimer) clearInterval(nowLineTimer);
    positionNowLine(data);
    positionSunLines(data);
    nowLineTimer = setInterval(() => positionNowLine(data), 30000);
  }

  // Calcule le niveau de zoom qui fait tenir toute la fenêtre d'observation
  // (window_start -> window_end) exactement dans l'espace vertical libre,
  // borné entre ZOOM_MIN (50%) et ZOOM_MAX (300%).
  function computeFitZoom(data) {
    const wrap = document.getElementById('tlWrap');
    const start = new Date(data.window_start).getTime();
    const end = new Date(data.window_end).getTime();
    const totalMin = (end - start) / 60000;
    if (!totalMin || totalMin <= 0) return 1;

    const navH = bottomNav ? bottomNav.offsetHeight : 0;
    const wrapTop = wrap.getBoundingClientRect().top;
    const buffer = 20; // petite marge de sécurité
    const availableHeight = Math.max(window.innerHeight - wrapTop - navH - buffer, 100);

    const fit = (availableHeight - 20) / (totalMin * BASE_PX_PER_MIN);
    return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, fit));
  }

  function renderTimeline(data) {
    const hours = document.getElementById('tlHours');
    const lanesScroll = document.getElementById('tlLanesScroll');
    const lanes = document.getElementById('tlLanes');
    const wrap = document.getElementById('tlWrap');
    hours.innerHTML = '';
    lanes.innerHTML = '';

    if (zoomMode === 'auto') {
      zoomLevel = computeFitZoom(data);
    }
    updateZoomFitButton();

    const pxPerMin = BASE_PX_PER_MIN * zoomLevel;
    const start = new Date(data.window_start).getTime();
    const end = new Date(data.window_end).getTime();
    const totalMin = (end - start) / 60000;
    const totalPx = Math.max(totalMin * pxPerMin, 300);
    const hourPx = 60 * pxPerMin;

    hours.style.height = `${totalPx}px`;
    lanes.style.height = `${totalPx}px`;
    wrap.style.height = `${totalPx+15}px`;

    let tickMinutes = 60;
    if (hourPx >= 260) tickMinutes = 15;
    else if (hourPx >= 130) tickMinutes = 30;
    else if (hourPx < 34) tickMinutes = 120;
    lanes.style.backgroundSize = `100% ${tickMinutes * pxPerMin}px`;

    const firstTick = new Date(start);
    const rem = firstTick.getMinutes() % tickMinutes;
    firstTick.setSeconds(0, 0);
    if (rem !== 0) firstTick.setMinutes(firstTick.getMinutes() + (tickMinutes - rem));
    else if (firstTick.getTime() < start) firstTick.setMinutes(firstTick.getMinutes() + tickMinutes);

    for (let t = firstTick.getTime(); t <= end; t += tickMinutes * 60000) {
      const topPx = ((t - start) / 60000) * pxPerMin;
      const label = document.createElement('div');
      label.className = 'tl-hour-label';
      if (tickMinutes < 60 && new Date(t).getMinutes() !== 0) label.classList.add('tl-hour-label-minor');
      label.style.top = `${topPx}px`;
      label.textContent = new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      hours.appendChild(label);
    }

    const laneCount = Math.max(data.lane_count || 1, 1);
    const availableWidth = lanesScroll.clientWidth || 300;
    const laneWidth = availableWidth / laneCount;
    const narrow = laneWidth < 64;

    for (let i = 0; i < laneCount; i++) {
      const col = document.createElement('div');
      col.className = 'lane-col';
      col.style.left = `${i * laneWidth}px`;
      col.style.width = `${laneWidth}px`;
      lanes.appendChild(col);
    }

    data.objects.forEach((o) => {
      const rise = new Date(o.rise_iso).getTime();
      const set = new Date(o.set_iso).getTime();
      const topPx = ((rise - start) / 60000) * pxPerMin;
      const heightPx = Math.max(((set - rise) / 60000) * pxPerMin, 22);

      const block = document.createElement('div');
      block.className = 'block' + (narrow ? ' block-narrow' : '');
      block.style.top = `${topPx}px`;
      block.style.height = `${heightPx}px`;
      block.style.left = `${o.lane * laneWidth + 2}px`;
      block.style.width = `${Math.max(laneWidth - 4, 4)}px`;
      block.style.background = o.color;

      const magStr = (o.magnitude !== null && o.magnitude !== undefined) ? `mag ${o.magnitude}` : '';
      const subLine = narrow ? '' : `<span class="b-sub">${o.peak_altitude}° ${magStr}</span>`;
      block.innerHTML = `<span class="b-name">${o.name}</span>${subLine}`;
      block.title = `${o.name} — ${fmtTime(o.rise_iso)}\u2013${fmtTime(o.set_iso)}, alt ${o.peak_altitude}°${magStr ? ', ' + magStr : ''}`;
      block.addEventListener('click', () => openInfo(o));

      lanes.appendChild(block);
    });

    document.getElementById('zoomPct').textContent = `${Math.round(zoomLevel * 100)}%`;
  }

  // Point d'ancrage exprimé en position à l'écran (viewport), pas en position
  // dans le document : c'est ce qui évite le bug de recentrage, qui venait du
  // mélange de coordonnées (window.scrollY, relatif au document) avec
  // wrap.offsetTop (relatif à l'offsetParent, pas toujours le document).
  const ANCHOR_VIEWPORT_OFFSET = 90; // px depuis le haut du viewport

  function currentTopAnchorMs(data) {
    const wrap = document.getElementById('tlWrap');
    const pxPerMin = BASE_PX_PER_MIN * zoomLevel;
    const start = new Date(data.window_start).getTime();
    const wrapTop = wrap.getBoundingClientRect().top;
    const scrollOffset = ANCHOR_VIEWPORT_OFFSET - wrapTop;
    return start + (scrollOffset / pxPerMin) * 60000;
  }

  function applyScrollForAnchor(data, anchorTimeMs) {
    const wrap = document.getElementById('tlWrap');
    const pxPerMin = BASE_PX_PER_MIN * zoomLevel;
    const start = new Date(data.window_start).getTime();
    const topOffset = ((anchorTimeMs - start) / 60000) * pxPerMin;
    const wrapDocTop = wrap.getBoundingClientRect().top + window.scrollY;
    const targetScroll = Math.max(wrapDocTop + topOffset - ANCHOR_VIEWPORT_OFFSET, 0);
    window.scrollTo({ top: targetScroll, behavior: 'auto' });
  }

  function setZoom(newZoom) {
    if (!currentData) return;
    zoomMode = 'manual';
    const anchor = currentTopAnchorMs(currentData);
    zoomLevel = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, newZoom));
    saveSettings({ zoom_mode: 'manual', zoom_value: zoomLevel });
    renderTimeline(currentData); // le scroll est réappliqué nous-mêmes ci-dessous
    positionNowLine(currentData);
    positionSunLines(currentData);
    // On réapplique le scroll après le prochain repaint : ça évite qu'un
    // ajustement de scroll automatique du navigateur (ex: focus du bouton
    // tapé) n'écrase notre position et ne recentre la page.
    requestAnimationFrame(() => {
      applyScrollForAnchor(currentData, anchor);
      requestAnimationFrame(() => applyScrollForAnchor(currentData, anchor));
    });
  }

  function resetZoomToFit() {
    if (!currentData) return;
    zoomMode = 'auto';
    saveSettings({ zoom_mode: 'auto' }); // on ne stocke jamais la valeur calculée de l'auto
    renderTimeline(currentData); // renderTimeline recalcule zoomLevel car zoomMode === 'auto'
    positionNowLine(currentData);
    positionSunLines(currentData);
    requestAnimationFrame(() => window.scrollTo({ top: window.scrollY, behavior: 'auto' }));
  }

  function updateZoomFitButton() {
    const btn = document.getElementById('zoomFit');
    if (btn) btn.classList.toggle('active', zoomMode === 'auto');
  }

  document.getElementById('zoomIn').addEventListener('click', (e) => {
    e.currentTarget.blur();
    setZoom(zoomLevel + ZOOM_STEP);
  });
  document.getElementById('zoomOut').addEventListener('click', (e) => {
    e.currentTarget.blur();
    setZoom(zoomLevel - ZOOM_STEP);
  });
  document.getElementById('zoomFit').addEventListener('click', (e) => {
    e.currentTarget.blur();
    resetZoomToFit();
  });

  // Si on est en mode "fit", on recalcule le zoom quand la fenêtre change de
  // taille (rotation d'écran, redimensionnement) pour que ça continue à bien
  // remplir l'espace disponible.
  let resizeTimer = null;
  window.addEventListener('resize', () => {
    if (zoomMode !== 'auto' || !currentData) return;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      renderTimeline(currentData);
      positionNowLine(currentData);
      positionSunLines(currentData);
    }, 150);
  });

  let pinchStartDist = null;
  let pinchStartZoom = 1;
  const tlWrapEl_forPinch = () => document.getElementById('tlWrap');
  document.addEventListener('touchstart', (e) => {
    if (e.touches.length === 2 && tlWrapEl_forPinch().contains(e.target)) {
      pinchStartDist = Math.abs(e.touches[0].clientY - e.touches[1].clientY);
      pinchStartZoom = zoomLevel;
    }
  }, { passive: true });
  document.addEventListener('touchmove', (e) => {
    if (e.touches.length === 2 && pinchStartDist) {
      const dist = Math.abs(e.touches[0].clientY - e.touches[1].clientY);
      const ratio = dist / pinchStartDist;
      setZoom(pinchStartZoom * ratio);
    }
  }, { passive: true });
  document.addEventListener('touchend', (e) => {
    if (e.touches.length < 2) pinchStartDist = null;
  }, { passive: true });

  function positionNowLine(data) {
    const nowLine = document.getElementById('nowLine');
    const start = new Date(data.window_start).getTime();
    const end = new Date(data.window_end).getTime();
    const now = Date.now();
    if (now < start || now > end) {
      nowLine.style.display = 'none';
      return;
    }
    nowLine.style.display = 'block';
    const pxPerMin = BASE_PX_PER_MIN * zoomLevel;
    const topPx = ((now - start) / 60000) * pxPerMin;
    nowLine.style.top = `${topPx}px`;
  }

  function positionSunLines(data) {
    const sunsetLine = document.getElementById('sunsetLine');
    const sunriseLine = document.getElementById('sunriseLine');
    const pxPerMin = BASE_PX_PER_MIN * zoomLevel;
    const start = new Date(data.window_start).getTime();
    const end = new Date(data.window_end).getTime();
    const sunset = new Date(data.sunset).getTime();
    const sunrise = new Date(data.sunrise).getTime();

    [
      [sunsetLine, sunset],
      [sunriseLine, sunrise],
    ].forEach(([el, t]) => {
      if (t < start || t > end) {
        el.style.display = 'none';
        return;
      }
      el.style.display = 'block';
      el.style.top = `${((t - start) / 60000) * pxPerMin}px`;
    });
  }

  function renderLegend(data) {
    const legend = document.getElementById('legend');
    legend.innerHTML = '';
    const seen = new Map();
    data.objects.forEach((o) => { if (!seen.has(o.category)) seen.set(o.category, o.color); });
    seen.forEach((color, category) => {
      const item = document.createElement('div');
      item.className = 'legend-item';
      item.innerHTML = `<span class="legend-dot" style="background:${color}"></span>${capitalize(category)}`;
      legend.appendChild(item);
    });
  }

  function renderSchedule(data) {
    const body = document.getElementById('scheduleBody');
    body.innerHTML = '';
    data.objects.forEach((o) => {
      const row = document.createElement('div');
      row.className = 'schedule-row schedule-row-clickable';
      const magStr = (o.magnitude !== null && o.magnitude !== undefined) ? `mag ${o.magnitude}` : '—';
      row.innerHTML = `
        <span class="obj-name">
          <span class="obj-dot" style="background:${o.color}"></span>
          <span>${o.name}<span class="obj-type">${capitalize(o.category)}</span></span>
        </span>
        <span>${fmtTime(o.rise_iso)}</span>
        <span>${fmtTime(o.set_iso)}</span>
        <span>${fmtDuration(o.duration_min)}</span>
        <span>${o.peak_altitude}° / ${magStr}</span>
      `;
      row.addEventListener('click', () => openInfo(o));
      body.appendChild(row);
    });
  }

  function openInfo(o) {
    document.getElementById('infoDot').style.background = o.color;
    document.getElementById('infoDot').style.color = o.color;
    document.getElementById('infoName').textContent = o.name;
    document.getElementById('infoCategory').textContent = capitalize(o.category);
    document.getElementById('infoRise').textContent = fmtTime(o.rise_iso);
    document.getElementById('infoSet').textContent = fmtTime(o.set_iso);
    document.getElementById('infoDuration').textContent = fmtDuration(o.duration_min);
    document.getElementById('infoAlt').textContent = `${o.peak_altitude}°`;
    document.getElementById('infoMag').textContent = (o.magnitude !== null && o.magnitude !== undefined)
      ? `mag ${o.magnitude}` : 'n/a';
    document.getElementById('infoOverlay').classList.remove('hidden');
  }

  function closeInfo() {
    document.getElementById('infoOverlay').classList.add('hidden');
  }

  document.getElementById('infoClose').addEventListener('click', closeInfo);
  document.getElementById('infoOverlay').addEventListener('click', (e) => {
    if (e.target.id === 'infoOverlay') closeInfo();
  });

  function switchView(name) {
    document.querySelectorAll('.view').forEach((v) => v.classList.add('hidden'));
    document.getElementById(`view-${name}`).classList.remove('hidden');
    document.querySelectorAll('.nav-btn').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
    if (name === 'timeline' && currentData) {
      renderTimeline(currentData);
      positionNowLine(currentData);
    }
    if (name !== 'tools') {
      stopActiveTool();
    }
  }

  document.querySelectorAll('.nav-btn').forEach((btn) => {
    btn.addEventListener('click', () => switchView(btn.dataset.view));
  });

  refreshBtn.addEventListener('click', start);
  retryBtn.addEventListener('click', start);

  function toDateStr(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  function renderAgendaWeekdays() {
    const weekdays = document.getElementById('agendaWeekdays');
    if (weekdays.childElementCount) return;
    weekdays.innerHTML = WEEKDAY_LABELS.map((w) => `<span>${w}</span>`).join('');
  }

  function renderAgendaCalendar() {
    renderAgendaWeekdays();

    const grid = document.getElementById('agendaGrid');
    const label = document.getElementById('agendaMonthLabel');
    grid.innerHTML = '';
    label.textContent = agendaViewMonth.toLocaleDateString([], { month: 'long', year: 'numeric' });

    const monthStart = new Date(agendaViewMonth);
    const firstWeekday = monthStart.getDay();
    const gridStart = new Date(monthStart);
    gridStart.setDate(gridStart.getDate() - firstWeekday);

    for (let i = 0; i < 42; i++) {
      const d = new Date(gridStart);
      d.setDate(d.getDate() + i);
      const dateStr = toDateStr(d);

      const inMonth = d.getMonth() === monthStart.getMonth();
      const inRange = d >= today0 && d <= agendaLastDay;
      const isToday = d.getTime() === today0.getTime();

      const cell = document.createElement('button');
      cell.type = 'button';
      cell.className = 'cal-day';
      if (!inMonth) cell.classList.add('cal-day-outside');
      if (isToday) cell.classList.add('cal-day-today');
      if (inRange) cell.classList.add('cal-day-selectable');
      else cell.disabled = true;

      cell.innerHTML = `<span class="cal-day-num">${d.getDate()}</span>${inRange ? '<span class="cal-day-dot"></span>' : ''}`;
      if (inRange) cell.addEventListener('click', () => openAgendaDay(dateStr, d));
      grid.appendChild(cell);
    }

    document.getElementById('agendaPrevMonth').disabled =
      agendaViewMonth.getFullYear() === today0.getFullYear() &&
      agendaViewMonth.getMonth() === today0.getMonth();
  }

  document.getElementById('agendaPrevMonth').addEventListener('click', () => {
    agendaViewMonth = new Date(agendaViewMonth.getFullYear(), agendaViewMonth.getMonth() - 1, 1);
    renderAgendaCalendar();
  });
  document.getElementById('agendaNextMonth').addEventListener('click', () => {
    agendaViewMonth = new Date(agendaViewMonth.getFullYear(), agendaViewMonth.getMonth() + 1, 1);
    renderAgendaCalendar();
  });

  function openAgendaDay(dateStr, dateObj) {
    if (currentLat === null || currentLon === null) return;
    errorPanel.classList.add('hidden');
    mainContent.classList.add('hidden');
    bottomNav.classList.add('hidden');
    statusPanel.classList.remove('hidden');
    setStatus(`Calculating sky for ${dateObj.toLocaleDateString([], { month: 'short', day: 'numeric' })}…`);
    fetchSky(currentLat, currentLon, currentElev, dateStr).then(() => switchView('timeline'));
  }

  // ---------- Settings: On/off toggles (persistés en base côté serveur) ----------
  const modeFixedRadio = document.getElementById('modeFixed');
  const modeMarginRadio = document.getElementById('modeMargin');
  const marginInput = document.getElementById('marginInput');
  const fixedStartInput = document.getElementById('fixedStartInput');
  const fixedEndInput = document.getElementById('fixedEndInput');
  const minAltInput = document.querySelector('input[name="elev"]'); // NOUVEAU
  const redFilterBtn = document.getElementById('redFilterBtn');

  function loadPreferences() {
    const mode = getObsMode();
    if (mode === 'fixed') {
      modeFixedRadio.checked = true;
      marginInput.disabled = true;
      fixedStartInput.disabled = false;
      fixedEndInput.disabled = false;
    } else {
      modeMarginRadio.checked = true;
      marginInput.disabled = false;
      fixedStartInput.disabled = true;
      fixedEndInput.disabled = true;
    }
    marginInput.value = getObsMargin();
    fixedStartInput.value = getFixedStart();
    fixedEndInput.value = getFixedEnd();

    if (minAltInput) {
      minAltInput.value = getMinAlt();
    }
  }

  function savePreferences() {
    const mode = modeFixedRadio.checked ? 'fixed' : 'margin';
    let margin = parseInt(marginInput.value, 10);
    if (isNaN(margin) || margin < 0) margin = 0;
    
    // Si l'utilisateur efface tout, on fallback sur les valeurs par défaut
    const startVal = fixedStartInput.value || '20:00';
    let endVal = fixedEndInput.value || '06:00';

    const updates = {
      pref_mode: mode,
      pref_margin: margin,
      pref_fixed_start: startVal,
      pref_fixed_end: endVal,
    };

    marginInput.disabled = (mode === 'fixed');
    fixedStartInput.disabled = (mode !== 'fixed');
    fixedEndInput.disabled = (mode !== 'fixed');

    if (minAltInput) {
      let minAltVal = parseFloat(minAltInput.value);
      if (isNaN(minAltVal) || minAltVal < 0) minAltVal = 0;
      if (minAltVal > 90) minAltVal = 90;
      updates.pref_min_alt = minAltVal;
    }

    saveSettings(updates);

    if (currentLat !== null && currentLon !== null) {
      const dateStr = currentData && currentData.requested_date ? currentData.requested_date : undefined;
      fetchSky(currentLat, currentLon, currentElev, dateStr);
    }
  }

  modeFixedRadio.addEventListener('change', savePreferences);
  modeMarginRadio.addEventListener('change', savePreferences);
  marginInput.addEventListener('change', savePreferences);
  fixedStartInput.addEventListener('change', savePreferences);
  fixedEndInput.addEventListener('change', savePreferences);
  minAltInput.addEventListener('change', savePreferences);

  if (redFilterBtn) {
    redFilterBtn.addEventListener('click', () => {
      const enabled = !document.body.classList.contains('red-filter');
      applyRedFilter(enabled);
      saveSettings({ red_filter: enabled });
    });
  }

  // ---------- Overview: library stats ----------
  async function fetchCatalogStatsOnce() {
    if (catalogStats) return catalogStats;
    try {
      const res = await fetch('/api/catalog/stats');
      if (!res.ok) return null;
      catalogStats = await res.json();
      return catalogStats;
    } catch (e) {
      return null;
    }
  }

  async function renderLibraryStats() {
    const stats = await fetchCatalogStatsOnce();
    if (!stats) return;

    document.getElementById('statTotal').textContent = stats.total;
    document.getElementById('statStars').textContent = stats.counts.star || 0;
    document.getElementById('statPlanets').textContent = stats.counts.planet || 0;
    document.getElementById('statDeepSky').textContent = stats.deep_sky_total;

    const breakdown = document.getElementById('libraryBreakdown');
    const deepKinds = ['galaxy', 'nebula', 'cluster'];
    breakdown.innerHTML = deepKinds
      .filter((k) => stats.counts[k])
      .map((k) => `
        <div class="breakdown-row">
          <span class="breakdown-label">${capitalize(k)}</span>
          <span class="breakdown-value">${stats.counts[k]}</span>
        </div>
      `).join('');
  }

  // ========================================================================
  // ---------- Tools: Compass / Level / Polar Clock ----------
  // ========================================================================

  const toolCards = document.querySelectorAll('.tool-card');
  const toolPanel = document.getElementById('toolPanel');
  const toolPanelTitle = document.getElementById('toolPanelTitle');
  const toolPanelClose = document.getElementById('toolPanelClose');
  const toolBodies = {
    compass: document.getElementById('toolCompass'),
    level: document.getElementById('toolLevel'),
    polar: document.getElementById('toolPolar'),
  };
  const TOOL_TITLES = { compass: 'Compass', level: 'Level', polar: 'Polar Clock' };

  let activeTool = null;
  let polarTimer = null;
  let orientationHandler = null;
  let motionLevelHandler = null;

  async function requestOrientationPermission() {
    if (typeof DeviceOrientationEvent !== 'undefined' &&
        typeof DeviceOrientationEvent.requestPermission === 'function') {
      try {
        const res = await DeviceOrientationEvent.requestPermission();
        return res === 'granted';
      } catch (e) {
        return false;
      }
    }
    return true; // Android / desktop: no explicit permission gate
  }

  function stopActiveTool() {
    if (orientationHandler) {
      window.removeEventListener('deviceorientation', orientationHandler);
      window.removeEventListener('deviceorientationabsolute', orientationHandler); // AJOUT
      orientationHandler = null;
    }
    if (motionLevelHandler) {
      window.removeEventListener('deviceorientation', motionLevelHandler);
      motionLevelHandler = null;
    }
    if (polarTimer) {
      clearInterval(polarTimer);
      polarTimer = null;
    }
    activeTool = null;
    toolPanel.classList.add('hidden');
    Object.values(toolBodies).forEach((el) => el.classList.add('hidden'));
    toolCards.forEach((c) => c.classList.remove('active'));
  }

  async function openTool(name) {
    if (activeTool === name) {
      stopActiveTool();
      return;
    }
    stopActiveTool();
    activeTool = name;
    toolPanel.classList.remove('hidden');
    toolPanelTitle.textContent = TOOL_TITLES[name];
    toolBodies[name].classList.remove('hidden');
    toolCards.forEach((c) => c.classList.toggle('active', c.dataset.tool === name));

    if (name === 'compass') startCompass();
    else if (name === 'level') startLevel();
    else if (name === 'polar') startPolarClock();

    toolPanel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  toolCards.forEach((card) => {
    card.addEventListener('click', () => openTool(card.dataset.tool));
  });
  toolPanelClose.addEventListener('click', stopActiveTool);

  // ---- Compass ----
  let compassSmoothedRotation = null; // rotation continue (non modulo) appliquée au cadran
  let compassUsingAbsolute = false;

  function shortestDeltaDeg(from, to) {
    // Plus petit delta signé pour aller de `from` à `to`, dans (-180, 180]
    let d = (to - from) % 360;
    if (d > 180) d -= 360;
    if (d < -180) d += 360;
    return d;
  }

  function headingLabel(heading) {
    const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
    const idx = Math.round(heading / 45) % 8;
    return dirs[idx];
  }

  function handleCompassHeading(heading) {
    const dial = document.getElementById('compassDial');
    const readout = document.getElementById('compassHeading');
    if (heading === null || isNaN(heading)) return;
    heading = ((heading % 360) + 360) % 360;

    const targetRotation = -heading;
    if (compassSmoothedRotation === null) {
      compassSmoothedRotation = targetRotation;
    } else {
      // On avance par le plus court chemin au lieu de sauter à targetRotation,
      // ce qui causait le "tour dans l'autre sens" près de 359°/0°.
      const delta = shortestDeltaDeg(compassSmoothedRotation, targetRotation);
      compassSmoothedRotation += delta;
    }

    dial.style.transform = `rotate(${compassSmoothedRotation}deg)`;
    readout.textContent = `${Math.round(heading)}° ${headingLabel(heading)}`;
  }

  async function startCompass() {
    const hint = document.getElementById('compassHint');

    if (typeof DeviceOrientationEvent === 'undefined') {
      hint.textContent = 'Orientation sensors are not supported on this device.';
      return;
    }

    const granted = await requestOrientationPermission();
    if (!granted) {
      hint.textContent = 'Sensor access was denied. Enable motion & orientation access in your browser settings.';
      return;
    }
    hint.textContent = 'Hold the phone flat, screen up.';
    compassSmoothedRotation = null;
    compassUsingAbsolute = false;

    orientationHandler = (e) => {
      // iOS: webkitCompassHeading est déjà un cap vrai/magnétique, CW depuis le Nord.
      if (typeof e.webkitCompassHeading === 'number') {
        handleCompassHeading(e.webkitCompassHeading);
        return;
      }

      // Android/autres via 'deviceorientation' classique : e.alpha n'est un vrai
      // cap "nord" QUE si le navigateur marque l'event comme absolute.
      // Sinon c'est relatif à l'orientation du téléphone au chargement de la page
      // — c'est exactement pour ça que ton "nord" était faux.
      if (e.absolute === true && e.alpha !== null) {
        compassUsingAbsolute = true;
        handleCompassHeading(360 - e.alpha);
      } else if (!compassUsingAbsolute && e.alpha !== null) {
        hint.textContent = 'Cap approximatif uniquement — cet appareil/navigateur n\u2019expose pas le vrai nord.';
        handleCompassHeading(360 - e.alpha);
      }
    };

    // On privilégie l'event "absolute" quand le navigateur le supporte
    // (donne un vrai cap magnétique sur Android/Chrome).
    window.addEventListener('deviceorientationabsolute', orientationHandler);
    window.addEventListener('deviceorientation', orientationHandler);
  }

  // ---- Level ----
  let levelMode = 'flat'; // 'flat' | 'edge-short' | 'edge-long'

  // Renvoie l'angle d'orientation de l'écran (0/90/180/270), tous navigateurs.
  // Utilisé uniquement pour lever l'ambiguïté gauche/droite en mode "côté long"
  // (paysage posé sur l'oreille gauche vs droite) — pas pour choisir court/long,
  // qui est un choix explicite de l'utilisateur (boutons Short edge / Long edge).
  function getScreenOrientationAngle() {
    if (screen.orientation && typeof screen.orientation.angle === 'number') {
      return screen.orientation.angle;
    }
    if (typeof window.orientation === 'number') {
      return ((window.orientation % 360) + 360) % 360;
    }
    return 0;
  }

  // Convertit beta/gamma (repère capteur) en front/side (repère utilisateur),
  // selon le mode choisi explicitement.
  //  - edge-short : téléphone debout en portrait, posé sur la tranche courte
  //                 (bord bas), on vise avec le bord haut.
  //  - edge-long  : téléphone debout en paysage, posé sur la tranche longue.
  function getEdgeTilt(mode, beta, gamma) {
    if (mode === 'edge-short') {
      // Portrait : gère aussi le cas "tête en bas" (angle 180).
      const angle = getScreenOrientationAngle();
      return angle === 180 ? { front: -beta, side: -gamma } : { front: beta, side: gamma };
    }
    // edge-long : paysage, posé sur la tranche longue. On garde le choix
    // "long" fait par l'utilisateur, l'angle sert juste à choisir le bon signe
    // selon que le tél est tourné vers la gauche (90°) ou la droite (270°).
    const angle = getScreenOrientationAngle();
    return angle === 270 ? { front: gamma, side: -beta } : { front: -gamma, side: beta };
  }

  function edgeOrientationLabel(mode) {
    return mode === 'edge-long'
      ? 'Landscape · resting on long edge'
      : 'Portrait · resting on short edge';
  }

  function setLevelMode(mode) {
    levelMode = mode;
    document.querySelectorAll('.level-mode-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.levelMode === mode);
    });
    document.getElementById('levelFlatFace').classList.toggle('hidden', mode !== 'flat');
    document.getElementById('levelEdgeFace').classList.toggle('hidden', mode === 'flat');
    document.getElementById('levelHint').textContent = mode === 'flat'
      ? 'Lay the phone flat, screen up.'
      : mode === 'edge-short'
        ? 'Stand the phone up in portrait, resting on its short (bottom) edge, and point the top at the sky.'
        : 'Stand the phone up in landscape, resting on its long edge, and point the top at the sky.';
  }

  document.querySelectorAll('.level-mode-btn').forEach((btn) => {
    btn.addEventListener('click', () => setLevelMode(btn.dataset.levelMode));
  });

  async function startLevel() {
    const hint = document.getElementById('levelHint');
    const bubble = document.getElementById('levelBubble');
    const tubeBubble = document.getElementById('levelTubeBubble');
    const edgeOrientationEl = document.getElementById('levelEdgeOrientation');
    const readout = document.getElementById('levelReadout');

    if (typeof DeviceOrientationEvent === 'undefined') {
      hint.textContent = 'Tilt sensors are not supported on this device.';
      return;
    }
    const granted = await requestOrientationPermission();
    if (!granted) {
      hint.textContent = 'Sensor access was denied. Enable motion & orientation access in your browser settings.';
      return;
    }

    setLevelMode(levelMode);

    const maxOffset = 90;      // px, mode plat: déplacement max de la bulle depuis le centre
    const tubeMaxOffset = 82;  // px, mode tranche: déplacement max le long du tube
    const okTolerance = 1.5;   // degrés

    motionLevelHandler = (e) => {
      const rawBeta = e.beta || 0;   // -180..180
      const rawGamma = e.gamma || 0; // -90..90

      if (levelMode === 'flat') {
        const clampedBeta = Math.max(-45, Math.min(45, rawBeta));
        const clampedGamma = Math.max(-45, Math.min(45, rawGamma));

        const x = (clampedGamma / 45) * maxOffset;
        const y = (clampedBeta / 45) * maxOffset;

        bubble.style.transform = `translate(calc(-50% + ${x}px), calc(-50% + ${y}px))`;

        const isFlat = Math.abs(rawBeta) < okTolerance && Math.abs(rawGamma) < okTolerance;
        bubble.classList.toggle('level-ok', isFlat);

        readout.textContent = `${rawBeta.toFixed(1)}° / ${rawGamma.toFixed(1)}°`;
        return;
      }

      // Mode tranche (edge / niveau de côté), choisi explicitement par
      // l'utilisateur : court (portrait) ou long (paysage). `front` =
      // inclinaison avant/arrière depuis la verticale (0° = parfaitement
      // vertical) ; `side` = roulis gauche/droite (0° = à plomb).
      const { front, side } = getEdgeTilt(levelMode, rawBeta, rawGamma);
      const tiltFromVertical = Math.abs(front) - 90; // 0° quand le tél est vertical

      const clampedSide = Math.max(-45, Math.min(45, side));
      const x = (clampedSide / 45) * tubeMaxOffset;
      tubeBubble.style.transform = `translate(calc(-50% + ${x}px), -50%)`;

      const isPlumb = Math.abs(side) < okTolerance;
      tubeBubble.classList.toggle('level-ok', isPlumb);

      edgeOrientationEl.textContent = edgeOrientationLabel(levelMode);
      readout.textContent = `${tiltFromVertical.toFixed(1)}° from vertical / ${side.toFixed(1)}° roll`;
    };
    window.addEventListener('deviceorientation', motionLevelHandler);
  }

  // ---- Polar Clock (hour-angle position of Polaris around NCP) ----
  // Polaris (α UMi) approx J2000: RA = 2h 31.8m, Dec = +89.26°
  const POLARIS_RA_HOURS = 2.5303;

  function computeGMSTHours(date) {
    // Standard low-precision GMST formula (hours)
    const JD = date.getTime() / 86400000 + 2440587.5;
    const T = (JD - 2451545.0) / 36525;
    let gmst = 280.46061837 + 360.98564736629 * (JD - 2451545.0)
      + 0.000387933 * T * T - (T * T * T) / 38710000;
    gmst = ((gmst % 360) + 360) % 360;
    return gmst / 15; // hours
  }

  function drawPolarClock() {
    const svg = document.getElementById('polarClockSvg');
    const readout = document.getElementById('polarReadout');
    const lon = currentLon !== null ? currentLon : 0;

    const gmstHours = computeGMSTHours(new Date());
    const lstHours = ((gmstHours + lon / 15) % 24 + 24) % 24;
    let hourAngle = lstHours - POLARIS_RA_HOURS; // hours
    hourAngle = ((hourAngle % 24) + 24) % 24;
    const angleDeg = hourAngle * 15; // 0..360, 0 = Polaris due "up" from pole at HA=0

    // Convention: HA=0 -> Polaris at top (12 o'clock) as seen looking at the pole,
    // increasing HA rotates clockwise.
    const cx = 100, cy = 100, r = 82;
    const rad = (angleDeg - 90) * Math.PI / 180;
    const px = cx + r * Math.cos(rad);
    const py = cy + r * Math.sin(rad);

    let svgMarkup = `
      <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="var(--hairline)" stroke-width="1"/>
    `;

    // Graduations : petites toutes les heures, moyennes tous les 3h, grandes tous les 6h
    for (let h = 0; h < 24; h++) {
      const a = (h * 15 - 90) * Math.PI / 180;
      const isMajor = h % 6 === 0;
      const isMedium = !isMajor && h % 2 === 0; // tiers du secteur de 6h : 2h, 4h, 8h, 10h...
      const tickLen = isMajor ? 10 : (isMedium ? 7 : 4);
      const tickWidth = isMajor ? 1.6 : (isMedium ? 1.2 : 0.8);
      const x1 = cx + r * Math.cos(a);
      const y1 = cy + r * Math.sin(a);
      const x2 = cx + (r - tickLen) * Math.cos(a);
      const y2 = cy + (r - tickLen) * Math.sin(a);
      const tickColor = isMajor ? 'var(--accent)' : 'var(--text-muted)';
      const tickOpacity = isMajor ? '0.9' : (isMedium ? '0.6' : '0.35');
      svgMarkup += `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${tickColor}" stroke-width="${tickWidth}" opacity="${tickOpacity}"/>`;
    }

    svgMarkup += `
      <circle cx="${cx}" cy="${cy}" r="3" fill="var(--accent)"/>
      <line x1="${cx}" y1="${cy}" x2="${px}" y2="${py}" stroke="var(--accent)" stroke-width="1.5"/>
      <circle cx="${px}" cy="${py}" r="5" fill="var(--accent)" style="filter: drop-shadow(0 0 4px rgba(212,175,106,0.8));"/>
    `;
    ['0','6','12','18'].forEach((h) => {
      const a = (Number(h) * 15 - 90) * Math.PI / 180;
      const lx = cx + (r + 12) * Math.cos(a);
      const ly = cy + (r + 12) * Math.sin(a);
      svgMarkup += `<text x="${lx}" y="${ly}" fill="var(--text-muted)" font-size="9" font-family="var(--font-mono)" text-anchor="middle" dominant-baseline="middle">${h}h</text>`;
    });
    svg.innerHTML = svgMarkup;

    readout.textContent = `HA ${hourAngle.toFixed(2)}h · LST ${lstHours.toFixed(2)}h`;
  }

  function startPolarClock() {
    drawPolarClock();
    polarTimer = setInterval(drawPolarClock, 15000);
  }

  async function initApp() {
    await loadSettingsFromServer();
    loadPreferences();
    start();
  }
  initApp();
})();