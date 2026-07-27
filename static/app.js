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
    loc_mode: 'auto',
    loc_lat: null,
    loc_lon: null,
    loc_elev: 0,
  };

  let zoomMode = 'auto';
  let zoomLevel = 1; // valeur réelle courante, recalculée si zoomMode === 'auto'

  let currentData = null;
  let nowLineTimer = null;
  let infoObj = null;
  let infoCountdownTimer = null;

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

  function pad2(n) { return String(n).padStart(2, '0'); }

  function formatCountdownMs(ms) {
    if (ms < 0) ms = 0;
    const totalSec = Math.floor(ms / 1000);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    return `${pad2(h)}:${pad2(m)}:${pad2(s)}`;
  }

  // Format "1j4h5m" pour les comptes à rebours pouvant s'étaler sur
  // plusieurs jours (ex : lever d'un objet actuellement sous l'altitude
  // minimale, à venir dans les 30 prochains jours).
  function formatCountdownDHM(ms) {
    if (ms < 0) ms = 0;
    const totalMin = Math.floor(ms / 60000);
    const d = Math.floor(totalMin / 1440);
    const h = Math.floor((totalMin % 1440) / 60);
    const m = totalMin % 60;
    if (d > 0) return `${d}j${h}h${m}m`;
    if (h > 0) return `${h}h${m}m`;
    return `${m}m`;
  }

  function updateInfoCountdown() {
    if (!infoObj || !infoObj.rise_iso || !infoObj.set_iso) return;
    const now = Date.now();
    const riseT = new Date(infoObj.rise_iso).getTime();
    const setT = new Date(infoObj.set_iso).getTime();
    const label = document.getElementById('infoCountdownLabel');
    const value = document.getElementById('infoCountdown');
    if (!label || !value) return;

    let diffMs;
    if (now < riseT) {
      label.textContent = 'Se lève dans';
      diffMs = riseT - now;
    } else if (now <= setT) {
      label.textContent = 'Se couche dans';
      diffMs = setT - now;
    } else {
      label.textContent = 'Couché';
      diffMs = 0;
    }
    value.textContent = formatCountdownMs(diffMs);
  }

  // L'app ne s'ouvre qu'une fois TOUT reçu (réglages, favoris, position,
  // ciel, bibliothèque, stats). Tant que initialLoadDone est false, aucun
  // rendu ne doit rendre mainContent/errorPanel visibles : on reste sur
  // l'écran de chargement avec sa barre de progression.
  let initialLoadDone = false;
  let lastSkyError = null;

  function setStatus(msg) { statusText.textContent = msg; }

  const progressBarFill = document.getElementById('progressBarFill');
  const progressPct = document.getElementById('progressPct');
  function setProgress(pct) {
    pct = Math.max(0, Math.min(100, Math.round(pct)));
    if (progressBarFill) progressBarFill.style.width = pct + '%';
    if (progressPct) progressPct.textContent = pct + '%';
  }

  function showError(msg) {
    if (!initialLoadDone) { lastSkyError = msg; return; }
    statusPanel.classList.add('hidden');
    mainContent.classList.add('hidden');
    errorPanel.classList.remove('hidden');
    errorText.textContent = msg;
  }

  // L'app doit toujours pouvoir s'ouvrir (nav + réglages accessibles) même
  // sans position connue : seul le contenu qui dépend du ciel (timeline,
  // schedule, overview, agenda) reste en état "verrouillé" tant qu'aucune
  // position (GPS ou manuelle) n'est disponible.
  function showAppShell() {
    statusPanel.classList.add('hidden');
    errorPanel.classList.add('hidden');
    mainContent.classList.remove('hidden');
    bottomNav.classList.remove('hidden');
  }

  function isLocationSet() {
    return currentLat !== null && currentLon !== null && !isNaN(currentLat) && !isNaN(currentLon);
  }

  function updateLocCurrentLine() {
    const el = document.getElementById('locCurrentLine');
    if (!el) return;
    el.textContent = isLocationSet()
      ? `Position actuelle : ${currentLat.toFixed(3)}°, ${currentLon.toFixed(3)}°`
      : 'Position actuelle : non définie';
  }

  function renderNoLocation(msg) {
    currentData = null;
    if (nowLineTimer) { clearInterval(nowLineTimer); nowLineTimer = null; }

    document.getElementById('tlDate').textContent = '—';
    document.getElementById('tlHours').innerHTML = '';
    const tlWrap = document.getElementById('tlWrap');
    tlWrap.style.height = '220px';
    const tlLanes = document.getElementById('tlLanes');
    tlLanes.style.height = '220px';
    tlLanes.style.backgroundImage = 'none';
    tlLanes.innerHTML = `<div class="locked-state locked-state-abs"><p>${msg}</p>
      <button type="button" class="retry-btn locked-settings-btn">Ouvrir les paramètres</button></div>`;
    ['sunsetLine', 'sunriseLine', 'nowLine'].forEach((id) => {
      document.getElementById(id).style.display = 'none';
    });

    document.getElementById('scheduleBody').innerHTML =
      `<div class="locked-state"><p>${msg}</p>
        <button type="button" class="retry-btn locked-settings-btn">Ouvrir les paramètres</button></div>`;

    document.getElementById('sunsetTime').textContent = '--:--';
    document.getElementById('sunriseTime').textContent = '--:--';
    document.getElementById('objectCount').textContent = '0';
    document.getElementById('legend').innerHTML = '';

    const agendaIntro = document.querySelector('.agenda-intro');
    if (agendaIntro) agendaIntro.textContent = 'Définis ta position dans Paramètres pour charger le ciel d\u2019un soir.';

    locLine.textContent = 'Position non définie';
    updateLocCurrentLine();

    document.querySelectorAll('.locked-settings-btn').forEach((btn) => {
      btn.addEventListener('click', () => switchView('settings'));
    });

    renderLibraryStats(); // ne dépend pas de la position
  }

  // Décide comment obtenir la position (GPS ou manuelle) puis lance le
  // calcul du ciel, ou affiche l'état "position non définie" si rien n'est
  // disponible. L'app (nav + réglages) reste toujours accessible.
  function resolveLocation() {
    showAppShell();
    const auto = settingsCache.loc_mode !== 'manual';

    if (!auto) {
      const lat = parseFloat(settingsCache.loc_lat);
      const lon = parseFloat(settingsCache.loc_lon);
      if (isNaN(lat) || isNaN(lon)) {
        currentLat = null;
        currentLon = null;
        renderNoLocation('Aucune position définie. Choisis-la sur la carte ou saisis-la dans Paramètres.');
        return;
      }
      currentLat = lat;
      currentLon = lon;
      currentElev = parseFloat(settingsCache.loc_elev) || 0;
      locLine.textContent = `${lat.toFixed(3)}°, ${lon.toFixed(3)}°`;
      updateLocCurrentLine();
      fetchSky(currentLat, currentLon, currentElev);
      return;
    }

    if (!navigator.geolocation) {
      renderNoLocation('La géolocalisation n\u2019est pas supportée par ce navigateur. Définis ta position manuellement dans Paramètres.');
      return;
    }

    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const { latitude, longitude, altitude } = pos.coords;
        currentLat = latitude;
        currentLon = longitude;
        currentElev = altitude || 0;
        locLine.textContent = `${latitude.toFixed(3)}°, ${longitude.toFixed(3)}°`;
        updateLocCurrentLine();
        fetchSky(currentLat, currentLon, currentElev);
      },
      () => {
        currentLat = null;
        currentLon = null;
        renderNoLocation('Localisation refusée ou indisponible. Active le GPS ou définis ta position manuellement dans Paramètres.');
      },
      { enableHighAccuracy: true, timeout: 15000 }
    );
  }

  // Résout la position (GPS ou manuelle) sans toucher au DOM ni déclencher
  // de calcul : utilisé exclusivement par l'écran de chargement initial,
  // qui orchestre lui-même chaque étape et sa barre de progression.
  function getInitialLocation() {
    return new Promise((resolve) => {
      const auto = settingsCache.loc_mode !== 'manual';

      if (!auto) {
        const lat = parseFloat(settingsCache.loc_lat);
        const lon = parseFloat(settingsCache.loc_lon);
        if (isNaN(lat) || isNaN(lon)) { resolve(null); return; }
        resolve({ lat, lon, elev: parseFloat(settingsCache.loc_elev) || 0 });
        return;
      }

      if (!navigator.geolocation) { resolve(null); return; }

      navigator.geolocation.getCurrentPosition(
        (pos) => {
          const { latitude, longitude, altitude } = pos.coords;
          resolve({ lat: latitude, lon: longitude, elev: altitude || 0 });
        },
        () => resolve(null),
        { enableHighAccuracy: true, timeout: 15000 }
      );
    });
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
    if (initialLoadDone) {
      statusPanel.classList.add('hidden');
      errorPanel.classList.add('hidden');
      mainContent.classList.remove('hidden');
      bottomNav.classList.remove('hidden');
    }

    document.getElementById('sunsetTime').textContent = fmtTime(data.sunset);
    document.getElementById('sunriseTime').textContent = fmtTime(data.sunrise);
    document.getElementById('objectCount').textContent = data.objects.length;
    document.getElementById('tlDate').textContent = new Date(data.sunset)
      .toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });

    const agendaIntro = document.querySelector('.agenda-intro');
    if (agendaIntro) agendaIntro.textContent = 'Tap a night to load its sky.';
    updateLocCurrentLine();

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

      const fav = isFavorite(o.name);
      const block = document.createElement('div');
      block.className = 'block' + (narrow ? ' block-narrow' : '') + (fav ? ' block-favorite' : '');
      block.style.top = `${topPx}px`;
      block.style.height = `${heightPx}px`;
      block.style.left = `${o.lane * laneWidth + 2}px`;
      block.style.width = `${Math.max(laneWidth - 4, 4)}px`;
      block.style.background = o.color;

      const magStr = (o.magnitude !== null && o.magnitude !== undefined) ? `mag ${o.magnitude}` : '';
      const subLine = narrow ? '' : `<span class="b-sub">${o.peak_altitude}° ${magStr}</span>`;
      const favBadge = fav ? `<span class="b-fav">★</span>` : '';
      block.innerHTML = `${favBadge}<span class="b-name">${o.name}</span>${subLine}`;
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

  // ---------- Wikipedia (image carrée + description) dans la popup info ----------
  const wikiInfoCache = new Map();

  async function fetchObjectInfo(name) {
    if (wikiInfoCache.has(name)) return wikiInfoCache.get(name);
    try {
      const res = await fetch(`/api/object-info?name=${encodeURIComponent(name)}`);
      if (!res.ok) throw new Error('bad response');
      const data = await res.json();
      wikiInfoCache.set(name, data);
      return data;
    } catch (e) {
      const fallback = { image: null, description: null };
      wikiInfoCache.set(name, fallback);
      return fallback;
    }
  }

  function renderInfoWiki(data) {
    const wrap = document.getElementById('infoWiki');
    const img = document.getElementById('infoWikiImg');
    const desc = document.getElementById('infoWikiDesc');
    if (!wrap || !img || !desc) return;

    if (!data || (!data.image && !data.description)) {
      wrap.classList.add('hidden');
      return;
    }

    if (data.image) {
      img.src = data.image;
      img.classList.remove('hidden');
    } else {
      img.removeAttribute('src');
      img.classList.add('hidden');
    }
    desc.textContent = data.description || '';
    wrap.classList.remove('hidden');
  }

  function openInfo(o) {
    // Le lever/coucher "vrai" (réel, non limité par la fenêtre d'affichage
    // marge/plage fixe) prime toujours quand il est disponible. Les objets
    // renvoyés par /api/sky l'exposent via true_rise_iso/true_set_iso ; les
    // objets venant seulement de la bibliothèque (/api/catalog/list) ont
    // déjà des rise_iso/set_iso "vrais" puisqu'ils ne dépendent d'aucune
    // fenêtre d'affichage.
    const trueRise = o.true_rise_iso || o.rise_iso || null;
    const trueSet = o.true_set_iso || o.set_iso || null;
    infoObj = { ...o, rise_iso: trueRise, set_iso: trueSet };

    // Chargement asynchrone du résumé Wikipedia (image + description) ;
    // on masque le bloc pendant le chargement puis on vérifie que la
    // popup affiche toujours le même objet avant d'appliquer le résultat
    // (au cas où l'utilisateur aurait ouvert un autre objet entre-temps).
    const wikiWrap = document.getElementById('infoWiki');
    if (wikiWrap) wikiWrap.classList.add('hidden');
    const wikiRequestName = o.name;
    fetchObjectInfo(wikiRequestName).then((data) => {
      if (infoObj && infoObj.name === wikiRequestName) renderInfoWiki(data);
    });

    const color = o.color || CATEGORY_COLOR_VAR[o.category] || 'var(--text-muted)';
    document.getElementById('infoDot').style.background = color;
    document.getElementById('infoDot').style.color = color;
    document.getElementById('infoName').textContent = o.name;
    document.getElementById('infoCategory').textContent = CATEGORY_LABEL[o.category] || capitalize(o.category);
    updateInfoFavBtn();

    const hasWindow = !!(trueRise && trueSet);
    if (hasWindow) {
      document.getElementById('infoRise').textContent = fmtTime(trueRise);
      document.getElementById('infoSet').textContent = fmtTime(trueSet);
      const durationMin = (new Date(trueSet).getTime() - new Date(trueRise).getTime()) / 60000;
      document.getElementById('infoDuration').textContent = fmtDuration(durationMin);
    } else if (o.always_visible) {
      document.getElementById('infoRise').textContent = 'Toujours';
      document.getElementById('infoSet').textContent = 'levé';
      document.getElementById('infoDuration').textContent = '24h+';
    } else if (o.never_visible) {
      document.getElementById('infoRise').textContent = '—';
      document.getElementById('infoSet').textContent = '—';
      document.getElementById('infoDuration').textContent = '—';
    } else {
      document.getElementById('infoRise').textContent = '--:--';
      document.getElementById('infoSet').textContent = '--:--';
      document.getElementById('infoDuration').textContent = '—';
    }
    document.getElementById('infoAlt').textContent =
      (o.peak_altitude !== undefined && o.peak_altitude !== null) ? `${o.peak_altitude}°` : '—';
    document.getElementById('infoMag').textContent = (o.magnitude !== null && o.magnitude !== undefined)
      ? `mag ${o.magnitude}` : 'n/a';

    const countdownCell = document.getElementById('infoCountdownCell');
    if (infoCountdownTimer) { clearInterval(infoCountdownTimer); infoCountdownTimer = null; }

    if (hasWindow) {
      countdownCell.classList.remove('hidden');
      updateInfoCountdown();
      infoCountdownTimer = setInterval(updateInfoCountdown, 1000);
    } else {
      countdownCell.classList.add('hidden');
    }

    document.getElementById('infoOverlay').classList.remove('hidden');
  }

  function closeInfo() {
    document.getElementById('infoOverlay').classList.add('hidden');
    if (infoCountdownTimer) { clearInterval(infoCountdownTimer); infoCountdownTimer = null; }
    infoObj = null;
  }

  function updateInfoFavBtn() {
    const btn = document.getElementById('infoFavBtn');
    if (!btn || !infoObj) return;
    const fav = isFavorite(infoObj.name);
    btn.classList.toggle('active', fav);
    btn.title = fav ? 'Retirer des favoris' : 'Ajouter aux favoris';
    const icon = btn.querySelector('i');
    if (icon) icon.className = fav ? 'bx bxs-star' : 'bx bx-star';
  }

  document.getElementById('infoFavBtn').addEventListener('click', async () => {
    if (!infoObj) return;
    await toggleFavorite(infoObj.name);
    updateInfoFavBtn();
  });

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
    if (name === 'library') {
      initLibraryView();
    } else {
      stopLibraryCountdownTimer();
    }
    if (name !== 'tools') {
      stopActiveTool();
    }
  }

  document.querySelectorAll('.nav-btn').forEach((btn) => {
    btn.addEventListener('click', () => switchView(btn.dataset.view));
  });

  refreshBtn.addEventListener('click', resolveLocation);
  retryBtn.addEventListener('click', resolveLocation);

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

  // ---------- Settings: pas de sauvegarde automatique ----------
  // Tout changement de paramètre ne fait que mettre à jour l'affichage local
  // (formulaire) et signale des modifications non enregistrées. Rien n'est
  // envoyé au serveur ni recalculé tant que l'utilisateur n'a pas cliqué sur
  // "Enregistrer et relancer" : à ce moment-là seulement, tout est envoyé en
  // une fois puis la page est rechargée (relance complète, aucune surprise).
  const settingsSaveBar = document.getElementById('settingsSaveBar');
  const settingsSaveBtn = document.getElementById('settingsSaveBtn');
  const settingsDiscardBtn = document.getElementById('settingsDiscardBtn');

  function markSettingsDirty() {
    if (settingsSaveBar) settingsSaveBar.classList.remove('hidden');
  }

  function clearSettingsDirty() {
    if (settingsSaveBar) settingsSaveBar.classList.add('hidden');
  }

  function onPreferencesChanged() {
    const mode = modeFixedRadio.checked ? 'fixed' : 'margin';
    marginInput.disabled = (mode === 'fixed');
    fixedStartInput.disabled = (mode !== 'fixed');
    fixedEndInput.disabled = (mode !== 'fixed');
    markSettingsDirty();
  }

  modeFixedRadio.addEventListener('change', onPreferencesChanged);
  modeMarginRadio.addEventListener('change', onPreferencesChanged);
  marginInput.addEventListener('change', onPreferencesChanged);
  fixedStartInput.addEventListener('change', onPreferencesChanged);
  fixedEndInput.addEventListener('change', onPreferencesChanged);
  minAltInput.addEventListener('change', onPreferencesChanged);

  if (redFilterBtn) {
    redFilterBtn.addEventListener('click', () => {
      // Sauvegarde immédiate en base (pas besoin de "Enregistrer et
      // relancer", pas de reload de l'appli).
      const enabled = !document.body.classList.contains('red-filter');
      applyRedFilter(enabled);
      saveSettings({ red_filter: enabled });
    });
  }

  async function commitSettingsAndReload() {
    let margin = parseInt(marginInput.value, 10);
    if (isNaN(margin) || margin < 0) margin = 0;
    const startVal = fixedStartInput.value || '20:00';
    const endVal = fixedEndInput.value || '06:00';
    let minAltVal = parseFloat(minAltInput.value);
    if (isNaN(minAltVal) || minAltVal < 0) minAltVal = 0;
    if (minAltVal > 90) minAltVal = 90;

    const updates = {
      pref_mode: modeFixedRadio.checked ? 'fixed' : 'margin',
      pref_margin: margin,
      pref_fixed_start: startVal,
      pref_fixed_end: endVal,
      pref_min_alt: minAltVal,
      red_filter: document.body.classList.contains('red-filter'),
    };

    const auto = locAutoToggle.checked;
    updates.loc_mode = auto ? 'auto' : 'manual';
    if (!auto) {
      const lat = parseFloat(locLatInput.value);
      const lon = parseFloat(locLonInput.value);
      let elev = parseFloat(locElevInput.value);
      if (isNaN(lat) || lat < -90 || lat > 90 || isNaN(lon) || lon < -180 || lon > 180) {
        locAutoHint.textContent = 'Latitude ou longitude invalide. Corrige avant d\u2019enregistrer.';
        return;
      }
      if (isNaN(elev)) elev = 0;
      updates.loc_lat = lat;
      updates.loc_lon = lon;
      updates.loc_elev = elev;
    }

    if (settingsSaveBtn) {
      settingsSaveBtn.disabled = true;
      settingsSaveBtn.textContent = 'Enregistrement…';
    }

    try {
      await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates),
      });
    } catch (e) {
      // best effort : on relance quand même, l'app repartira sur les
      // dernières valeurs connues côté serveur
    }

    location.reload();
  }

  if (settingsSaveBtn) settingsSaveBtn.addEventListener('click', commitSettingsAndReload);

  if (settingsDiscardBtn) {
    settingsDiscardBtn.addEventListener('click', () => {
      loadPreferences();
      loadLocationPreferences();
      applyRedFilter(!!settingsCache.red_filter);
      clearSettingsDirty();
    });
  }

  // ---------- Settings: Localisation (GPS auto / carte / manuel) ----------
  const locAutoToggle = document.getElementById('locAutoToggle');
  const locAutoHint = document.getElementById('locAutoHint');
  const locManualBlock = document.getElementById('locManualBlock');
  const locLatInput = document.getElementById('locLatInput');
  const locLonInput = document.getElementById('locLonInput');
  const locElevInput = document.getElementById('locElevInput');
  const locSaveBtn = document.getElementById('locSaveBtn');
  const locMapBtn = document.getElementById('locMapBtn');
  const mapOverlay = document.getElementById('mapOverlay');
  const mapClose = document.getElementById('mapClose');
  const mapValidate = document.getElementById('mapValidate');

  function loadLocationPreferences() {
    const auto = settingsCache.loc_mode !== 'manual';
    locAutoToggle.checked = auto;
    locManualBlock.classList.toggle('hidden', auto);
    locAutoHint.textContent = auto
      ? 'L\u2019application utilise la position GPS de l\u2019appareil.'
      : 'Position définie manuellement ci-dessous.';

    if (settingsCache.loc_lat !== null && settingsCache.loc_lat !== undefined) {
      locLatInput.value = settingsCache.loc_lat;
    }
    if (settingsCache.loc_lon !== null && settingsCache.loc_lon !== undefined) {
      locLonInput.value = settingsCache.loc_lon;
    }
    locElevInput.value = (settingsCache.loc_elev !== null && settingsCache.loc_elev !== undefined)
      ? settingsCache.loc_elev : 0;

    updateLocCurrentLine();
  }

  locAutoToggle.addEventListener('change', () => {
    const auto = locAutoToggle.checked;
    locManualBlock.classList.toggle('hidden', auto);
    locAutoHint.textContent = auto
      ? 'L\u2019application utilise la position GPS de l\u2019appareil.'
      : 'Position définie manuellement ci-dessous (non enregistrée).';
    markSettingsDirty();
  });

  locSaveBtn.addEventListener('click', () => {
    const lat = parseFloat(locLatInput.value);
    const lon = parseFloat(locLonInput.value);
    let elev = parseFloat(locElevInput.value);
    if (isNaN(lat) || lat < -90 || lat > 90 || isNaN(lon) || lon < -180 || lon > 180) {
      locAutoHint.textContent = 'Latitude ou longitude invalide.';
      return;
    }
    if (isNaN(elev)) elev = 0;
    locAutoToggle.checked = false;
    locManualBlock.classList.remove('hidden');
    locAutoHint.textContent = 'Position définie manuellement ci-dessous (non enregistrée).';
    markSettingsDirty();
  });

  // Carte de sélection : Leaflet + tuiles OpenStreetMap (gratuit, sans clé API).
  let pickerMap = null;
  let pickerMarker = null;

  function openMapPicker() {
    mapOverlay.classList.remove('hidden');
    const fallbackLat = parseFloat(locLatInput.value) || currentLat || 48.8566;
    const fallbackLon = parseFloat(locLonInput.value) || currentLon || 2.3522;

    if (!pickerMap) {
      pickerMap = L.map('mapPicker').setView([fallbackLat, fallbackLon], 6);
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 18,
        attribution: '\u00a9 OpenStreetMap contributors',
      }).addTo(pickerMap);
      pickerMarker = L.marker([fallbackLat, fallbackLon], { draggable: true }).addTo(pickerMap);
      pickerMap.on('click', (e) => pickerMarker.setLatLng(e.latlng));
    } else {
      pickerMap.setView([fallbackLat, fallbackLon], pickerMap.getZoom());
      pickerMarker.setLatLng([fallbackLat, fallbackLon]);
    }
    // La modale vient d'apparaître : Leaflet a besoin d'un recalcul de taille.
    setTimeout(() => pickerMap.invalidateSize(), 150);
  }

  function closeMapPicker() {
    mapOverlay.classList.add('hidden');
  }

  locMapBtn.addEventListener('click', openMapPicker);
  mapClose.addEventListener('click', closeMapPicker);
  mapOverlay.addEventListener('click', (e) => {
    if (e.target.id === 'mapOverlay') closeMapPicker();
  });
  mapValidate.addEventListener('click', () => {
    if (!pickerMarker) return;
    const { lat, lng } = pickerMarker.getLatLng();
    locLatInput.value = lat.toFixed(4);
    locLonInput.value = lng.toFixed(4);
    closeMapPicker();
  });

  // ---------- Favoris (persistés côté serveur) ----------
  let favoritesSet = new Set();

  async function loadFavorites() {
    try {
      const res = await fetch('/api/favorites');
      if (res.ok) {
        const data = await res.json();
        favoritesSet = new Set(data.favorites || []);
      }
    } catch (e) {
      // hors-ligne / erreur réseau : on garde l'état courant (vide au 1er chargement)
    }
  }

  function isFavorite(name) {
    return favoritesSet.has(name);
  }

  async function toggleFavorite(name) {
    // Mise à jour optimiste locale, puis confirmation serveur.
    const wasFav = favoritesSet.has(name);
    if (wasFav) favoritesSet.delete(name); else favoritesSet.add(name);
    renderLibraryList();
    if (currentData) renderTimeline(currentData);

    try {
      const res = await fetch('/api/favorites/toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      if (res.ok) {
        const data = await res.json();
        if (data.favorite) favoritesSet.add(name); else favoritesSet.delete(name);
      }
    } catch (e) {
      // best effort : l'état local reste appliqué pour cette session
    }
    renderLibraryList();
    if (currentData) renderTimeline(currentData);
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

  // ---------- Library: searchable/filterable catalog list ----------
  const CATEGORY_COLOR_VAR = {
    moon: 'var(--c-moon)',
    planet: 'var(--c-planet)',
    star: 'var(--c-star)',
    galaxy: 'var(--c-galaxy)',
    nebula: 'var(--c-nebula)',
    cluster: 'var(--c-cluster)',
  };
  const CATEGORY_LABEL = {
    moon: 'Lune',
    planet: 'Planète',
    star: 'Étoile',
    galaxy: 'Galaxie',
    nebula: 'Nébuleuse',
    cluster: 'Amas',
  };

  let catalogList = null;
  let catalogListKey = null;
  let libActiveCategory = 'all';
  let libSearchTerm = '';
  let libCountdownTimer = null;

  function normalizeSearch(s) {
    return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  }

  async function fetchCatalogListOnce() {
    // Clé de cache : la position et l'altitude minimale influent sur le
    // lever/coucher réel de chaque objet, donc on refait la requête dès
    // qu'un de ces paramètres change (nouvelle position, réglage modifié…).
    const key = isLocationSet()
      ? `${currentLat.toFixed(4)}|${currentLon.toFixed(4)}|${currentElev}|${getMinAlt()}`
      : 'no-location';
    if (catalogList && catalogListKey === key) return catalogList;
    try {
      let url = '/api/catalog/list';
      if (isLocationSet()) {
        url += `?lat=${currentLat}&lon=${currentLon}&elev=${currentElev}&min_alt=${getMinAlt()}`;
      }
      const res = await fetch(url);
      if (!res.ok) return null;
      const data = await res.json();
      catalogList = data.items;
      catalogListKey = key;
      return catalogList;
    } catch (e) {
      return null;
    }
  }

  function renderLibraryList() {
    const listEl = document.getElementById('libList');
    const countEl = document.getElementById('libCount');
    if (!listEl) return;

    if (!catalogList) {
      listEl.innerHTML = '<div class="lib-empty">Chargement…</div>';
      countEl.textContent = '—';
      return;
    }

    const term = normalizeSearch(libSearchTerm.trim());
    const filtered = catalogList.filter((o) => {
      if (libActiveCategory === 'favorites') {
        if (!isFavorite(o.name)) return false;
      } else if (libActiveCategory !== 'all' && o.category !== libActiveCategory) {
        return false;
      }
      if (term && !normalizeSearch(o.name).includes(term)) return false;
      return true;
    });

    countEl.textContent = `${filtered.length} objet${filtered.length > 1 ? 's' : ''}`;

    if (filtered.length === 0) {
      listEl.innerHTML = libActiveCategory === 'favorites'
        ? '<div class="lib-empty">Aucun favori pour l\u2019instant. Touche l\u2019étoile d\u2019un objet pour l\u2019ajouter.</div>'
        : '<div class="lib-empty">Aucun objet ne correspond.</div>';
      return;
    }

    listEl.innerHTML = filtered.map((o) => {
      const color = CATEGORY_COLOR_VAR[o.category] || 'var(--text-muted)';
      const magStr = (o.magnitude !== null && o.magnitude !== undefined) ? `mag ${o.magnitude}` : '—';
      const nameAttr = o.name.replace(/"/g, '&quot;');
      const fav = isFavorite(o.name);

      let whenLine = '';
      let countdownHtml = '';
      if (o.always_visible) {
        whenLine = `<span class="lib-row-when lib-row-when-special">Toujours au-dessus de ${getMinAlt()}°</span>`;
        countdownHtml = `<span class="lib-row-countdown lib-row-countdown-static">Toujours visible</span>`;
      } else if (o.never_visible) {
        // Toujours sous l'altitude minimale dans l'immédiat, mais un lever
        // futur (jusqu'à 30 jours) a pu être trouvé (déclinaison de la
        // Lune/des planètes qui évolue). On affiche un compte à rebours
        // plutôt qu'un message statique, y compris hors plage horaire.
        if (o.rise_iso) {
          whenLine = `<span class="lib-row-when lib-row-when-special">Sous ${getMinAlt()}° ici pour l\u2019instant</span>`;
          countdownHtml = `
            <span class="lib-row-countdown lib-row-countdown-far" data-rise="${o.rise_iso}">
              <span class="lib-row-countdown-label">Se lève dans</span>
              <span class="lib-row-countdown-value">--</span>
            </span>`;
        } else {
          whenLine = `<span class="lib-row-when lib-row-when-special">Sous ${getMinAlt()}° ici</span>`;
          countdownHtml = `<span class="lib-row-countdown lib-row-countdown-static">—</span>`;
        }
      } else if (o.rise_iso && o.set_iso) {
        whenLine = `<span class="lib-row-when">Lève ${fmtTime(o.rise_iso)} · Couche ${fmtTime(o.set_iso)}</span>`;
        countdownHtml = `
          <span class="lib-row-countdown" data-rise="${o.rise_iso}" data-set="${o.set_iso}">
            <span class="lib-row-countdown-label">—</span>
            <span class="lib-row-countdown-value">--:--:--</span>
          </span>`;
      }

      return `
        <div class="lib-row lib-row-clickable" data-name="${nameAttr}">
          <span class="lib-row-dot" style="background:${color}"></span>
          <span class="lib-row-main">
            <span class="lib-row-name">${o.name}</span>
            <span class="lib-row-meta">${CATEGORY_LABEL[o.category] || capitalize(o.category)}</span>
            ${whenLine}
          </span>
          <span class="lib-row-side">
            <span class="lib-row-mag">${magStr}</span>
            ${countdownHtml}
          </span>
          <button type="button" class="lib-fav-btn${fav ? ' active' : ''}" data-name="${nameAttr}" title="${fav ? 'Retirer des favoris' : 'Ajouter aux favoris'}">
            <i class='bx ${fav ? 'bxs-star' : 'bx-star'}'></i>
          </button>
        </div>
      `;
    }).join('');

    tickLibraryCountdowns();
  }

  function tickLibraryCountdowns() {
    const now = Date.now();
    document.querySelectorAll('#libList .lib-row-countdown[data-rise]').forEach((el) => {
      const riseT = new Date(el.dataset.rise).getTime();
      const labelEl = el.querySelector('.lib-row-countdown-label');
      const valueEl = el.querySelector('.lib-row-countdown-value');
      if (!labelEl || !valueEl) return;

      // Lever lointain (objet actuellement sous l'altitude minimale) :
      // pas de coucher connu, on affiche toujours "Se lève dans", même
      // hors plage horaire, au format 1j4h5m.
      if (el.classList.contains('lib-row-countdown-far')) {
        labelEl.textContent = 'Se lève dans';
        valueEl.textContent = formatCountdownDHM(Math.max(riseT - now, 0));
        return;
      }

      const setT = new Date(el.dataset.set).getTime();
      let diffMs;
      if (now < riseT) { labelEl.textContent = 'Se lève dans'; diffMs = riseT - now; }
      else if (now <= setT) { labelEl.textContent = 'Se couche dans'; diffMs = setT - now; }
      else { labelEl.textContent = 'Couché'; diffMs = 0; }
      valueEl.textContent = formatCountdownMs(diffMs);
    });
  }

  function startLibraryCountdownTimer() {
    if (libCountdownTimer) clearInterval(libCountdownTimer);
    libCountdownTimer = setInterval(tickLibraryCountdowns, 1000);
  }

  function stopLibraryCountdownTimer() {
    if (libCountdownTimer) { clearInterval(libCountdownTimer); libCountdownTimer = null; }
  }

  async function initLibraryView() {
    await fetchCatalogListOnce();
    renderLibraryList();
    startLibraryCountdownTimer();
  }

  const libSearchInput = document.getElementById('libSearchInput');
  if (libSearchInput) {
    libSearchInput.addEventListener('input', () => {
      libSearchTerm = libSearchInput.value;
      renderLibraryList();
    });
  }

  document.querySelectorAll('.lib-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      libActiveCategory = chip.dataset.cat;
      document.querySelectorAll('.lib-chip').forEach((c) => c.classList.toggle('active', c === chip));
      renderLibraryList();
    });
  });

  const libListEl = document.getElementById('libList');
  if (libListEl) {
    libListEl.addEventListener('click', (e) => {
      const favBtn = e.target.closest('.lib-fav-btn');
      if (favBtn && favBtn.dataset.name) {
        e.stopPropagation();
        toggleFavorite(favBtn.dataset.name);
        return;
      }
      const row = e.target.closest('.lib-row');
      if (!row || !row.dataset.name) return;
      const catalogItem = catalogList && catalogList.find((o) => o.name === row.dataset.name);
      if (!catalogItem) return;
      // Les objets de currentData (timeline) portent un true_rise_iso/
      // true_set_iso calculé par rapport à la nuit affichée, qui peut être
      // une nuit future (navigation dans l'agenda) différente d'aujourd'hui.
      // Le catalogue, lui, est toujours calculé par rapport à l'heure
      // réelle actuelle : on ne préfère donc le timeline que s'il concerne
      // bien le jour courant, sinon le catalogue reste la seule source
      // fiable pour le lever/coucher affiché dans la fiche objet.
      const isTodayData = currentData
        && (!currentData.requested_date || currentData.requested_date === toDateStr(new Date()));
      const liveMatch = (isTodayData && currentData.objects)
        ? currentData.objects.find((obj) => obj.name === catalogItem.name)
        : null;
      openInfo(liveMatch || catalogItem);
    });
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

  // Écran de chargement : l'app ne s'ouvre qu'une fois TOUT reçu, y compris
  // la bibliothèque (horaires lever/coucher de chaque objet) et les stats
  // du catalogue. Chaque étape avance la barre de progression ; une fois
  // toutes les étapes terminées, on révèle l'app d'un coup — plus aucune
  // surprise ensuite tant que les réglages ne sont pas explicitement
  // sauvegardés (voir commitSettingsAndReload).
  async function initApp() {
    const steps = [
      ['Chargement des réglages…', loadSettingsFromServer],
      ['Chargement des favoris…', loadFavorites],
      ['Localisation…', async () => {
        const loc = await getInitialLocation();
        if (loc) {
          currentLat = loc.lat;
          currentLon = loc.lon;
          currentElev = loc.elev;
        } else {
          currentLat = null;
          currentLon = null;
        }
      }],
      ['Calcul du ciel…', async () => {
        if (isLocationSet()) await fetchSky(currentLat, currentLon, currentElev);
      }],
      ['Chargement de la bibliothèque…', fetchCatalogListOnce],
      ['Chargement des statistiques…', fetchCatalogStatsOnce],
    ];

    for (let i = 0; i < steps.length; i++) {
      const [label, fn] = steps[i];
      setStatus(label);
      try { await fn(); } catch (e) { /* on continue : app offline-friendly */ }
      setProgress(((i + 1) / steps.length) * 100);
    }

    loadPreferences();
    loadLocationPreferences();
    applyRedFilter(!!settingsCache.red_filter);

    if (isLocationSet()) {
      locLine.textContent = `${currentLat.toFixed(3)}°, ${currentLon.toFixed(3)}°`;
      if (!currentData) {
        renderNoLocation(lastSkyError || 'Impossible de calculer le ciel pour le moment.');
      }
    } else {
      renderNoLocation('Aucune position définie. Choisis-la sur la carte ou saisis-la dans Paramètres.');
    }

    initialLoadDone = true;
    showAppShell();
    renderLibraryList();
  }
  initApp();
})();