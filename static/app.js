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
  let zoomLevel = 1;

  let currentData = null;
  let nowLineTimer = null;

  const AGENDA_DAYS = 30;
  const PREF_START_KEY = 'skyme_pref_start';
  const PREF_END_KEY = 'skyme_pref_end';
  let currentLat = null;
  let currentLon = null;
  let currentElev = 0;
  let agendaBuilt = false;

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
      let url = `/api/sky?lat=${lat}&lon=${lon}&elev=${elev}`;
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
    buildAgendaList();

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
    wrap.style.height = `${totalPx}px`;

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

  // vertical pinch-to-zoom (two-finger)
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
      // re-measure lane width now that the view is visible again
      renderTimeline(currentData);
      positionNowLine(currentData);
    }
  }

  document.querySelectorAll('.nav-btn').forEach((btn) => {
    btn.addEventListener('click', () => switchView(btn.dataset.view));
  });

  refreshBtn.addEventListener('click', start);
  retryBtn.addEventListener('click', start);

  // ---------- Agenda (next 30 days) ----------
  function buildAgendaList() {
    if (agendaBuilt) return;
    agendaBuilt = true;

    const list = document.getElementById('agendaList');
    list.innerHTML = '';

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    for (let i = 0; i < AGENDA_DAYS; i++) {
      const d = new Date(today);
      d.setDate(d.getDate() + i);
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      const dateStr = `${y}-${m}-${day}`;

      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'agenda-row';
      const label = i === 0
        ? 'Tonight'
        : i === 1
          ? 'Tomorrow night'
          : d.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
      row.innerHTML = `
        <span class="agenda-date">${label}</span>
        <span class="agenda-arrow">→</span>
      `;
      row.addEventListener('click', () => openAgendaDay(dateStr, d));
      list.appendChild(row);
    }
  }

  function openAgendaDay(dateStr, dateObj) {
    if (currentLat === null || currentLon === null) return;
    errorPanel.classList.add('hidden');
    mainContent.classList.add('hidden');
    bottomNav.classList.add('hidden');
    statusPanel.classList.remove('hidden');
    setStatus(`Calculating sky for ${dateObj.toLocaleDateString([], { month: 'short', day: 'numeric' })}…`);
    fetchSky(currentLat, currentLon, currentElev, dateStr).then(() => switchView('timeline'));
  }

  // ---------- Settings: preferred observation time range (localStorage) ----------
  const prefStartInput = document.getElementById('prefStart');
  const prefEndInput = document.getElementById('prefEnd');

  function loadPreferences() {
    prefStartInput.value = localStorage.getItem(PREF_START_KEY) || '20:00';
    prefEndInput.value = localStorage.getItem(PREF_END_KEY) || '06:00';
  }

  function savePreferences() {
    localStorage.setItem(PREF_START_KEY, prefStartInput.value || '00:00');
    localStorage.setItem(PREF_END_KEY, prefEndInput.value || '23:59');
  }

  prefStartInput.addEventListener('change', savePreferences);
  prefEndInput.addEventListener('change', savePreferences);
  loadPreferences();

  start();
})();
