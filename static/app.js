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
  let zoomLevel = 0.5;

  let currentData = null;
  let nowLineTimer = null;

  const AGENDA_DAYS = 30;
  
  // Nouveaux paramètres 
  const PREF_MODE_KEY = 'skyme_pref_mode'; // 'fixed' ou 'margin'
  const PREF_MARGIN_VAL_KEY = 'skyme_pref_margin_val'; // int (défaut: 30)
  const PREF_FIXED_START_KEY = 'skyme_pref_fixed_start'; // NOUVEAU
  const PREF_FIXED_END_KEY = 'skyme_pref_fixed_end';     // NOUVEAU
  const PREF_MIN_ALT_KEY = 'skyme_pref_min_alt';

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
    return localStorage.getItem(PREF_MODE_KEY) || 'margin';
  }

  function getObsMargin() {
    const stored = localStorage.getItem(PREF_MARGIN_VAL_KEY);
    return stored !== null ? parseInt(stored, 10) : 30;
  }

  function getFixedStart() {
    return localStorage.getItem(PREF_FIXED_START_KEY) || '20:00';
  }

  function getFixedEnd() {
    return localStorage.getItem(PREF_FIXED_END_KEY) || '06:00';
  }

  function getMinAlt() {
    const stored = localStorage.getItem(PREF_MIN_ALT_KEY);
    return stored !== null ? parseFloat(stored) : 10;
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

  function renderTimeline(data, anchorTimeMs) {
    const hours = document.getElementById('tlHours');
    const lanesScroll = document.getElementById('tlLanesScroll');
    const lanes = document.getElementById('tlLanes');
    const wrap = document.getElementById('tlWrap');
    hours.innerHTML = '';
    lanes.innerHTML = '';

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

    if (typeof anchorTimeMs === 'number') {
      const scroller = document.querySelector('.view#view-timeline');
      const topOffset = ((anchorTimeMs - start) / 60000) * pxPerMin;
      window.scrollTo({ top: wrap.offsetTop + topOffset - 90, behavior: 'auto' });
    }

    document.getElementById('zoomPct').textContent = `${Math.round(zoomLevel * 100)}%`;
  }

  function currentTopAnchorMs(data) {
    const wrap = document.getElementById('tlWrap');
    const pxPerMin = BASE_PX_PER_MIN * zoomLevel;
    const start = new Date(data.window_start).getTime();
    const scrollOffset = window.scrollY - wrap.offsetTop + 90;
    return start + Math.max(scrollOffset, 0) / pxPerMin * 60000;
  }

  function setZoom(newZoom) {
    if (!currentData) return;
    const anchor = currentTopAnchorMs(currentData);
    zoomLevel = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, newZoom));
    renderTimeline(currentData, anchor);
    positionNowLine(currentData);
    positionSunLines(currentData);
  }

  document.getElementById('zoomIn').addEventListener('click', () => setZoom(zoomLevel + ZOOM_STEP));
  document.getElementById('zoomOut').addEventListener('click', () => setZoom(zoomLevel - ZOOM_STEP));

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

  // ---------- Settings: On/off toggles (localStorage) ----------
  const modeFixedRadio = document.getElementById('modeFixed');
  const modeMarginRadio = document.getElementById('modeMargin');
  const marginInput = document.getElementById('marginInput');
  const fixedStartInput = document.getElementById('fixedStartInput');
  const fixedEndInput = document.getElementById('fixedEndInput');
  const minAltInput = document.querySelector('input[name="elev"]'); // NOUVEAU

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
    const endVal = fixedEndInput.value || '06:00';
    
    localStorage.setItem(PREF_MODE_KEY, mode);
    localStorage.setItem(PREF_MARGIN_VAL_KEY, margin.toString());
    localStorage.setItem(PREF_FIXED_START_KEY, startVal);
    localStorage.setItem(PREF_FIXED_END_KEY, endVal);
    
    marginInput.disabled = (mode === 'fixed');
    fixedStartInput.disabled = (mode !== 'fixed');
    fixedEndInput.disabled = (mode !== 'fixed');

    if (minAltInput) {
      let minAltVal = parseFloat(minAltInput.value);
      if (isNaN(minAltVal) || minAltVal < 0) minAltVal = 0;
      if (minAltVal > 90) minAltVal = 90;
      localStorage.setItem(PREF_MIN_ALT_KEY, minAltVal.toString());
    }

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
  
  if (minAltInput) {
      minAltInput.addEventListener('change', savePreferences);
  }

  loadPreferences();

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

  start();
})();