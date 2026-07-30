(() => {
  const agendaFilterState = { cat: 'all', maxMag: null };

  const statusPanel = document.getElementById('statusPanel');
  const statusText = document.getElementById('statusText');
  const errorPanel = document.getElementById('errorPanel');
  const errorText = document.getElementById('errorText');
  const mainContent = document.getElementById('mainContent');
  const bottomNav = document.getElementById('bottomNav');
  const locLine = document.getElementById('locLine');
  const retryBtn = document.getElementById('retryBtn');

  const BASE_PX_PER_MIN = 2.4;
  const ZOOM_MIN = 0.25;
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

  // ---------- Filtre timeline (partagé Timeline + Agenda) ----------
  // Filtre purement côté client : catégorie (ou favoris), magnitude max.
  // N'affecte que le rendu des blocs (le layout des voies reste basé sur
  // data.lane_count / o.lane calculés côté serveur, ce qui évite de tout
  // recalculer côté client à chaque changement de filtre).
  const tlFilterState = { cat: 'all', maxMag: null, journal: 'all' };

  function objectPassesFilter(o, filterState) {
    if (filterState.cat === 'favorites') {
      if (!isFavorite(o.name)) return false;
    } else if (filterState.cat !== 'all' && o.category !== filterState.cat) {
      return false;
    }
    if (filterState.maxMag !== null && !isNaN(filterState.maxMag)) {
      if (o.magnitude === null || o.magnitude === undefined) return false;
      if (o.magnitude > filterState.maxMag) return false;
    }
    if (filterState.journal && filterState.journal !== 'all') {
    if (getObjectJournalStatus(o.name) !== filterState.journal) return false;
    }
    return true;
  }

  function filterObjects(objects, filterState) {
    return objects.filter((o) => objectPassesFilter(o, filterState));
  }

  // Réassigne les voies (greedy interval coloring) uniquement sur les objets
// visibles après filtrage, pour ne pas gâcher l'espace des voies occupées
// par des objets masqués.
function assignLanesClient(objects) {
  const sorted = [...objects].sort(
    (a, b) => new Date(a.rise_iso) - new Date(b.rise_iso)
  );
  const laneEndTimes = [];
  const laneOf = new Map();

  sorted.forEach((o) => {
    const rise = new Date(o.rise_iso).getTime();
    const set = new Date(o.set_iso).getTime();
    let placed = false;
    for (let i = 0; i < laneEndTimes.length; i++) {
      if (rise >= laneEndTimes[i]) {
        laneOf.set(o, i);
        laneEndTimes[i] = set;
        placed = true;
        break;
      }
    }
    if (!placed) {
      laneOf.set(o, laneEndTimes.length);
      laneEndTimes.push(set);
    }
  });

  return { laneOf, laneCount: laneEndTimes.length };
}

function refreshSharedFilterViews() {
    if (!currentData) return;
    renderTimeline(currentData, false);
    renderSchedule(currentData);
  }

 

  wireFilterPanel({
    toggleBtnId: 'scheduleFilterBtn',
    panelId: 'scheduleFilterPanel',
    chipSelector: '.schedule-filter-chip',
    magInputId: 'scheduleFilterMag',
    magClearId: 'scheduleFilterMagClear',
    countId: 'scheduleFilterCount',
    filterState: tlFilterState,
    onChange: refreshSharedFilterViews,
    linkedChipSelectors: ['.tl-filter-chip'],
    linkedMagInputIds: ['tlFilterMag'],
  });

  function wireFilterPanel({ toggleBtnId, panelId, chipSelector, magInputId, magClearId, countId, filterState, onChange, linkedChipSelectors = [], linkedMagInputIds = [] }) {
    const toggleBtn = document.getElementById(toggleBtnId);
    const panel = document.getElementById(panelId);
    const magInput = document.getElementById(magInputId);
    const magClear = document.getElementById(magClearId);
    if (!toggleBtn || !panel) return;

    const allChipSelectors = [chipSelector, ...linkedChipSelectors];
    const allMagInputIds = [magInputId, ...linkedMagInputIds];

    toggleBtn.addEventListener('click', () => {
      panel.classList.toggle('hidden');
      toggleBtn.classList.toggle('active', !panel.classList.contains('hidden'));
    });

    document.querySelectorAll(chipSelector).forEach((chip) => {
      chip.addEventListener('click', () => {
        filterState.cat = chip.dataset.cat;
        allChipSelectors.forEach((sel) => {
          document.querySelectorAll(sel).forEach((c) => c.classList.toggle('active', c.dataset.cat === filterState.cat));
        });
        onChange();
      });
    });

    if (magInput) {
      magInput.addEventListener('input', () => {
        const v = parseFloat(magInput.value);
        filterState.maxMag = magInput.value === '' || isNaN(v) ? null : v;
        allMagInputIds.forEach((id) => {
          if (id === magInputId) return;
          const el = document.getElementById(id);
          if (el) el.value = magInput.value;
        });
        onChange();
      });
    }
    if (magClear) {
      magClear.addEventListener('click', () => {
        filterState.maxMag = null;
        allMagInputIds.forEach((id) => {
          const el = document.getElementById(id);
          if (el) el.value = '';
        });
        onChange();
      });
    }
  }

  function updateFilterCount(countId, total, shown) {
    const el = document.getElementById(countId);
    if (!el) return;
    el.textContent = (total === shown)
      ? `${total} objet${total > 1 ? 's' : ''}`
      : `${shown} / ${total} objet${total > 1 ? 's' : ''} affiché${shown > 1 ? 's' : ''}`;
  }

  const AGENDA_DAYS = 30;
  const AGENDA_DAYS_BACKWARD = 60;

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
  let geoUnavailable = false; // true si le GPS est refusé/indisponible : désactive l'option "auto"

  const today0 = new Date();
  today0.setHours(0, 0, 0, 0);
  const agendaLastDay = new Date(today0);
  agendaLastDay.setDate(agendaLastDay.getDate() + AGENDA_DAYS - 1);
  let agendaViewMonth = new Date(today0.getFullYear(), today0.getMonth(), 1);
  let agendaFavCounts = {}; // { 'YYYY-MM-DD': nombre d'objets favoris visibles ce soir-là }
  let journalEntries = [];
  let journalDatesSet = new Set(); // dates (YYYY-MM-DD) ayant au moins une entrée de journal

  const agendaFirstDay = new Date(today0); // NOUVEAU
  agendaFirstDay.setDate(agendaFirstDay.getDate() - AGENDA_DAYS_BACKWARD);

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

  // Écran de chargement : au lieu d'une barre de progression en %, on
  // affiche une série de points, un par étape (paramètres, position, ciel,
  // bibliothèque, statistiques, agenda, plans, journal), plus un dernier
  // point pour l'étape finale "tout est prêt" affichée brièvement avant
  // l'ouverture de l'app.
  const LOAD_STEPS = [
    'Paramètres',
    'Position',
    'Ciel',
    'Bibliothèque',
    'Statistiques',
    'Agenda',
    'Plans',
    'Journal',
    'Prêt',
  ];
  const stepDotsEl = document.getElementById('stepDots');

  function renderStepDots() {
    if (!stepDotsEl || stepDotsEl.childElementCount === LOAD_STEPS.length) return;
    stepDotsEl.innerHTML = LOAD_STEPS
      .map((label, i) => `<div class="step-dot" data-step="${i}" title="${label}"></div>`)
      .join('');
  }

  // Marque les points précédant `index` comme "faits", le point `index`
  // comme actif (ou comme "succès" si opts.success est vrai, pour l'étape
  // finale).
  function setStep(index, opts = {}) {
    if (!stepDotsEl) return;
    renderStepDots();
    const dots = stepDotsEl.querySelectorAll('.step-dot');
    dots.forEach((dot, i) => {
      dot.classList.remove('active', 'done', 'success');
      if (i < index) dot.classList.add('done');
      else if (i === index) dot.classList.add(opts.success ? 'success' : 'active');
    });
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
    confirmPanel.classList.add('hidden');
    mainContent.classList.remove('hidden');
    bottomNav.classList.remove('hidden');
    // #app est révélé ici (et non via un setTimeout indépendant en bas de
    // fichier) pour que les mesures de layout faites juste après
    // (computeFitZoom) portent sur un DOM réellement visible : sinon
    // offsetHeight/getBoundingClientRect renvoient des valeurs fausses
    // (0, ou héritées d'un état display:none), ce qui faussait le zoom
    // "auto" et faisait apparaître le coucher de soleil très bas dans la
    // timeline au chargement.
    
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
    document.getElementById('tlHours').style.display = 'none';
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
    document.getElementById('tlHours').style.display = 'flex';
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
      geoUnavailable = true;
      updateLocAutoAvailability();
      renderNoLocation('La géolocalisation n\u2019est pas supportée par ce navigateur. Définis ta position manuellement dans Paramètres.');
      return;
    }

    navigator.geolocation.getCurrentPosition(
      (pos) => {
        geoUnavailable = false;
        updateLocAutoAvailability();
        const { latitude, longitude, altitude } = pos.coords;
        currentLat = latitude;
        currentLon = longitude;
        currentElev = altitude || 0;
        locLine.textContent = `${latitude.toFixed(3)}°, ${longitude.toFixed(3)}°`;
        updateLocCurrentLine();
        fetchSky(currentLat, currentLon, currentElev);
      },
      () => {
        geoUnavailable = true;
        updateLocAutoAvailability();
        currentLat = null;
        currentLon = null;
        renderNoLocation('Localisation refusée ou indisponible. Active le GPS ou définis ta position manuellement dans Paramètres.');
      },
      { enableHighAccuracy: true, timeout: 15000 }
    );
  }
  function updateLocAutoAvailability() {
    if (!locAutoToggle) return;
    locAutoToggle.disabled = geoUnavailable;
    if (geoUnavailable) {
      // GPS refusé/indisponible : on empêche de re-sélectionner "auto" et on
      // force l'affichage du bloc manuel tant qu'aucune position valide
      // n'est renvoyée par le navigateur.
      locAutoToggle.checked = false;
      locManualBlock.classList.remove('hidden');
      locAutoHint.textContent = 'Localisation GPS refusée ou indisponible. Définis ta position manuellement ci-dessous.';
    }
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

      if (!navigator.geolocation) {
        geoUnavailable = true;
        resolve(null);
        return;
      }

      navigator.geolocation.getCurrentPosition(
        (pos) => {
          geoUnavailable = false;
          const { latitude, longitude, altitude } = pos.coords;
          resolve({ lat: latitude, lon: longitude, elev: altitude || 0 });
        },
        () => {
          geoUnavailable = true;
          resolve(null);
        },
        { enableHighAccuracy: true, timeout: 15000 }
      );
    });
  }

  function buildSkyUrl(lat, lon, elev, dateStr, settingsOverride) {
    const mode = settingsOverride
      ? (settingsOverride.pref_mode === 'fixed' ? 'fixed' : 'margin')
      : getObsMode();
    const margin = settingsOverride
      ? ((settingsOverride.pref_margin !== null && settingsOverride.pref_margin !== undefined)
          ? parseInt(settingsOverride.pref_margin, 10) : 30)
      : getObsMargin();
    const fixedStartStr = settingsOverride ? (settingsOverride.pref_fixed_start || '20:00') : getFixedStart();
    const fixedEndStr = settingsOverride ? (settingsOverride.pref_fixed_end || '06:00') : getFixedEnd();
    const minAlt = settingsOverride
      ? ((settingsOverride.pref_min_alt !== null && settingsOverride.pref_min_alt !== undefined)
          ? parseFloat(settingsOverride.pref_min_alt) : 10)
      : getMinAlt();

    // Construction des dates exactes dans le fuseau local si on est en mode 'fixed'
    let dateToUse = new Date();
    if (dateStr) {
      const parts = dateStr.split('-');
      dateToUse = new Date(parts[0], parts[1] - 1, parts[2]);
    }

    let startFixed = new Date(dateToUse);
    const startStr = fixedStartStr.split(':');
    startFixed.setHours(parseInt(startStr[0], 10), parseInt(startStr[1], 10), 0, 0);

    let endFixed = new Date(dateToUse);
    const endStr = fixedEndStr.split(':');
    endFixed.setHours(parseInt(endStr[0], 10), parseInt(endStr[1], 10), 0, 0);

    // Si l'heure de fin est inférieure ou égale à l'heure de début (ex: 20h -> 6h),
    // on comprend que la fin se trouve le jour suivant.
    if (endFixed <= startFixed) {
      endFixed.setDate(endFixed.getDate() + 1);
    }

    let url = `/api/sky?lat=${lat}&lon=${lon}&elev=${elev}&mode=${mode}&margin=${margin}&min_alt=${minAlt}`; // NOUVEAU (ajout de &min_alt)
    url += `&fixed_start=${startFixed.toISOString()}&fixed_end=${endFixed.toISOString()}`;
    if (dateStr) url += `&date=${dateStr}`;
    return url;
  }

  async function fetchSky(lat, lon, elev, dateStr) {
    try {
      const url = buildSkyUrl(lat, lon, elev, dateStr);
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
    renderOverviewFavorites();

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

  function renderTimeline(data, recomputeZoom = true) {
    const hours = document.getElementById('tlHours');
    const lanesScroll = document.getElementById('tlLanesScroll');
    const lanes = document.getElementById('tlLanes');
    const wrap = document.getElementById('tlWrap');
    hours.innerHTML = '';
    lanes.innerHTML = '';

    // On ne recalcule le zoom "fit" que sur les actions qui doivent
    // vraiment le déclencher (chargement, resize, bouton fit...), pas sur
    // un simple changement de filtre : sinon, ouvrir/fermer le panneau de
    // filtre (qui déplace tlWrap) ou taper une magnitude faisait "sauter"
    // le zoom à chaque frappe/clic.
    if (zoomMode === 'auto' && recomputeZoom) {
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

    const visibleObjects = filterObjects(data.objects, tlFilterState);
    updateFilterCount('tlFilterCount', data.objects.length, visibleObjects.length);

    const { laneOf, laneCount: computedLaneCount } = assignLanesClient(visibleObjects);
    const laneCount = Math.max(computedLaneCount, 1);
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

    visibleObjects.forEach((o) => {
      const lane = laneOf.get(o);
      const rise = new Date(o.rise_iso).getTime();
      const set = new Date(o.set_iso).getTime();
      const topPx = ((rise - start) / 60000) * pxPerMin;
      const heightPx = Math.max(((set - rise) / 60000) * pxPerMin, 22);

      const fav = isFavorite(o.name);
      const block = document.createElement('div');
      block.className = 'block' + (narrow ? ' block-narrow' : '') + (fav ? ' block-favorite' : '');
      block.style.top = `${topPx}px`;
      block.style.height = `${heightPx}px`;
      block.style.left = `${lane * laneWidth + 2}px`;
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
    if (zoomMode !== 'auto') return;
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
    zoomMode = 'auto';
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

  // Recalcule aussi la hauteur du panneau agenda (jour sélectionné) au
  // redimensionnement / rotation d'écran.
  window.addEventListener('resize', () => requestAnimationFrame(sizeAgendaDayPanel));

  window.addEventListener('resize', () => {
    if (agendaZoomMode !== 'auto' || !agendaTtData || document.getElementById('agendaTimetableView').classList.contains('hidden')) return;
    clearTimeout(agendaResizeTimer);
    agendaResizeTimer = setTimeout(() => {
      renderAgendaTimeline(agendaTtData);
      positionAgendaNowLine(agendaTtData);
      positionAgendaSunLines(agendaTtData);
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

  function renderSchedule(data, bodyId = 'scheduleBody') {
    const body = document.getElementById(bodyId);
    if (!body) return;
    body.innerHTML = '';

    const visibleObjects = filterObjects(data.objects, tlFilterState);
    updateFilterCount('scheduleFilterCount', data.objects.length, visibleObjects.length);

    visibleObjects.forEach((o) => {
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
  let currentWikiInfo = null; // { name, title, image, description, wiki_url }

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

  // `ctx` permet de calculer la phase pour un contexte différent
  // d'"ici et maintenant" : { dateStr, lat, lon, elev }. Utilisé quand
  // l'objet est ouvert depuis l'agenda (nuit future précise) ou depuis un
  // plan prévu à l'avance (date, et éventuellement lieu manuel, différents
  // d'aujourd'hui). Les champs non fournis retombent sur "maintenant" /
  // le lieu courant de l'app.
  async function fetchPhaseInfo(o, ctx) {
  try {
    let url = `/api/phase?name=${encodeURIComponent(o.name)}`;
    if (ctx && ctx.dateStr) url += `&date=${ctx.dateStr}`;
    if (o.category === 'planet') {
      const lat = (ctx && ctx.lat !== undefined && ctx.lat !== null) ? ctx.lat : currentLat;
      const lon = (ctx && ctx.lon !== undefined && ctx.lon !== null) ? ctx.lon : currentLon;
      const elev = (ctx && ctx.elev !== undefined && ctx.elev !== null) ? ctx.elev : currentElev;
      if (lat === null || lon === null) return null;
      url += `&lat=${lat}&lon=${lon}&elev=${elev}`;
    }
    const res = await fetch(url);
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    return null;
  }
}

// Construit le path SVG de la partie éclairée d'un disque (lune/planète)
// à partir de la fraction illuminée (0..1) et du sens (croissant/décroissant).
// waxing=true -> partie éclairée à droite ; waxing=false -> à gauche.
function buildPhaseDiscPath(k, waxing, cx, cy, r) {
  k = Math.max(0, Math.min(1, k));
  const rx = r * Math.abs(1 - 2 * k);
  const top = `${cx},${cy - r}`;
  const bottom = `${cx},${cy + r}`;
  let semiSweep, ellSweep;
  if (waxing) {
    semiSweep = 1;
    ellSweep = k < 0.5 ? 0 : 1;
  } else {
    semiSweep = 0;
    ellSweep = k < 0.5 ? 1 : 0;
  }
  return `M ${top} A ${r},${r} 0 0,${semiSweep} ${bottom} A ${rx},${r} 0 0,${ellSweep} ${top} Z`;
}

function renderPhaseDisc(illuminationPct, waxing) {
  const svg = document.getElementById('infoPhaseDisc');
  if (!svg) return;
  const cx = 50, cy = 50, r = 46;
  const k = (illuminationPct || 0) / 100;
  // Sens par défaut (croissant) si inconnu (certaines planètes n'exposent
  // pas toujours l'info) : purement illustratif dans ce cas.
  const isWaxing = (waxing === null || waxing === undefined) ? true : !!waxing;
  const litPath = buildPhaseDiscPath(k, isWaxing, cx, cy, r);
  svg.innerHTML = `
    <circle class="phase-dark" cx="${cx}" cy="${cy}" r="${r}"></circle>
    <path class="phase-lit" d="${litPath}"></path>
    <circle class="phase-outline" cx="${cx}" cy="${cy}" r="${r}"></circle>
  `;
}

function renderInfoPhase(data) {
  const wrap = document.getElementById('infoPhase');
  const illumEl = document.getElementById('infoPhaseIllum');
  const nameEl = document.getElementById('infoPhaseName');
  const detailsEl = document.getElementById('infoPhaseDetails');
  if (!wrap) return;
  if (!data) { wrap.classList.add('hidden'); return; }

  illumEl.textContent = `${data.illumination}%`;
  renderPhaseDisc(data.illumination, data.waxing);

  if (data.kind === 'moon') {
    nameEl.textContent = data.phase_name;
    const trend = data.waxing ? 'Croissante' : 'Décroissante';
    detailsEl.innerHTML = `
      <span>${trend}</span>
      <span>Âge : ${data.age_days} j</span>
      <span>Pleine lune dans ${data.days_to_full_moon} j</span>
      <span>Nouvelle lune dans ${data.days_to_new_moon} j</span>
      <span>Cycle synodique : ${data.synodic_month_days} j</span>
    `;
  } else {
    nameEl.textContent = 'Phase';
    const trendHtml = (data.waxing === null || data.waxing === undefined)
      ? ''
      : `<span>${data.waxing ? 'Croissante' : 'Décroissante'}</span>`;
    detailsEl.innerHTML = `
      ${trendHtml}
      <span>Angle de phase : ${data.phase_angle_deg}°</span>
      <span>Distance Terre : ${data.distance_earth_au} UA</span>
      <span>Distance Soleil : ${data.distance_sun_au} UA</span>
    `;
  }
  wrap.classList.remove('hidden');
}


  function renderInfoWiki(data, objectName) {
    const wrap = document.getElementById('infoWiki');
    const img = document.getElementById('infoWikiImg');
    const desc = document.getElementById('infoWikiDesc');
    if (!wrap || !img || !desc) return;

    currentWikiInfo = data ? { ...data, name: objectName } : null;

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

  // Ouvre une fiche détaillée (titre + lien Wikipedia) quand on clique sur
  // l'image miniature de la popup info.
  function openWikiDetail() {
    if (!currentWikiInfo) return;
    const titleEl = document.getElementById('wikiDetailTitle');
    const imgEl = document.getElementById('wikiDetailImg');
    const linkEl = document.getElementById('wikiDetailLink');

    titleEl.textContent = currentWikiInfo.title || currentWikiInfo.name || '—';

    if (currentWikiInfo.image) {
      imgEl.src = currentWikiInfo.image;
      imgEl.classList.remove('hidden');
    } else {
      imgEl.removeAttribute('src');
      imgEl.classList.add('hidden');
    }

    if (currentWikiInfo.wiki_url) {
      linkEl.href = currentWikiInfo.wiki_url;
      linkEl.classList.remove('hidden');
    } else {
      linkEl.href = '#';
      linkEl.classList.add('hidden');
    }

    document.getElementById('wikiDetailOverlay').classList.remove('hidden');
  }

  function closeWikiDetail() {
    document.getElementById('wikiDetailOverlay').classList.add('hidden');
  }

  document.getElementById('infoWikiImgBtn').addEventListener('click', openWikiDetail);
  document.getElementById('wikiDetailClose').addEventListener('click', closeWikiDetail);
  document.getElementById('wikiDetailOverlay').addEventListener('click', (e) => {
    if (e.target.id === 'wikiDetailOverlay') closeWikiDetail();
  });

  function openInfo(o, ctx) {
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
    currentWikiInfo = null;
    const wikiRequestName = o.name;
    fetchObjectInfo(wikiRequestName).then((data) => {
      if (infoObj && infoObj.name === wikiRequestName) renderInfoWiki(data, wikiRequestName);
    });

    const infoPhaseEl = document.getElementById('infoPhase');
    if (infoPhaseEl) infoPhaseEl.classList.add('hidden');
    if (o.category === 'moon' || o.category === 'planet') {
      const phaseRequestName = o.name;
      fetchPhaseInfo(o, ctx).then((data) => {
        if (infoObj && infoObj.name === phaseRequestName) renderInfoPhase(data);
      });
    }

    const color = o.color || CATEGORY_COLOR_VAR[o.category] || 'var(--text-muted)';
    document.getElementById('infoDot').style.background = color;
    document.getElementById('infoDot').style.color = color;
    document.getElementById('infoName').textContent = o.name;
    document.getElementById('infoCategory').textContent = CATEGORY_LABEL[o.category] || capitalize(o.category);

    const isSun = o.category === 'sun';
    const sunWarningEl = document.getElementById('infoSunWarning');
    if (sunWarningEl) sunWarningEl.classList.toggle('hidden', !isSun);
    const infoFavBtnEl = document.getElementById('infoFavBtn');
    if (infoFavBtnEl) infoFavBtnEl.classList.toggle('hidden', isSun);
    if (!isSun) updateInfoFavBtn();

    const infoJournalBtnEl = document.getElementById('infoJournalBtn');
    if (infoJournalBtnEl) {
      infoJournalBtnEl.classList.remove('journal-added');
      infoJournalBtnEl.classList.toggle('hidden', isSun || !o.up_now);
    }

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

    // Dans « Prévoir » (et l'agenda), la fiche objet peut concerner une nuit
    // future : le compte à rebours (calculé sur l'heure réelle "maintenant")
    // n'a de sens que si la nuit affichée est bien celle d'aujourd'hui.
    // ctx.dateStr indique la date du contexte (plan/agenda) ; son absence
    // signifie qu'on est dans un contexte "ici et maintenant" (donc déjà
    // aujourd'hui).
    const isTodayCtx = !ctx || !ctx.dateStr || ctx.dateStr === toDateStr(new Date());
    const allowedCountdownViews = ['overview', 'timeline', 'schedule', 'library', 'plan', 'agenda'];
    if (!allowedCountdownViews.includes(currentView) || !isTodayCtx) {
      countdownCell.classList.add('hidden');
    }

    document.getElementById('infoOverlay').classList.remove('hidden');
  }

  function closeInfo() {
    document.getElementById('infoOverlay').classList.add('hidden');
    if (infoCountdownTimer) { clearInterval(infoCountdownTimer); infoCountdownTimer = null; }
    infoObj = null;
    closeWikiDetail();
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

  const infoJournalChoiceOverlay = document.getElementById('infoJournalChoiceOverlay');

  function openInfoJournalChoice() {
    if (!infoObj || !infoJournalChoiceOverlay) return;
    infoJournalChoiceOverlay.classList.remove('hidden');
  }

  function closeInfoJournalChoice() {
    if (infoJournalChoiceOverlay) infoJournalChoiceOverlay.classList.add('hidden');
  }

  async function submitInfoJournalChoice(status) {
    if (!infoObj) return;
    const btn = document.getElementById('infoJournalBtn');
    const now = new Date();
    try {
      await addJournalEntry({
        name: infoObj.name,
        category: infoObj.category,
        status,
        date: toDateStr(now),
        time: `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`,
      });
      closeInfoJournalChoice();
      btn.classList.add('journal-added');
      const icon = btn.querySelector('i');
      if (icon) icon.className = 'bx bx-check';
      setTimeout(() => {
        if (icon) icon.className = 'bx bx-book-content';
        btn.classList.remove('journal-added');
      }, 1500);
    } catch (e) {
      // best effort
    }
  }

  document.getElementById('infoJournalBtn').addEventListener('click', () => {
    openInfoJournalChoice();
  });
  document.getElementById('infoJournalChoiceClose').addEventListener('click', closeInfoJournalChoice);
  infoJournalChoiceOverlay.addEventListener('click', (e) => {
    if (e.target.id === 'infoJournalChoiceOverlay') closeInfoJournalChoice();
  });
  document.getElementById('infoJournalChoiceSeen').addEventListener('click', () => submitInfoJournalChoice('seen'));
  document.getElementById('infoJournalChoiceFailed').addEventListener('click', () => submitInfoJournalChoice('failed'));

  document.getElementById('infoClose').addEventListener('click', closeInfo);
  document.getElementById('infoOverlay').addEventListener('click', (e) => {
    if (e.target.id === 'infoOverlay') closeInfo();
  });

  let currentView = 'timeline';
  function discardSettingsChanges() {
    loadPreferences();
    loadLocationPreferences();
    applyRedFilter(!!settingsCache.red_filter);
    clearSettingsDirty();
  }

  function switchView(name) {
    if (currentView === 'settings' && name !== 'settings' && settingsSaveBar && !settingsSaveBar.classList.contains('hidden')) {
      discardSettingsChanges();
    }

    currentView = name;
    document.querySelectorAll('.view').forEach((v) => v.classList.add('hidden'));
    document.getElementById(`view-${name}`).classList.remove('hidden');
    document.querySelectorAll('.nav-btn[data-view]').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
    if (menuNavBtn) menuNavBtn.classList.toggle('active', ['agenda', 'plan', 'tools', 'journal'].includes(name));
    if (name === 'timeline' && currentData) {
      renderTimeline(currentData);
      positionNowLine(currentData);
      resetZoomToFit();
    }
    if (name === 'library') {
      initLibraryView();
    } else if (name === 'overview') {
      renderOverviewFavorites();
    } else if (name === 'agenda') {
      requestAnimationFrame(sizeAgendaDayPanel);
    } else if (name === 'journal') {
      renderJournalList();
    }  else if (name === 'plan') {
      planInitialized = true;
      showPlanListView();
    } 
    if (name !== 'tools') {
      stopActiveTool();
    }
  }

  document.querySelectorAll('.nav-btn[data-view]').forEach((btn) => {
    btn.addEventListener('click', () => switchView(btn.dataset.view));
  });

  // ---------- Side menu (drawer gauche : Agenda / Prévoir / Tools) ----------
  const sideMenuOverlay = document.getElementById('sideMenuOverlay');
  const menuNavBtn = document.getElementById('menuNavBtn');
  const sideMenuClose = document.getElementById('sideMenuClose');

  function openSideMenu() {
    if (!sideMenuOverlay) return;
    document.querySelectorAll('#sideMenu .side-menu-item').forEach((b) => {
      b.classList.toggle('active', b.dataset.view === currentView);
    });
    sideMenuOverlay.classList.remove('hidden');
  }
  function closeSideMenu() {
    if (sideMenuOverlay) sideMenuOverlay.classList.add('hidden');
  }

  if (menuNavBtn) menuNavBtn.addEventListener('click', openSideMenu);
  if (sideMenuClose) sideMenuClose.addEventListener('click', closeSideMenu);
  if (sideMenuOverlay) {
    sideMenuOverlay.addEventListener('click', (e) => {
      if (e.target.id === 'sideMenuOverlay') closeSideMenu();
    });
  }
  document.querySelectorAll('#sideMenu .side-menu-item').forEach((btn) => {
    btn.addEventListener('click', () => {
      switchView(btn.dataset.view);
      closeSideMenu();
    });
  });

  retryBtn.addEventListener('click', resolveLocation);

  wireFilterPanel({
    toggleBtnId: 'tlFilterBtn',
    panelId: 'tlFilterPanel',
    chipSelector: '.tl-filter-chip',
    magInputId: 'tlFilterMag',
    magClearId: 'tlFilterMagClear',
    countId: 'tlFilterCount',
    filterState: tlFilterState,
    onChange: refreshSharedFilterViews,
    linkedChipSelectors: ['.schedule-filter-chip'],
    linkedMagInputIds: ['scheduleFilterMag'],
  });

  wireFilterPanel({
    toggleBtnId: 'agendaFilterBtn',
    panelId: 'agendaFilterPanel',
    chipSelector: '.agenda-filter-chip',
    magInputId: 'agendaFilterMag',
    magClearId: 'agendaFilterMagClear',
    countId: 'agendaFilterCount',
    filterState: agendaFilterState,
    onChange: () => { if (agendaTtData) renderAgendaTimeline(agendaTtData, false); },
  });

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
      const inRange = d >= agendaFirstDay && d <= agendaLastDay;
      const isToday = d.getTime() === today0.getTime();

      const cell = document.createElement('button');
      cell.type = 'button';
      cell.className = 'cal-day';
      if (!inMonth) cell.classList.add('cal-day-outside');
      if (isToday) cell.classList.add('cal-day-today');
      if (inRange) cell.classList.add('cal-day-selectable');
      else cell.disabled = true;
      if (agendaPreviewDate && agendaPreviewDate.dateStr === dateStr) cell.classList.add('cal-day-selected');

      const favCount = agendaFavCounts[dateStr] || 0;
      const favBadge = favCount > 0
        ? `<span class="cal-day-fav"><i class='bx bxs-star'></i>${favCount}</span>`
        : '';
      const hasPlan = !!planDatesWithPlan[dateStr];
      const dotClass = hasPlan ? 'cal-day-dot cal-day-dot-plan' : 'cal-day-dot';
      const isPast = d < today0;
      const hasJournal = isPast && journalDatesSet.has(dateStr);
      const planDotHtml = inRange ? `<span class="${dotClass}"></span>` : '';
      const journalDotHtml = hasJournal ? '<span class="cal-day-dot cal-day-journal-dot" title="Observations enregistrées"></span>' : '';
      const dotsHtml = (planDotHtml || journalDotHtml)
        ? `<span class="cal-day-dots">${planDotHtml}${journalDotHtml}</span>`
        : '';

      cell.innerHTML = `<span class="cal-day-num">${d.getDate()}</span>${favBadge}${dotsHtml}`;
      if (inRange) cell.addEventListener('click', () => openAgendaDay(dateStr, d));
      grid.appendChild(cell);
    }

    document.getElementById('agendaPrevMonth').disabled =
  agendaViewMonth.getFullYear() === agendaFirstDay.getFullYear() &&
  agendaViewMonth.getMonth() === agendaFirstDay.getMonth();
  }

  document.getElementById('agendaPrevMonth').addEventListener('click', () => {
    agendaViewMonth = new Date(agendaViewMonth.getFullYear(), agendaViewMonth.getMonth() - 1, 1);
    renderAgendaCalendar();
  });
  document.getElementById('agendaNextMonth').addEventListener('click', () => {
    agendaViewMonth = new Date(agendaViewMonth.getFullYear(), agendaViewMonth.getMonth() + 1, 1);
    renderAgendaCalendar();
  });

  // ---------- Agenda : panneau intégré (plus de popup) ----------
  // agendaPreviewDate garde en mémoire le jour actuellement affiché dans
  // le panneau ("agendaDayPanel"), qui vit directement sous le calendrier
  // et remplit l'espace jusqu'à la bottom nav (voir sizeAgendaDayPanel).
  let agendaPreviewDate = null; // { dateStr, dateObj }

  function sizeAgendaDayPanel() {
    const panel = document.getElementById('agendaDayPanel');
    const view = document.getElementById('view-agenda');
    if (!panel || !view || view.classList.contains('hidden')) return;
    const navH = bottomNav ? bottomNav.offsetHeight : 0;
    const top = panel.getBoundingClientRect().top;
    const buffer = 20;
    const available = Math.max(window.innerHeight - top - navH - buffer, 160);
    panel.style.height = `${available}px`;
  }

  function openAgendaDay(dateStr, dateObj) {
    if (currentLat === null || currentLon === null) return;
    agendaPreviewDate = { dateStr, dateObj };
    renderAgendaCalendar(); // pour surligner le jour sélectionné
    showAgendaDayPreview(dateStr, dateObj);
    requestAnimationFrame(sizeAgendaDayPanel);
  }

  async function showAgendaDayPreview(dateStr, dateObj) {
    const listEl = document.getElementById('agendaDayFavList');
    const titleEl = document.getElementById('agendaDayTitle');
    const closeBtn = document.getElementById('agendaDayClose');
    const openBtn = document.getElementById('agendaDayOpenBtn');

    titleEl.textContent = dateObj.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
    closeBtn.classList.remove('hidden');
    const isPast = dateObj < today0;
  openBtn.classList.toggle('hidden', isPast);

  const planBtn = document.getElementById('agendaDayPlanBtn');
  if (planBtn) {
    const hasPlan = !!planDatesWithPlan[dateStr];
    planBtn.classList.toggle('hidden', !hasPlan);
    planBtn.onclick = () => {
      switchView('plan');
      showPlanEditorView(dateStr);
    };
    }
    listEl.innerHTML = loadingBlockHtml('Chargement…');

    // Observations du journal pour ce jour (déjà en mémoire, pas de fetch)
    const dayJournalEntries = journalEntries.filter((e) => e.date === dateStr);
    const journalHtml = dayJournalEntries.length
      ? `<div class="section-heading" style="margin:0 0 8px;"><h2 style="font-size:15px;">Observations</h2></div>` +
        dayJournalEntries.map((e) => {
          const color = CATEGORY_COLOR_VAR[e.category] || 'var(--text-muted)';
          const statusLabel = e.status === 'failed' ? 'Échec' : 'Vu';
          const statusClass = e.status === 'failed' ? 'journal-row-status-failed' : 'journal-row-status-seen';
          const when = e.time ? e.time : '';
          return `
            <div class="agenda-fav-row">
              <span class="agenda-fav-dot" style="background:${color}"></span>
              <span class="agenda-fav-name">${e.object_name}</span>
              ${when ? `<span class="agenda-fav-time">${when}</span>` : ''}
              <span class="journal-row-status ${statusClass}">${statusLabel}</span>
            </div>
          `;
        }).join('')
      : '';

    try {
      const url = buildSkyUrl(currentLat, currentLon, currentElev, dateStr);
      const res = await fetch(url);
      if (!res.ok) throw new Error();
      const data = await res.json();

      if (!agendaPreviewDate || agendaPreviewDate.dateStr !== dateStr) return;

      const favs = (data.objects || []).filter((o) => o.favorite);
      const favsHtml = favs.length
        ? `<div class="section-heading" style="margin:${journalHtml ? '14px' : '0'} 0 8px;"><h2 style="font-size:15px;">Favoris visibles</h2></div>` +
          favs.map((o) => `
            <div class="agenda-fav-row">
              <span class="agenda-fav-dot" style="background:${o.color}"></span>
              <span class="agenda-fav-name">${o.name}</span>
              <span class="agenda-fav-time">${fmtTime(o.rise_iso)}\u2013${fmtTime(o.set_iso)}</span>
            </div>
          `).join('')
        : (journalHtml ? '' : '<div class="lib-empty">Aucun favori visible cette nuit-là.</div>');

      listEl.innerHTML = (journalHtml + favsHtml) || '<div class="lib-empty">Rien à afficher pour cette nuit.</div>';
    } catch (e) {
      if (agendaPreviewDate && agendaPreviewDate.dateStr === dateStr) {
        listEl.innerHTML = journalHtml || '<div class="lib-empty">Impossible de charger les favoris.</div>';
      }
    }
  }

  function agendaEmptyStateHtml() {
  return `<div class="locked-state">
    <p>Sélectionne un jour dans le calendrier pour voir les favoris visibles cette nuit-là.</p>
    <div class="cal-legend">
      <div class="cal-legend-item"><span class="cal-legend-dot cal-day-dot-plan"></span>Plan enregistré</div>
      <div class="cal-legend-item"><span class="cal-legend-dot cal-day-journal-dot"></span>Observations enregistrées</div>
      <div class="cal-legend-item"><span class="cal-legend-star"><i class='bx bxs-star'></i></span>Favoris visibles cette nuit-là</div>
    </div>
  </div>`;
}

function closeAgendaDayPreview() {
  agendaPreviewDate = null;
  document.getElementById('agendaDayTitle').textContent = 'Sélectionne une nuit';
  document.getElementById('agendaDayClose').classList.add('hidden');
  document.getElementById('agendaDayOpenBtn').classList.add('hidden');
  const planBtn = document.getElementById('agendaDayPlanBtn');
  if (planBtn) { planBtn.classList.add('hidden'); planBtn.onclick = null; }
  document.getElementById('agendaDayFavList').innerHTML = agendaEmptyStateHtml(); // <-- changé
  renderAgendaCalendar();
}

  document.getElementById('agendaDayClose').addEventListener('click', closeAgendaDayPreview);

  // ---------- Agenda : timetable intégrée (remplace le contenu de l'agenda) ----------
  // Contrairement à l'ancien comportement (qui quittait l'agenda pour la vue
  // "timeline"), "Ouvrir cette nuit" affiche désormais une timetable
  // directement dans l'onglet Agenda, avec navigation jour précédent/suivant
  // et un bouton fermer qui revient au calendrier.
  let agendaTtDateObj = null; // Date actuellement affichée dans la timetable

  document.getElementById('agendaDayOpenBtn').addEventListener('click', () => {
    if (!agendaPreviewDate) return;
    // Ouvrir la nuit "en cours" (aujourd'hui) depuis l'agenda redirige vers
    // la Timeline principale plutôt que d'ouvrir une timetable dédiée dans
    // l'agenda, qui ferait doublon avec l'onglet Timeline.
    if (agendaPreviewDate.dateStr === toDateStr(today0)) {
      switchView('timeline');
      return;
    }
    openAgendaTimetable(agendaPreviewDate.dateObj);
  });
  function openAgendaTimetable(dateObj) {
    agendaTtDateObj = new Date(dateObj);
    document.getElementById('agendaMainView').classList.add('hidden');
    document.getElementById('agendaTimetableView').classList.remove('hidden');
    loadAgendaTimetable();
  }

  function closeAgendaTimetable() {
    agendaTtDateObj = null;
    hideAgendaTtLoading();
    document.getElementById('agendaTimetableView').classList.add('hidden');
    document.getElementById('agendaMainView').classList.remove('hidden');
  }

  let agendaTtData = null; // dernières données chargées pour la timeline agenda
  let agendaZoomMode = 'auto';
  let agendaZoomLevel = 1;
  let agendaResizeTimer = null;

  // Overlay de chargement plein écran pour la timetable agenda : couvre
  // tout l'espace entre la topbar et la bottom nav (les deux seules zones
  // qui doivent rester visibles), centré horizontalement et verticalement.
  function positionAgendaTtLoadingOverlay() {
    const overlay = document.getElementById('agendaTtLoadingOverlay');
    if (!overlay) return;
    const topbar = document.querySelector('.topbar');
    const topbarH = topbar ? topbar.offsetHeight : 0;
    const navH = bottomNav ? bottomNav.offsetHeight : 0;
    overlay.style.top = `${topbarH}px`;
    overlay.style.bottom = `${navH}px`;
  }

  function showAgendaTtLoading(msg) {
    const overlay = document.getElementById('agendaTtLoadingOverlay');
    const text = document.getElementById('agendaTtLoadingText');
    if (!overlay) return;
    if (text && msg) text.textContent = msg;
    positionAgendaTtLoadingOverlay();
    overlay.classList.remove('hidden');
  }

  function hideAgendaTtLoading() {
    const overlay = document.getElementById('agendaTtLoadingOverlay');
    if (overlay) overlay.classList.add('hidden');
  }

  window.addEventListener('resize', () => {
    const overlay = document.getElementById('agendaTtLoadingOverlay');
    if (overlay && !overlay.classList.contains('hidden')) positionAgendaTtLoadingOverlay();
  });

  async function loadAgendaTimetable() {
    if (!agendaTtDateObj) return;
    const dateObj = agendaTtDateObj;
    const dateStr = toDateStr(dateObj);
    const dateLabel = document.getElementById('agendaTtDate');
    const hours = document.getElementById('agendaTlHours');
    const wrap = document.getElementById('agendaTlWrap');
    const lanes = document.getElementById('agendaTlLanes');

    dateLabel.textContent = dateObj.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
    document.getElementById('agendaTtPrev').disabled = dateObj <= today0;

    // Reset complet avant d'afficher le loader : sinon la hauteur, le fond
    // en grille et les lignes sunset/sunrise/now de la nuit précédente
    // restent affichés pendant le chargement. Le loader plein écran (overlay
    // fixe, centré, entre topbar et bottom nav) masque tout le reste de la
    // vue (header de date, filtres, timeline) pendant le chargement.
    hours.innerHTML = '';
    wrap.style.height = '220px';
    lanes.style.height = '220px';
    lanes.style.backgroundImage = 'none';
    lanes.innerHTML = '';
    ['agendaSunsetLine', 'agendaSunriseLine', 'agendaNowLine'].forEach((id) => {
      document.getElementById(id).style.display = 'none';
    });
    showAgendaTtLoading('Chargement du programme…');

    try {
      const url = buildSkyUrl(currentLat, currentLon, currentElev, dateStr);
      const res = await fetch(url);
      if (!res.ok) throw new Error();
      const data = await res.json();

      if (!agendaTtDateObj || toDateStr(agendaTtDateObj) !== dateStr) return;

      agendaTtData = data;
      hideAgendaTtLoading();
      if ((data.objects || []).length === 0) {
        lanes.innerHTML = '<div class="lib-empty">Aucun objet visible cette nuit-là.</div>';
      } else {
        agendaZoomMode = 'auto';
        renderAgendaTimeline(data);
        positionAgendaNowLine(data);
        positionAgendaSunLines(data);
      }
    } catch (e) {
      if (agendaTtDateObj && toDateStr(agendaTtDateObj) === dateStr) {
        hideAgendaTtLoading();
        lanes.innerHTML = '<div class="lib-empty">Impossible de charger le programme.</div>';
      }
    }
  }

  // Calcule le zoom qui fait tenir la timeline agenda dans l'espace visible.
  function computeAgendaFitZoom(data) {
    const wrap = document.getElementById('agendaTlWrap');
    const start = new Date(data.window_start).getTime();
    const end = new Date(data.window_end).getTime();
    const totalMin = (end - start) / 60000;
    if (!totalMin || totalMin <= 0) return 1;

    const navH = bottomNav ? bottomNav.offsetHeight : 0;
    const wrapTop = wrap.getBoundingClientRect().top;
    const buffer = 20;
    const availableHeight = Math.max(window.innerHeight - wrapTop - navH - buffer, 100);

    const fit = (availableHeight - 20) / (totalMin * BASE_PX_PER_MIN);
    return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, fit));
  }

  function renderAgendaTimeline(data, recomputeZoom = true) {
    const hours = document.getElementById('agendaTlHours');
    const lanesScroll = document.getElementById('agendaTlLanesScroll');
    const lanes = document.getElementById('agendaTlLanes');
    const wrap = document.getElementById('agendaTlWrap');
    hours.innerHTML = '';
    lanes.innerHTML = '';

    if (agendaZoomMode === 'auto' && recomputeZoom) {
      agendaZoomLevel = computeAgendaFitZoom(data);
    }
    const fitBtn = document.getElementById('agendaZoomFit');
    if (fitBtn) fitBtn.classList.toggle('active', agendaZoomMode === 'auto');

    const pxPerMin = BASE_PX_PER_MIN * agendaZoomLevel;
    const start = new Date(data.window_start).getTime();
    const end = new Date(data.window_end).getTime();
    const totalMin = (end - start) / 60000;
    const totalPx = Math.max(totalMin * pxPerMin, 300);
    const hourPx = 60 * pxPerMin;

    hours.style.height = `${totalPx}px`;
    lanes.style.height = `${totalPx}px`;
    wrap.style.height = `${totalPx + 15}px`;

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

    // Filtre d'abord, puis réassigne des voies compactes uniquement sur les
    // objets visibles (même logique que renderTimeline) : sinon data.lane_count
    // / o.lane (calculés côté serveur sur TOUS les objets de la nuit) laissaient
    // des colonnes vides ou un mauvais nombre de voies dès qu'un filtre était
    // appliqué, d'où le comportement de zoom horizontal erratique.
    const visibleObjects = filterObjects(data.objects, agendaFilterState);
    updateFilterCount('agendaFilterCount', data.objects.length, visibleObjects.length);

    const { laneOf, laneCount: computedLaneCount } = assignLanesClient(visibleObjects);
    const laneCount = Math.max(computedLaneCount, 1);
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

    visibleObjects.forEach((o) => {
      const lane = laneOf.get(o);
      const rise = new Date(o.rise_iso).getTime();
      const set = new Date(o.set_iso).getTime();
      const topPx = ((rise - start) / 60000) * pxPerMin;
      const heightPx = Math.max(((set - rise) / 60000) * pxPerMin, 22);

      const fav = isFavorite(o.name);
      const block = document.createElement('div');
      block.className = 'block' + (narrow ? ' block-narrow' : '') + (fav ? ' block-favorite' : '');
      block.style.top = `${topPx}px`;
      block.style.height = `${heightPx}px`;
      block.style.left = `${lane * laneWidth + 2}px`;
      block.style.width = `${Math.max(laneWidth - 4, 4)}px`;
      block.style.background = o.color;

      const magStr = (o.magnitude !== null && o.magnitude !== undefined) ? `mag ${o.magnitude}` : '';
      const subLine = narrow ? '' : `<span class="b-sub">${o.peak_altitude}° ${magStr}</span>`;
      const favBadge = fav ? `<span class="b-fav">★</span>` : '';
      block.innerHTML = `${favBadge}<span class="b-name">${o.name}</span>${subLine}`;
      block.title = `${o.name} — ${fmtTime(o.rise_iso)}\u2013${fmtTime(o.set_iso)}, alt ${o.peak_altitude}°${magStr ? ', ' + magStr : ''}`;
      // La phase (lune/planètes) doit correspondre à la nuit affichée dans
      // l'agenda (qui peut être une date future choisie via le calendrier),
      // pas à "maintenant".
      const agendaPhaseCtx = { dateStr: agendaTtDateObj ? toDateStr(agendaTtDateObj) : null };
      block.addEventListener('click', () => openInfo(o, agendaPhaseCtx));

      lanes.appendChild(block);
    });

    const pctEl = document.getElementById('agendaZoomPct');
    if (pctEl) pctEl.textContent = `${Math.round(agendaZoomLevel * 100)}%`;
  }

  function positionAgendaNowLine(data) {
    const nowLine = document.getElementById('agendaNowLine');
    const start = new Date(data.window_start).getTime();
    const end = new Date(data.window_end).getTime();
    const now = Date.now();
    if (now < start || now > end) {
      nowLine.style.display = 'none';
      return;
    }
    nowLine.style.display = 'block';
    const pxPerMin = BASE_PX_PER_MIN * agendaZoomLevel;
    nowLine.style.top = `${((now - start) / 60000) * pxPerMin}px`;
  }

  function positionAgendaSunLines(data) {
    const sunsetLine = document.getElementById('agendaSunsetLine');
    const sunriseLine = document.getElementById('agendaSunriseLine');
    const pxPerMin = BASE_PX_PER_MIN * agendaZoomLevel;
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

  function setAgendaZoom(newZoom) {
    if (!agendaTtData) return;
    agendaZoomMode = 'manual';
    agendaZoomLevel = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, newZoom));
    renderAgendaTimeline(agendaTtData);
    positionAgendaNowLine(agendaTtData);
    positionAgendaSunLines(agendaTtData);
  }

  function resetAgendaZoomToFit() {
    if (!agendaTtData) return;
    agendaZoomMode = 'auto';
    renderAgendaTimeline(agendaTtData);
    positionAgendaNowLine(agendaTtData);
    positionAgendaSunLines(agendaTtData);
  }

  document.getElementById('agendaZoomIn').addEventListener('click', (e) => {
    e.currentTarget.blur();
    setAgendaZoom(agendaZoomLevel + ZOOM_STEP);
  });
  document.getElementById('agendaZoomOut').addEventListener('click', (e) => {
    e.currentTarget.blur();
    setAgendaZoom(agendaZoomLevel - ZOOM_STEP);
  });
  document.getElementById('agendaZoomFit').addEventListener('click', (e) => {
    e.currentTarget.blur();
    resetAgendaZoomToFit();
  });

  document.getElementById('agendaTtPrev').addEventListener('click', () => {
  if (!agendaTtDateObj) return;

  // Empêche de remonter au-delà de la première date autorisée dans l'agenda
  if (agendaTtDateObj <= agendaFirstDay) return;

  // On recule d'un jour
  agendaTtDateObj.setDate(agendaTtDateObj.getDate() - 1);

  // Si on retombe sur aujourd'hui, on bascule vers la vue Timeline principale
  if (toDateStr(agendaTtDateObj) === toDateStr(today0)) {
    closeAgendaTimetable();
    switchView('timeline');
    return;
  }

  loadAgendaTimetable();
});

document.getElementById('agendaTtNext').addEventListener('click', () => {
  if (!agendaTtDateObj) return;

  // Empêche d'aller au-delà de la dernière date disponible dans l'agenda
  if (agendaTtDateObj >= agendaLastDay) return;

  // On avance d'un jour
  agendaTtDateObj.setDate(agendaTtDateObj.getDate() + 1);

  // Si on repasse par aujourd'hui
  if (toDateStr(agendaTtDateObj) === toDateStr(today0)) {
    closeAgendaTimetable();
    switchView('timeline');
    return;
  }

  loadAgendaTimetable();
});
  document.getElementById('agendaTtClose').addEventListener('click', closeAgendaTimetable);

  // Récupère, pour toute la plage de l'agenda, le nombre d'objets favoris
  // visibles chaque nuit (selon la plage horaire + hauteur mini choisies),
  // pour afficher la bulle "★ N" sur les jours concernés.
  async function loadAgendaFavCounts() {
    if (currentLat === null || currentLon === null) return;
    try {
      const mode = getObsMode();
      const margin = getObsMargin();
      const minAlt = getMinAlt();

      let url = `/api/agenda/favorites-count?lat=${currentLat}&lon=${currentLon}&elev=${currentElev}`;
      url += `&mode=${mode}&margin=${margin}&min_alt=${minAlt}`;
      url += `&fixed_start_hm=${encodeURIComponent(getFixedStart())}&fixed_end_hm=${encodeURIComponent(getFixedEnd())}`;
      url += `&tz_offset_min=${-new Date().getTimezoneOffset()}`;
      url += `&start_date=${toDateStr(today0)}&end_date=${toDateStr(agendaLastDay)}`;

      const res = await fetch(url);
      if (!res.ok) return;
      const data = await res.json();
      agendaFavCounts = data.counts || {};
      renderAgendaCalendar();
    } catch (e) {
      // Silencieux : la bulle est un bonus, pas une fonctionnalité bloquante.
    }
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

    const skip = locSkipToggle.checked;
    const auto = !skip && locAutoToggle.checked;
    updates.loc_mode = auto ? 'auto' : 'manual';
    if (skip) {
      // "Aucune position pour l'instant" : on envoie explicitement null
      // pour que la position déjà enregistrée soit effacée côté serveur
      // (sinon update_settings ignorait silencieusement les valeurs null
      // et l'ancienne position restait active après le reload).
      updates.loc_lat = null;
      updates.loc_lon = null;
    } else if (!auto) {
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

    // On vient de sauvegarder explicitement depuis l'écran Paramètres :
    // pas besoin de repasser par l'écran de confirmation au reload qui suit.
    try { sessionStorage.setItem('skyme_skip_confirm', '1'); } catch (e) { /* ignore */ }

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
  const locAutoRow = document.getElementById('locAutoRow');
  const locSkipToggle = document.getElementById('locSkipToggle');
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

  function setLocationManual() {
    locSkipToggle.checked = false;
    locAutoRow.classList.remove('hidden');
    if (locAutoToggle.checked) {
      locAutoToggle.checked = false;
      locManualBlock.classList.remove('hidden');
      locAutoHint.textContent = 'Position définie manuellement ci-dessous (non enregistrée).';
    }
    markSettingsDirty();
  }

  // Masque le switch GPS et le bloc manuel quand "Aucune position" est
  // coché : dans ce cas on n'a besoin de valider ni de GPS ni de
  // coordonnées, la position sera simplement effacée à l'enregistrement.
  function updateLocSkipUI() {
    const skip = locSkipToggle.checked;
    locAutoRow.classList.toggle('hidden', skip);
    locManualBlock.classList.toggle('hidden', skip || locAutoToggle.checked);
  }

  function loadLocationPreferences() {
    if (locSaveBtn) {
      locSaveBtn.style.display = 'none';
    }
    const noLocSaved = settingsCache.loc_mode === 'manual'
      && (settingsCache.loc_lat === null || settingsCache.loc_lat === undefined)
      && (settingsCache.loc_lon === null || settingsCache.loc_lon === undefined);
    locSkipToggle.checked = noLocSaved;

    const auto = settingsCache.loc_mode !== 'manual' && !geoUnavailable;
    locAutoToggle.checked = auto;
    locAutoToggle.disabled = geoUnavailable;
    updateLocSkipUI();
    locAutoHint.textContent = geoUnavailable
      ? 'Localisation GPS refusée ou indisponible. Définis ta position manuellement ci-dessous.'
      : auto
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

  locSkipToggle.addEventListener('change', () => {
    updateLocSkipUI();
    markSettingsDirty();
  });

  locAutoToggle.addEventListener('change', () => {
    const auto = locAutoToggle.checked;
    if (auto) locSkipToggle.checked = false;
    locManualBlock.classList.toggle('hidden', auto || locSkipToggle.checked);
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
  // Réutilisée à la fois par Paramètres (target='settings') et par l'écran
  // de confirmation au démarrage (target='confirm').
  let pickerMap = null;
  let pickerMarker = null;
  let mapPickerTarget = 'settings';

  function openMapPicker(target = 'settings') {
    mapPickerTarget = target;
    mapOverlay.classList.remove('hidden');
    const latInput = target === 'confirm' ? confirmLocLatInput : (target === 'plan' ? planParamsLocLatInput : locLatInput);
    const lonInput = target === 'confirm' ? confirmLocLonInput : (target === 'plan' ? planParamsLocLonInput : locLonInput);
    const fallbackLat = parseFloat(latInput.value) || currentLat || 48.8566;
    const fallbackLon = parseFloat(lonInput.value) || currentLon || 2.3522;

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

  locMapBtn.addEventListener('click', () => openMapPicker('settings'));
  mapClose.addEventListener('click', closeMapPicker);
  mapOverlay.addEventListener('click', (e) => {
    if (e.target.id === 'mapOverlay') closeMapPicker();
  });
  mapValidate.addEventListener('click', () => {
    if (!pickerMarker) return;
    const { lat, lng } = pickerMarker.getLatLng();
    if (mapPickerTarget === 'confirm') {
      confirmLocLatInput.value = lat.toFixed(4);
      confirmLocLonInput.value = lng.toFixed(4);
      confirmLocAutoToggle.checked = false;
      confirmSkyEnableToggle.checked = true;
      updateConfirmSkyEnableUI();
      confirmLocAutoRow.classList.remove('hidden');
      confirmLocManualBlock.classList.remove('hidden');
    } else if (mapPickerTarget === 'plan') {
      if (planParamsLocLatInput) planParamsLocLatInput.value = lat.toFixed(4);
      if (planParamsLocLonInput) planParamsLocLonInput.value = lng.toFixed(4);
      if (planParamsLocAutoToggle) planParamsLocAutoToggle.checked = false;
      if (planParamsLocManualBlock) planParamsLocManualBlock.classList.remove('hidden');
    } else {
      locLatInput.value = lat.toFixed(4);
      locLonInput.value = lng.toFixed(4);
      setLocationManual();
    }
    closeMapPicker();
  });


  // ---------- Écran de confirmation des paramètres (uniquement à
  // l'ouverture de l'application, pas lors d'un simple "reload" via le
  // bouton ⟳ ou "Try again", qui appellent resolveLocation() directement). ----------
  const confirmPanel = document.getElementById('confirmPanel');
  const confirmError = document.getElementById('confirmError');
  const confirmStartBtn = document.getElementById('confirmStartBtn');
  const confirmLocAutoToggle = document.getElementById('confirmLocAutoToggle');
  const confirmLocAutoRow = document.getElementById('confirmLocAutoRow');
  const confirmSkyEnableToggle = document.getElementById('confirmSkyEnableToggle');
  const confirmParamsWrapper = document.getElementById('confirmParamsWrapper');
  const confirmLocManualBlock = document.getElementById('confirmLocManualBlock');
  const confirmLocMapBtn = document.getElementById('confirmLocMapBtn');
  const confirmLocLatInput = document.getElementById('confirmLocLatInput');
  const confirmLocLonInput = document.getElementById('confirmLocLonInput');
  const confirmLocElevInput = document.getElementById('confirmLocElevInput');
  const confirmModeMargin = document.getElementById('confirmModeMargin');
  const confirmModeFixed = document.getElementById('confirmModeFixed');
  const confirmMarginInput = document.getElementById('confirmMarginInput');
  const confirmFixedStartInput = document.getElementById('confirmFixedStartInput');
  const confirmFixedEndInput = document.getElementById('confirmFixedEndInput');
  const confirmMinAltInput = document.getElementById('confirmMinAltInput');

  function populateConfirmPanel() {
    const noLocSaved = settingsCache.loc_mode === 'manual'
      && (settingsCache.loc_lat === null || settingsCache.loc_lat === undefined)
      && (settingsCache.loc_lon === null || settingsCache.loc_lon === undefined);
    confirmSkyEnableToggle.checked = !noLocSaved;

    const auto = settingsCache.loc_mode !== 'manual';
    confirmLocAutoToggle.checked = auto;
    confirmLocManualBlock.classList.toggle('hidden', auto);
    updateConfirmSkyEnableUI();

    if (settingsCache.loc_lat !== null && settingsCache.loc_lat !== undefined) {
      confirmLocLatInput.value = settingsCache.loc_lat;
    }
    if (settingsCache.loc_lon !== null && settingsCache.loc_lon !== undefined) {
      confirmLocLonInput.value = settingsCache.loc_lon;
    }
    confirmLocElevInput.value = (settingsCache.loc_elev !== null && settingsCache.loc_elev !== undefined)
      ? settingsCache.loc_elev : 0;

    const mode = settingsCache.pref_mode === 'fixed' ? 'fixed' : 'margin';
    confirmModeFixed.checked = mode === 'fixed';
    confirmModeMargin.checked = mode !== 'fixed';
    confirmMarginInput.value = settingsCache.pref_margin !== undefined && settingsCache.pref_margin !== null
      ? settingsCache.pref_margin : 30;
    confirmFixedStartInput.value = settingsCache.pref_fixed_start || '20:00';
    confirmFixedEndInput.value = settingsCache.pref_fixed_end || '06:00';
    onConfirmModeChange();

    confirmMinAltInput.value = (settingsCache.pref_min_alt !== null && settingsCache.pref_min_alt !== undefined)
      ? settingsCache.pref_min_alt : 10;
  }

  function onConfirmModeChange() {
    const fixed = confirmModeFixed.checked;
    confirmMarginInput.disabled = fixed;
    confirmFixedStartInput.disabled = !fixed;
    confirmFixedEndInput.disabled = !fixed;
  }

  // Quand "Activer le calcul du ciel" est désactivé, on masque tous les
  // paramètres (localisation, plage horaire, altitude minimale) : aucune
  // position ne sera envoyée, et aucune validation de latitude/longitude
  // n'est requise pour continuer.
  function updateConfirmSkyEnableUI() {
    const enabled = confirmSkyEnableToggle.checked;
    confirmParamsWrapper.classList.toggle('hidden', !enabled);
    if (enabled) {
      confirmLocManualBlock.classList.toggle('hidden', confirmLocAutoToggle.checked);
    }
  }

  confirmSkyEnableToggle.addEventListener('change', updateConfirmSkyEnableUI);
  confirmLocAutoToggle.addEventListener('change', () => {
    confirmLocManualBlock.classList.toggle('hidden', confirmLocAutoToggle.checked);
  });
  confirmModeFixed.addEventListener('change', onConfirmModeChange);
  confirmModeMargin.addEventListener('change', onConfirmModeChange);
  confirmLocMapBtn.addEventListener('click', () => openMapPicker('confirm'));

  function showConfirmError(msg) {
    confirmError.textContent = msg;
    confirmError.classList.remove('hidden');
  }
  function hideConfirmError() {
    confirmError.classList.add('hidden');
  }

  confirmStartBtn.addEventListener('click', async () => {
    hideConfirmError();
    const skip = !confirmSkyEnableToggle.checked;
    const auto = !skip && confirmLocAutoToggle.checked;

    let margin = parseInt(confirmMarginInput.value, 10);
    if (isNaN(margin) || margin < 0) margin = 0;
    let minAltVal = parseFloat(confirmMinAltInput.value);
    if (isNaN(minAltVal) || minAltVal < 0) minAltVal = 0;
    if (minAltVal > 90) minAltVal = 90;

    const updates = {
      loc_mode: auto ? 'auto' : 'manual',
      pref_mode: confirmModeFixed.checked ? 'fixed' : 'margin',
      pref_margin: margin,
      pref_fixed_start: confirmFixedStartInput.value || '20:00',
      pref_fixed_end: confirmFixedEndInput.value || '06:00',
      pref_min_alt: minAltVal,
    };

    if (skip) {
      // Aucune position voulue pour l'instant : on efface explicitement
      // loc_lat/loc_lon (au lieu de les laisser tels quels en base) et on
      // ne bloque pas sur une validation de coordonnées qui n'a pas lieu
      // d'être.
      updates.loc_lat = null;
      updates.loc_lon = null;
    } else if (!auto) {
      const lat = parseFloat(confirmLocLatInput.value);
      const lon = parseFloat(confirmLocLonInput.value);
      if (isNaN(lat) || lat < -90 || lat > 90 || isNaN(lon) || lon < -180 || lon > 180) {
        showConfirmError('Latitude ou longitude invalide.');
        return;
      }
      let elev = parseFloat(confirmLocElevInput.value);
      if (isNaN(elev)) elev = 0;
      updates.loc_lat = lat;
      updates.loc_lon = lon;
      updates.loc_elev = elev;
    }

    confirmStartBtn.disabled = true;
    confirmStartBtn.textContent = 'Chargement…';

    await saveSettings(updates);

    confirmPanel.classList.add('hidden');
    statusPanel.classList.remove('hidden');
    await runLoadSequence();
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
    renderOverviewFavorites();
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
    renderOverviewFavorites();
    if (currentData) renderTimeline(currentData);
    // Le badge "★ N" de l'agenda dépend directement des favoris : sans ce
    // rafraîchissement, il restait figé sur l'état du chargement initial
    // jusqu'au prochain rechargement complet de la page.
    loadAgendaFavCounts();
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
    sun: 'var(--c-sun)',
    moon: 'var(--c-moon)',
    planet: 'var(--c-planet)',
    star: 'var(--c-star)',
    galaxy: 'var(--c-galaxy)',
    nebula: 'var(--c-nebula)',
    cluster: 'var(--c-cluster)',
  };
  const CATEGORY_LABEL = {
    sun: 'Soleil',
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

  let catalogListInFlight = null;
  let catalogListInFlightKey = null;

  async function fetchCatalogListOnce() {
    // Clé de cache : la position et l'altitude minimale influent sur le
    // lever/coucher réel de chaque objet, donc on refait la requête dès
    // qu'un de ces paramètres change (nouvelle position, réglage modifié…).
    const key = isLocationSet()
      ? `${currentLat.toFixed(4)}|${currentLon.toFixed(4)}|${currentElev}|${getMinAlt()}`
      : 'no-location';
    if (catalogList && catalogListKey === key) return catalogList;

    // Une requête pour cette même clé est déjà en cours (ex : render() et
    // l'étape "Chargement de la bibliothèque…" qui se chevauchent au
    // démarrage) : on réutilise sa promesse plutôt que de refaire un fetch.
    if (catalogListInFlight && catalogListInFlightKey === key) {
      return catalogListInFlight;
    }

    catalogListInFlightKey = key;
    catalogListInFlight = (async () => {
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
      } finally {
        catalogListInFlight = null;
        catalogListInFlightKey = null;
      }
    })();

    return catalogListInFlight;
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

    listEl.innerHTML = filtered.map(catalogRowHtml).join('');

    tickLibraryCountdowns();
  }

  // Rendu HTML d'une ligne "objet du catalogue" (nom, lever/coucher,
  // magnitude, étoile favori...). Partagé entre la Bibliothèque et la
  // liste des favoris de l'Overview.
  function catalogRowHtml(o) {
    const color = CATEGORY_COLOR_VAR[o.category] || 'var(--text-muted)';
    const magStr = (o.magnitude !== null && o.magnitude !== undefined) ? `mag ${o.magnitude}` : '—';
    const nameAttr = o.name.replace(/"/g, '&quot;');
    const isSun = o.category === 'sun';
    const fav = !isSun && isFavorite(o.name);
    const seenBadge = getObjectJournalStatus(o.name) === 'seen'
      ? ' <span class="lib-row-vu-badge">VU</span>'
      : '';

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
          <span class="lib-row-name">${o.name}${seenBadge}</span>
          <span class="lib-row-meta">${CATEGORY_LABEL[o.category] || capitalize(o.category)}</span>
          ${whenLine}
        </span>
        <span class="lib-row-side">
          <span class="lib-row-mag">${magStr}</span>
          ${countdownHtml}
        </span>
        ${isSun ? '' : `
        <button type="button" class="lib-fav-btn${fav ? ' active' : ''}" data-name="${nameAttr}" title="${fav ? 'Retirer des favoris' : 'Ajouter aux favoris'}">
          <i class='bx ${fav ? 'bxs-star' : 'bx-star'}'></i>
        </button>`}
      </div>
    `;
  }

  // ---------- Overview: liste des favoris ----------
  async function renderOverviewFavorites() {
    const listEl = document.getElementById('overviewFavList');
    const emptyEl = document.getElementById('overviewFavEmpty');
    if (!listEl) return;

    const items = await fetchCatalogListOnce();
    if (!items) {
      listEl.innerHTML = '';
      if (emptyEl) { emptyEl.textContent = 'Impossible de charger les favoris.'; emptyEl.classList.remove('hidden'); }
      return;
    }

    const favs = items.filter((o) => isFavorite(o.name));
    if (favs.length === 0) {
      listEl.innerHTML = '';
      if (emptyEl) { emptyEl.textContent = 'Aucun favori pour l\u2019instant. Touche l\u2019étoile d\u2019un objet pour l\u2019ajouter.'; emptyEl.classList.remove('hidden'); }
      return;
    }
    if (emptyEl) emptyEl.classList.add('hidden');
    listEl.innerHTML = favs.map(catalogRowHtml).join('');
    tickLibraryCountdowns();
  }

  function tickLibraryCountdowns() {
    const now = Date.now();
    document.querySelectorAll('.lib-row-countdown[data-rise]').forEach((el) => {
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
    if (libCountdownTimer) return; // déjà démarré (timer global, unique)
    libCountdownTimer = setInterval(tickLibraryCountdowns, 1000);
  }

  async function initLibraryView() {
    await fetchCatalogListOnce();
    renderLibraryList();
  }

  const libSearchInput = document.getElementById('libSearchInput');
  if (libSearchInput) {
    libSearchInput.addEventListener('input', () => {
      libSearchTerm = libSearchInput.value;
      renderLibraryList();
    });
  }

  document.querySelectorAll('.lib-filter-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      libActiveCategory = chip.dataset.cat;
      document.querySelectorAll('.lib-filter-chip').forEach((c) => c.classList.toggle('active', c === chip));
      renderLibraryList();
    });
  });

  function handleCatalogRowClick(e) {
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
  }

  const libListEl = document.getElementById('libList');
  if (libListEl) libListEl.addEventListener('click', handleCatalogRowClick);

  const overviewFavListEl = document.getElementById('overviewFavList');
  if (overviewFavListEl) overviewFavListEl.addEventListener('click', handleCatalogRowClick);

  // ---------- Prévoir (planifier une soirée : sélection d'objets + note +
  // paramètres [lieu, plage horaire, altitude min] par jour) ----------
  const PLAN_SETTINGS_KEYS = [
    'loc_mode', 'loc_lat', 'loc_lon', 'loc_elev',
    'pref_mode', 'pref_margin', 'pref_fixed_start', 'pref_fixed_end', 'pref_min_alt',
  ];

  function extractPlanSettings(source) {
    const out = {};
    PLAN_SETTINGS_KEYS.forEach((k) => { out[k] = source ? source[k] : undefined; });
    return out;
  }

  let planCurrentDate = toDateStr(today0);
  let planSelectedNames = new Set();
  let planExists = false;
  let planCatalogFilter = 'all';
  let planCatalogSearch = '';
  let planDatesWithPlan = {}; // { 'YYYY-MM-DD': nombre d'objets prévus }
  let planInitialized = false;
  let planListData = []; // dernière liste chargée depuis /api/plans
  let planCurrentSettings = null; // paramètres (lieu/horaire/alt min) du plan ouvert dans l'éditeur
  let planParamsMode = 'edit'; // 'create' (nouveau plan) ou 'edit' (plan déjà ouvert)
  let planScheduleByName = {}; // { name: objet renvoyé par /api/sky } pour la nuit + les paramètres du plan ouvert
  let planScheduleLoaded = false; // true une fois le calcul des horaires terminé (pour cette date/ces paramètres)
  let planWindowStart = null; // début de la fenêtre d'observation (ISO) de la nuit du plan ouvert
  let planWindowEnd = null; // fin de la fenêtre d'observation (ISO) de la nuit du plan ouvert
  let planCountdownTimer = null;

  function planDateInputEl() { return document.getElementById('planDateInput'); }

  // Lieu effectif du plan actuellement ouvert : celui défini manuellement
  // dans les paramètres du plan (loc_mode 'manual'), sinon le lieu courant
  // de l'app. Centralise la logique déjà utilisée par loadPlanSchedule /
  // loadPlanTimetable, pour que la phase (lune/planètes) affichée dans la
  // fiche objet corresponde toujours au lieu réellement utilisé par ce plan.
  function getPlanLocation() {
    const s = planCurrentSettings || {};
    let lat = currentLat, lon = currentLon, elev = currentElev;
    if (s.loc_mode === 'manual' && s.loc_lat !== null && s.loc_lat !== undefined
        && s.loc_lon !== null && s.loc_lon !== undefined) {
      lat = parseFloat(s.loc_lat);
      lon = parseFloat(s.loc_lon);
      elev = parseFloat(s.loc_elev) || 0;
    }
    return { lat, lon, elev };
  }

  // ---------- Liste des soirées prévues ----------

  function showPlanListView() {
    const listView = document.getElementById('planListView');
    const mainView = document.getElementById('planMainView');
    if (listView) listView.classList.remove('hidden');
    if (mainView) mainView.classList.add('hidden');
    if (planCountdownTimer) { clearInterval(planCountdownTimer); planCountdownTimer = null; }
    loadPlanList();
  }

  function showPlanEditorView(dateStr) {
    const listView = document.getElementById('planListView');
    const mainView = document.getElementById('planMainView');
    if (listView) listView.classList.add('hidden');
    if (mainView) mainView.classList.remove('hidden');
    loadPlan(dateStr);
  }

  function planLocationSummary(s) {
    if (s && s.loc_mode === 'manual' && s.loc_lat !== null && s.loc_lat !== undefined
        && s.loc_lon !== null && s.loc_lon !== undefined) {
      return `${parseFloat(s.loc_lat).toFixed(2)}°, ${parseFloat(s.loc_lon).toFixed(2)}°`;
    }
    return 'Lieu par défaut';
  }

  function planTimeRangeSummary(s) {
    if (s && s.pref_mode === 'fixed') {
      return `${s.pref_fixed_start || '20:00'} – ${s.pref_fixed_end || '06:00'}`;
    }
    const margin = (s && s.pref_margin !== null && s.pref_margin !== undefined) ? s.pref_margin : 30;
    return `Marge ${margin} min`;
  }

  async function loadPlanList() {
    const listEl = document.getElementById('planList');
    const emptyEl = document.getElementById('planListEmpty');
    if (!listEl) return;
    listEl.innerHTML = '<div class="lib-empty">Chargement…</div>';
    if (emptyEl) emptyEl.classList.add('hidden');
    try {
      const res = await fetch('/api/plans');
      if (!res.ok) throw new Error();
      const data = await res.json();
      planListData = data.plans || [];
    } catch (e) {
      planListData = [];
    }
    renderPlanList();
  }

  function renderPlanList() {
    const listEl = document.getElementById('planList');
    const emptyEl = document.getElementById('planListEmpty');
    if (!listEl) return;

    if (planListData.length === 0) {
      listEl.innerHTML = '';
      if (emptyEl) emptyEl.classList.remove('hidden');
      return;
    }
    if (emptyEl) emptyEl.classList.add('hidden');

    const sorted = [...planListData].sort((a, b) => a.date.localeCompare(b.date));
    listEl.innerHTML = sorted.map((p) => {
      const d = new Date(`${p.date}T00:00:00`);
      const label = d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
      const count = (p.objects || []).length;
      const countLabel = `${count} objet${count > 1 ? 's' : ''} prévu${count > 1 ? 's' : ''}`;
      return `
        <div class="lib-row lib-row-clickable" data-date="${p.date}">
          <span class="lib-row-main">
            <span class="lib-row-name">${label}</span>
            <span class="lib-row-meta">${countLabel} · ${planLocationSummary(p)} · ${planTimeRangeSummary(p)}</span>
          </span>
          <i class='bx bx-chevron-right' style="font-size:22px; color:var(--text-muted); flex:none;"></i>
        </div>
      `;
    }).join('');

    listEl.querySelectorAll('.lib-row-clickable').forEach((row) => {
      row.addEventListener('click', () => showPlanEditorView(row.dataset.date));
    });
  }

  const planCreateBtnEl = document.getElementById('planCreateBtn');
  if (planCreateBtnEl) planCreateBtnEl.addEventListener('click', () => openPlanParams('create'));
  const planBackBtnEl = document.getElementById('planBackBtn');
  if (planBackBtnEl) planBackBtnEl.addEventListener('click', showPlanListView);
  const planParamsBtnEl = document.getElementById('planParamsBtn');
  if (planParamsBtnEl) planParamsBtnEl.addEventListener('click', () => openPlanParams('edit'));

  // ---------- Popup "Paramètres du plan" (lieu, plage horaire, altitude min) ----------
  const planParamsOverlay = document.getElementById('planParamsOverlay');
  const planParamsClose = document.getElementById('planParamsClose');
  const planParamsDateLabel = document.getElementById('planParamsDateLabel');
  const planParamsDateRow = document.getElementById('planParamsDateRow');
  const planParamsDateInput = document.getElementById('planParamsDateInput');
  const planParamsLocAutoToggle = document.getElementById('planParamsLocAutoToggle');
  const planParamsLocManualBlock = document.getElementById('planParamsLocManualBlock');
  const planParamsLocMapBtn = document.getElementById('planParamsLocMapBtn');
  const planParamsLocLatInput = document.getElementById('planParamsLocLatInput');
  const planParamsLocLonInput = document.getElementById('planParamsLocLonInput');
  const planParamsLocElevInput = document.getElementById('planParamsLocElevInput');
  const planParamsModeMargin = document.getElementById('planParamsModeMargin');
  const planParamsModeFixed = document.getElementById('planParamsModeFixed');
  const planParamsMarginInput = document.getElementById('planParamsMarginInput');
  const planParamsFixedStartInput = document.getElementById('planParamsFixedStartInput');
  const planParamsFixedEndInput = document.getElementById('planParamsFixedEndInput');
  const planParamsMinAltInput = document.getElementById('planParamsMinAltInput');
  const planParamsError = document.getElementById('planParamsError');
  const planParamsSaveBtn = document.getElementById('planParamsSaveBtn');

  function fillPlanParamsForm(settings) {
    const s = settings || {};
    const manual = s.loc_mode === 'manual';
    if (planParamsLocAutoToggle) planParamsLocAutoToggle.checked = !manual;
    if (planParamsLocManualBlock) planParamsLocManualBlock.classList.toggle('hidden', !manual);
    if (planParamsLocLatInput) {
      planParamsLocLatInput.value = (s.loc_lat !== null && s.loc_lat !== undefined)
        ? s.loc_lat : (currentLat !== null ? currentLat.toFixed(4) : '');
    }
    if (planParamsLocLonInput) {
      planParamsLocLonInput.value = (s.loc_lon !== null && s.loc_lon !== undefined)
        ? s.loc_lon : (currentLon !== null ? currentLon.toFixed(4) : '');
    }
    if (planParamsLocElevInput) {
      planParamsLocElevInput.value = (s.loc_elev !== null && s.loc_elev !== undefined) ? s.loc_elev : 0;
    }

    const mode = s.pref_mode === 'fixed' ? 'fixed' : 'margin';
    if (planParamsModeMargin) planParamsModeMargin.checked = mode === 'margin';
    if (planParamsModeFixed) planParamsModeFixed.checked = mode === 'fixed';
    if (planParamsMarginInput) {
      planParamsMarginInput.value = (s.pref_margin !== null && s.pref_margin !== undefined) ? s.pref_margin : 30;
    }
    if (planParamsFixedStartInput) planParamsFixedStartInput.value = s.pref_fixed_start || '20:00';
    if (planParamsFixedEndInput) planParamsFixedEndInput.value = s.pref_fixed_end || '06:00';
    if (planParamsMinAltInput) {
      planParamsMinAltInput.value = (s.pref_min_alt !== null && s.pref_min_alt !== undefined) ? s.pref_min_alt : 10;
    }
  }

  function openPlanParams(mode, dateStr) {
    if (!planParamsOverlay) return;
    planParamsMode = mode;
    if (planParamsError) { planParamsError.classList.add('hidden'); planParamsError.textContent = ''; }

    if (mode === 'create') {
      if (planParamsDateRow) planParamsDateRow.classList.remove('hidden');
      if (planParamsDateLabel) planParamsDateLabel.classList.add('hidden');
      if (planParamsDateInput) planParamsDateInput.value = dateStr || toDateStr(today0);
      // Les options reprennent par défaut les réglages généraux de
      // l'utilisateur ("toujours ceux que j'ai"), personnalisables ensuite.
      fillPlanParamsForm(settingsCache);
    } else {
      if (planParamsDateRow) planParamsDateRow.classList.add('hidden');
      if (planParamsDateLabel) {
        planParamsDateLabel.classList.remove('hidden');
        const d = new Date(`${planCurrentDate}T00:00:00`);
        planParamsDateLabel.textContent = d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
      }
      fillPlanParamsForm(planCurrentSettings || settingsCache);
    }
    planParamsOverlay.classList.remove('hidden');
  }

  function closePlanParams() {
    if (planParamsOverlay) planParamsOverlay.classList.add('hidden');
  }

  if (planParamsClose) planParamsClose.addEventListener('click', closePlanParams);
  if (planParamsOverlay) {
    planParamsOverlay.addEventListener('click', (e) => {
      if (e.target.id === 'planParamsOverlay') closePlanParams();
    });
  }
  if (planParamsLocAutoToggle) {
    planParamsLocAutoToggle.addEventListener('change', () => {
      if (planParamsLocManualBlock) {
        planParamsLocManualBlock.classList.toggle('hidden', planParamsLocAutoToggle.checked);
      }
    });
  }
  if (planParamsLocMapBtn) {
    planParamsLocMapBtn.addEventListener('click', () => openMapPicker('plan'));
  }

  function readPlanParamsForm() {
    const manual = planParamsLocAutoToggle ? !planParamsLocAutoToggle.checked : false;
    const mode = (planParamsModeFixed && planParamsModeFixed.checked) ? 'fixed' : 'margin';
    return {
      loc_mode: manual ? 'manual' : 'auto',
      loc_lat: manual ? (parseFloat(planParamsLocLatInput.value) || 0) : null,
      loc_lon: manual ? (parseFloat(planParamsLocLonInput.value) || 0) : null,
      loc_elev: manual ? (parseFloat(planParamsLocElevInput.value) || 0) : 0,
      pref_mode: mode,
      pref_margin: parseInt(planParamsMarginInput.value, 10) || 30,
      pref_fixed_start: planParamsFixedStartInput.value || '20:00',
      pref_fixed_end: planParamsFixedEndInput.value || '06:00',
      pref_min_alt: parseFloat(planParamsMinAltInput.value),
    };
  }

  async function savePlanParams() {
    const settings = readPlanParamsForm();
    const dateStr = planParamsMode === 'create'
      ? ((planParamsDateInput && planParamsDateInput.value) || toDateStr(today0))
      : planCurrentDate;
    if (!dateStr) return;

    if (planParamsSaveBtn) { planParamsSaveBtn.disabled = true; planParamsSaveBtn.textContent = 'Enregistrement…'; }
    try {
      const body = { date: dateStr, settings };
      if (planParamsMode === 'create') {
        body.objects = [];
        body.note = '';
      }
      const res = await fetch('/api/plan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error();
      const data = await res.json();
      closePlanParams();
      loadPlanDatesRange();
      if (planParamsMode === 'create') {
        showPlanEditorView(dateStr);
      } else {
        planCurrentSettings = extractPlanSettings(data);
        updatePlanParamsLine();
        loadPlanSchedule();
        if (!document.getElementById('planTimetableView').classList.contains('hidden')) {
          loadPlanTimetable();
        }
      }
    } catch (e) {
      if (planParamsError) {
        planParamsError.textContent = "Impossible d'enregistrer les paramètres.";
        planParamsError.classList.remove('hidden');
      }
    }
    if (planParamsSaveBtn) { planParamsSaveBtn.disabled = false; planParamsSaveBtn.textContent = 'Enregistrer les paramètres'; }
  }
  if (planParamsSaveBtn) planParamsSaveBtn.addEventListener('click', savePlanParams);

  // ---------- Éditeur d'un plan (objets sélectionnés + note) ----------

  function updatePlanStatusLine() {
    const el = document.getElementById('planStatusLine');
    if (!el) return;
    const d = new Date(planCurrentDate);
    const label = d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
    el.textContent = planExists
      ? `Plan enregistré pour la nuit du ${label} (${planSelectedNames.size} objet${planSelectedNames.size > 1 ? 's' : ''}).`
      : `Aucun plan enregistré pour la nuit du ${label} pour l\u2019instant.`;
  }

  function updatePlanParamsLine() {
    const el = document.getElementById('planParamsLine');
    if (!el) return;
    const s = planCurrentSettings || {};
    const minAlt = (s.pref_min_alt !== null && s.pref_min_alt !== undefined) ? s.pref_min_alt : 10;
    el.textContent = `${planLocationSummary(s)} · ${planTimeRangeSummary(s)} · altitude min ${minAlt}°`;
  }

  function updatePlanDeleteBtn() {
    const btn = document.getElementById('planDeleteBtn');
    if (btn) btn.classList.toggle('hidden', !planExists);
  }

  async function loadPlan(dateStr) {
    planCurrentDate = dateStr;
    if (planDateInputEl()) planDateInputEl().value = dateStr;

    const noteInput = document.getElementById('planNoteInput');
    if (noteInput) noteInput.value = '';
    planSelectedNames = new Set();
    planExists = false;
    planCurrentSettings = null;
    planScheduleByName = {};
    planScheduleLoaded = false;

    try {
      const res = await fetch(`/api/plan?date=${dateStr}`);
      if (res.ok) {
        const data = await res.json();
        planSelectedNames = new Set(data.objects || []);
        planExists = !!data.exists;
        if (noteInput) noteInput.value = data.note || '';
        if (planExists) planCurrentSettings = extractPlanSettings(data);
      }
    } catch (e) {
      // hors-ligne : formulaire vide
    }

    // Plan pas encore créé en base (accès direct sans passer par le popup de
    // création, ex. lien depuis l'agenda) : on part des réglages généraux.
    if (!planCurrentSettings) planCurrentSettings = extractPlanSettings(settingsCache);

    updatePlanStatusLine();
    updatePlanParamsLine();
    updatePlanDeleteBtn();
    updatePlanOpenTimelineBtn();
    renderPlanSelectedList();
    await renderPlanCatalogList();
    loadPlanSchedule();
  }

  // Calcule, pour la nuit et les paramètres du plan actuellement ouvert
  // (lieu, plage horaire, altitude min), l'horaire réel d'observation de
  // chaque objet du catalogue (mêmes calculs que /api/sky). Sert à afficher
  // dans la liste des objets prévus soit le créneau de visibilité, soit
  // "Impossible de voir ce soir là" si l'objet ne dépasse pas l'altitude
  // minimale sur toute la fenêtre de cette nuit.
  async function loadPlanSchedule() {
    const dateStr = planCurrentDate;
    planScheduleByName = {};
    planScheduleLoaded = false;
    planWindowStart = null;
    planWindowEnd = null;
    renderPlanSelectedList();
    renderPlanCatalogList();
    updatePlanCountdown();

    const s = planCurrentSettings || {};
    const { lat, lon, elev } = getPlanLocation();
    if (lat === null || lon === null || isNaN(lat) || isNaN(lon)) {
      return; // pas de position connue : on ne peut pas calculer les horaires
    }

    try {
      const url = buildSkyUrl(lat, lon, elev, dateStr, s);
      const res = await fetch(url);
      if (!res.ok) throw new Error();
      const data = await res.json();
      if (planCurrentDate !== dateStr) return; // la date a changé entre-temps

      const byName = {};
      (data.objects || []).forEach((o) => { byName[o.name] = o; });
      planScheduleByName = byName;
      planScheduleLoaded = true;
      planWindowStart = data.window_start || null;
      planWindowEnd = data.window_end || null;
    } catch (e) {
      planScheduleLoaded = false; // hors-ligne / erreur : pas d'horaires affichés
    }
    if (planCurrentDate === dateStr) {
      renderPlanSelectedList();
      renderPlanCatalogList();
      updatePlanCountdown();
    }
  }

  // Si la nuit du plan actuellement ouvert est celle d'aujourd'hui, affiche
  // un compte à rebours vers le début (ou, si déjà commencée, vers la fin)
  // de la fenêtre d'observation de cette nuit. Se cache sinon (plan futur/
  // passé, ou fenêtre pas encore calculée).
  function updatePlanCountdown() {
    const cell = document.getElementById('planCountdownCell');
    const labelEl = document.getElementById('planCountdownLabel');
    const valueEl = document.getElementById('planCountdownValue');
    if (!cell || !labelEl || !valueEl) return;

    const isToday = planCurrentDate === toDateStr(new Date());
    if (!isToday || !planWindowStart || !planWindowEnd) {
      cell.classList.add('hidden');
      if (planCountdownTimer) { clearInterval(planCountdownTimer); planCountdownTimer = null; }
      return;
    }

    const now = Date.now();
    const startT = new Date(planWindowStart).getTime();
    const endT = new Date(planWindowEnd).getTime();

    let diffMs;
    if (now < startT) {
      labelEl.textContent = 'Début de la soirée dans';
      diffMs = startT - now;
    } else if (now <= endT) {
      labelEl.textContent = 'Fin de la soirée dans';
      diffMs = endT - now;
    } else {
      labelEl.textContent = 'Soirée terminée';
      diffMs = 0;
    }
    valueEl.textContent = formatCountdownMs(diffMs);
    cell.classList.remove('hidden');

    if (!planCountdownTimer) {
      planCountdownTimer = setInterval(updatePlanCountdown, 1000);
    }
  }

  // Formatte l'horaire d'observation d'un objet pour la nuit + les
  // paramètres du plan ouvert : créneau lever→coucher, "toujours visible",
  // "Impossible de voir ce soir là" si l'objet ne dépasse pas l'altitude
  // minimale sur toute la fenêtre, ou un état "Chargement…" tant que le
  // calcul des horaires (loadPlanSchedule) n'est pas encore terminé —
  // évite d'afficher une ligne vide qui laisse croire que rien ne se
  // passe pendant qu'on ajoute des objets au plan.
  function planScheduleLineHtml(name) {
    if (!planScheduleLoaded) {
      return `<span class="lib-row-when lib-row-when-loading"><span class="lib-row-when-spinner"></span>Chargement des horaires…</span>`;
    }
    const sched = planScheduleByName[name];
    if (!sched) {
      return `<span class="lib-row-when lib-row-when-impossible">Impossible de voir ce soir là</span>`;
    }
    if (sched.always_visible) {
      const minAlt = (planCurrentSettings && planCurrentSettings.pref_min_alt !== null
        && planCurrentSettings.pref_min_alt !== undefined) ? planCurrentSettings.pref_min_alt : getMinAlt();
      return `<span class="lib-row-when lib-row-when-special">Toujours au-dessus de ${minAlt}°</span>`;
    }
    return `<span class="lib-row-when">${fmtTime(sched.rise_iso)} – ${fmtTime(sched.set_iso)}</span>`;
  }

  async function togglePlanObject(name) {
    if (planSelectedNames.has(name)) planSelectedNames.delete(name);
    else planSelectedNames.add(name);
    renderPlanSelectedList();
    renderPlanCatalogList();
    updatePlanOpenTimelineBtn();
  }

  async function savePlan() {
    const noteInput = document.getElementById('planNoteInput');
    const btn = document.getElementById('planSaveBtn');
    const objects = Array.from(planSelectedNames);
    if (btn) { btn.disabled = true; btn.textContent = 'Enregistrement…'; }
    try {
      const res = await fetch('/api/plan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date: planCurrentDate, objects, note: noteInput ? noteInput.value : '' }),
      });
      if (res.ok) {
        const data = await res.json();
        planExists = !!data.exists;
        planCurrentSettings = extractPlanSettings(data);
        updatePlanParamsLine();
      }
    } catch (e) {
      // best effort : le formulaire reste tel quel pour cette session
    }
    if (btn) { btn.disabled = false; btn.textContent = 'Enregistrer le plan'; }
    updatePlanStatusLine();
    updatePlanDeleteBtn();
    loadPlanDatesRange();
  }

  // ---------- Modale de confirmation générique (non native, remplace window.confirm) ----------
  const confirmOverlayEl = document.getElementById('confirmOverlay');
  const confirmTitleEl = document.getElementById('confirmTitle');
  const confirmMessageEl = document.getElementById('confirmMessage');
  const confirmOkBtnEl = document.getElementById('confirmOkBtn');
  const confirmCancelBtnEl = document.getElementById('confirmCancelBtn');
  const confirmCloseBtnEl = document.getElementById('confirmClose');
  let confirmResolve = null;

  function closeConfirm(result) {
    if (confirmOverlayEl) confirmOverlayEl.classList.add('hidden');
    if (confirmResolve) { confirmResolve(result); confirmResolve = null; }
  }

  function showConfirm(title, message, okLabel) {
    if (!confirmOverlayEl) return Promise.resolve(true); // pas de modale dispo : on laisse passer
    if (confirmTitleEl) confirmTitleEl.textContent = title || 'Confirmer';
    if (confirmMessageEl) confirmMessageEl.textContent = message || '';
    if (confirmOkBtnEl) confirmOkBtnEl.textContent = okLabel || 'Supprimer';
    confirmOverlayEl.classList.remove('hidden');
    return new Promise((resolve) => { confirmResolve = resolve; });
  }

  if (confirmOkBtnEl) confirmOkBtnEl.addEventListener('click', () => closeConfirm(true));
  if (confirmCancelBtnEl) confirmCancelBtnEl.addEventListener('click', () => closeConfirm(false));
  if (confirmCloseBtnEl) confirmCloseBtnEl.addEventListener('click', () => closeConfirm(false));
  if (confirmOverlayEl) {
    confirmOverlayEl.addEventListener('click', (e) => {
      if (e.target.id === 'confirmOverlay') closeConfirm(false);
    });
  }

  async function deleteCurrentPlan() {
    const d = new Date(planCurrentDate);
    const label = d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
    const ok = await showConfirm(
      'Supprimer le plan',
      `Supprimer le plan prévu pour la nuit du ${label} ? Cette action est définitive.`,
      'Supprimer',
    );
    if (!ok) return;
    try {
      await fetch(`/api/plan?date=${planCurrentDate}`, { method: 'DELETE' });
    } catch (e) {
      // best effort
    }
    loadPlanDatesRange();
    showPlanListView();
  }

  function planRowHtml(o) {
    const color = CATEGORY_COLOR_VAR[o.category] || 'var(--text-muted)';
    const magStr = (o.magnitude !== null && o.magnitude !== undefined) ? `mag ${o.magnitude}` : '—';
    const nameAttr = o.name.replace(/"/g, '&quot;');
    const selected = planSelectedNames.has(o.name);
    const seenBadge = getObjectJournalStatus(o.name) === 'seen'
      ? ' <span class="lib-row-vu-badge">VU</span>'
      : '';
    const scheduleLine = planScheduleLineHtml(o.name);
    return `
      <div class="lib-row lib-row-clickable lib-row-plan-toggle${selected ? ' active' : ''}" data-name="${nameAttr}">
        <span class="lib-row-dot" style="background:${color}"></span>
        <span class="lib-row-main">
          <span class="lib-row-name">${o.name}${seenBadge}</span>
          <span class="lib-row-meta">${CATEGORY_LABEL[o.category] || capitalize(o.category)}</span>
          ${scheduleLine}
        </span>
        <span class="lib-row-mag">${magStr}</span>
        <button type="button" class="lib-fav-btn${selected ? ' active' : ''}" data-name="${nameAttr}" title="${selected ? 'Retirer du plan' : 'Ajouter au plan'}">
          <i class='bx ${selected ? 'bxs-check-square' : 'bx-square'}'></i>
        </button>
      </div>
    `;
  }
  // --- Câblage des puces de filtrage du Journal ---

  // 1. Timeline & Schedule (Partagent le même tlFilterState)
  document.querySelectorAll('.tl-journal-chip, .schedule-journal-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      tlFilterState.journal = chip.dataset.journal;
      document.querySelectorAll('.tl-journal-chip, .schedule-journal-chip').forEach(c => {
        c.classList.toggle('active', c.dataset.journal === tlFilterState.journal);
      });
      refreshSharedFilterViews();
    });
  });

  // 2. Agenda
  document.querySelectorAll('.agenda-journal-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      agendaFilterState.journal = chip.dataset.journal;
      document.querySelectorAll('.agenda-journal-chip').forEach(c => {
        c.classList.toggle('active', c.dataset.journal === agendaFilterState.journal);
      });
      if (agendaTtData) renderAgendaTimeline(agendaTtData, false);
    });
  });

  async function renderPlanCatalogList() {
    const listEl = document.getElementById('planCatalogList');
    if (!listEl) return;
    const items = await fetchCatalogListOnce();
    if (!items) {
      listEl.innerHTML = '<div class="lib-empty">Impossible de charger la bibliothèque.</div>';
      return;
    }
    const term = normalizeSearch(planCatalogSearch.trim());
    const filtered = items.filter((o) => {
      if (planCatalogFilter !== 'all' && o.category !== planCatalogFilter) return false;
      

      if (term && !normalizeSearch(o.name).includes(term)) return false;
      return true;
    });
    listEl.innerHTML = filtered.length
      ? filtered.map(planRowHtml).join('')
      : '<div class="lib-empty">Aucun objet ne correspond.</div>';
  }

  function renderPlanSelectedList() {
    const listEl = document.getElementById('planSelectedList');
    const emptyEl = document.getElementById('planSelectedEmpty');
    if (!listEl) return;
    if (planSelectedNames.size === 0) {
      listEl.innerHTML = '';
      if (emptyEl) emptyEl.classList.remove('hidden');
      return;
    }
    if (emptyEl) emptyEl.classList.add('hidden');
    listEl.innerHTML = Array.from(planSelectedNames).map((name) => {
      const item = catalogList && catalogList.find((o) => o.name === name);
      const color = item ? (CATEGORY_COLOR_VAR[item.category] || 'var(--text-muted)') : 'var(--text-muted)';
      const nameAttr = name.replace(/"/g, '&quot;');
      const seenBadge = getObjectJournalStatus(name) === 'seen'
        ? ' <span class="lib-row-vu-badge">VU</span>'
        : '';
      const scheduleLine = planScheduleLineHtml(name);
      return `
        <div class="lib-row" data-name="${nameAttr}">
          <span class="lib-row-dot" style="background:${color}"></span>
          <span class="lib-row-main">
            <span class="lib-row-name">${name}${seenBadge}</span>
            ${scheduleLine}
          </span>
          <button type="button" class="lib-fav-btn active" data-name="${nameAttr}" title="Retirer du plan">
            <i class='bx bx-x'></i>
          </button>
        </div>
      `;
    }).join('');
  }

  function handlePlanRowClick(e) {
    const btn = e.target.closest('.lib-fav-btn');
    if (btn && btn.dataset.name) {
      // Clic sur le bouton en bout de ligne : on ajoute/retire du plan.
      e.stopPropagation();
      togglePlanObject(btn.dataset.name);
      return;
    }
    // Clic ailleurs sur la ligne : on ouvre la fiche détaillée de l'objet,
    // sans modifier la sélection du plan (comme dans la Bibliothèque).
    const row = e.target.closest('.lib-row');
    const name = row && row.dataset.name;
    if (!name) return;
    const catalogItem = catalogList && catalogList.find((o) => o.name === name);
    if (!catalogItem) return;
    const planLoc = getPlanLocation();
    const planPhaseCtx = { dateStr: planCurrentDate, lat: planLoc.lat, lon: planLoc.lon, elev: planLoc.elev };
    openInfo(catalogItem, planPhaseCtx);
  }

  const planCatalogListEl = document.getElementById('planCatalogList');
  if (planCatalogListEl) planCatalogListEl.addEventListener('click', handlePlanRowClick);
  const planSelectedListEl = document.getElementById('planSelectedList');
  if (planSelectedListEl) planSelectedListEl.addEventListener('click', handlePlanRowClick);

  const planSearchInputEl = document.getElementById('planSearchInput');
  if (planSearchInputEl) {
    planSearchInputEl.addEventListener('input', () => {
      planCatalogSearch = planSearchInputEl.value;
      renderPlanCatalogList();
    });
  }
  document.querySelectorAll('.plan-filter-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      planCatalogFilter = chip.dataset.cat;
      document.querySelectorAll('.plan-filter-chip').forEach((c) => c.classList.toggle('active', c === chip));
      renderPlanCatalogList();
    });
  });

  const planPrevDayBtn = document.getElementById('planPrevDay');
  if (planPrevDayBtn) planPrevDayBtn.addEventListener('click', () => {
    const d = new Date(planCurrentDate);
    d.setDate(d.getDate() - 1);
    loadPlan(toDateStr(d));
  });
  const planNextDayBtn = document.getElementById('planNextDay');
  if (planNextDayBtn) planNextDayBtn.addEventListener('click', () => {
    const d = new Date(planCurrentDate);
    d.setDate(d.getDate() + 1);
    loadPlan(toDateStr(d));
  });
  if (planDateInputEl()) {
    planDateInputEl().addEventListener('change', () => {
      const v = planDateInputEl().value;
      if (v) loadPlan(v);
    });
  }
  const planSaveBtnEl = document.getElementById('planSaveBtn');
  if (planSaveBtnEl) planSaveBtnEl.addEventListener('click', savePlan);
  const planDeleteBtnEl = document.getElementById('planDeleteBtn');
  if (planDeleteBtnEl) planDeleteBtnEl.addEventListener('click', deleteCurrentPlan);

  async function loadPlanDatesRange() {
    try {
      const res = await fetch(`/api/plans/range?start_date=${toDateStr(today0)}&end_date=${toDateStr(agendaLastDay)}`);
      if (!res.ok) return;
      const data = await res.json();
      planDatesWithPlan = data.counts || {};
      renderAgendaCalendar();
    } catch (e) {
      // silencieux : le badge est un bonus, pas une fonctionnalité bloquante
    }
  }

  // ---------- Journal (historique des observations : vu / tentative échouée) ----------

  function fmtJournalDate(dateStr) {
    const d = new Date(`${dateStr}T00:00:00`);
    return d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  }

  async function loadJournal() {
    try {
      const res = await fetch('/api/journal');
      if (!res.ok) return;
      const data = await res.json();
      journalEntries = data.entries || [];
      journalDatesSet = new Set(journalEntries.map((e) => e.date));
      renderJournalList();
      renderAgendaCalendar();
    } catch (e) {
      // silencieux : hors-ligne / erreur réseau
    }
  }

  function renderJournalList() {
    const listEl = document.getElementById('journalList');
    const emptyEl = document.getElementById('journalEmpty');
    if (!listEl) return;

    if (journalEntries.length === 0) {
      listEl.innerHTML = '';
      if (emptyEl) emptyEl.classList.remove('hidden');
      return;
    }
    if (emptyEl) emptyEl.classList.add('hidden');

    listEl.innerHTML = journalEntries.map((e) => {
      const color = CATEGORY_COLOR_VAR[e.category] || 'var(--text-muted)';
      const statusLabel = e.status === 'failed' ? 'Échec' : 'Vu';
      const statusClass = e.status === 'failed' ? 'journal-row-status-failed' : 'journal-row-status-seen';
      const when = e.time ? `${fmtJournalDate(e.date)} · ${e.time}` : fmtJournalDate(e.date);
      return `
        <div class="lib-row">
          <span class="lib-row-dot" style="background:${color}"></span>
          <div class="lib-row-main">
            <span class="lib-row-name">${e.object_name}</span>
            <span class="lib-row-when">${when}</span>
          </div>
          <span class="journal-row-status ${statusClass}">${statusLabel}</span>
          <button type="button" class="journal-row-del" data-id="${e.id}" title="Supprimer">
            <i class='bx bx-trash'></i>
          </button>
        </div>
      `;
    }).join('');

    listEl.querySelectorAll('.journal-row-del').forEach((btn) => {
      btn.addEventListener('click', () => deleteJournalEntry(parseInt(btn.dataset.id, 10)));
    });
  }

  async function addJournalEntry(payload) {
    const res = await fetch('/api/journal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error('add failed');
    await loadJournal();
  }

  async function deleteJournalEntry(id) {
    try {
      const res = await fetch(`/api/journal/${id}`, { method: 'DELETE' });
      if (res.ok) await loadJournal();
    } catch (e) {
      // best effort
    }
  }

  // ---------- Journal : bottom sheet d'ajout manuel ----------
  const journalAddOverlay = document.getElementById('journalAddOverlay');
  const journalAddBtn = document.getElementById('journalAddBtn');
  const journalAddClose = document.getElementById('journalAddClose');
  const journalAddSubmit = document.getElementById('journalAddSubmit');
  const journalNameInput = document.getElementById('journalNameInput');
  const journalDateInput = document.getElementById('journalDateInput');
  const journalTimeInput = document.getElementById('journalTimeInput');
  const journalAddError = document.getElementById('journalAddError');
  const journalStatusToggle = document.getElementById('journalStatusToggle');
  let journalAddStatus = 'seen';

  if (journalStatusToggle) {
    journalStatusToggle.querySelectorAll('.level-mode-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        journalAddStatus = btn.dataset.status;
        journalStatusToggle.querySelectorAll('.level-mode-btn').forEach((b) => b.classList.toggle('active', b === btn));
      });
    });
  }


let journalSuggestCatalog = null;

async function ensureJournalSuggestCatalog() {
  if (journalSuggestCatalog) return journalSuggestCatalog;
  journalSuggestCatalog = (await fetchCatalogListOnce()) || [];
  return journalSuggestCatalog;
}

function renderJournalNameSuggestions(term) {
  const box = document.getElementById('journalNameSuggestions');
  if (!box) return;
  const norm = normalizeSearch((term || '').trim());
  const filtered = (norm
    ? (journalSuggestCatalog || []).filter((o) => normalizeSearch(o.name).includes(norm))
    : (journalSuggestCatalog || [])
  ).slice(0, 8);

  if (filtered.length === 0) { box.innerHTML = ''; box.classList.add('hidden'); return; }
  box.innerHTML = filtered.map((o) =>
    `<div class="journal-name-suggestion-item" data-name="${o.name.replace(/"/g, '&quot;')}">${o.name}</div>`
  ).join('');
  box.classList.remove('hidden');
}

function hideJournalNameSuggestions() {
  const box = document.getElementById('journalNameSuggestions');
  if (box) { box.classList.add('hidden'); box.innerHTML = ''; }
}

if (journalNameInput) {
  journalNameInput.addEventListener('input', () => renderJournalNameSuggestions(journalNameInput.value));
  journalNameInput.addEventListener('focus', () => {
    ensureJournalSuggestCatalog().then(() => renderJournalNameSuggestions(journalNameInput.value));
  });
}
const journalNameSuggestionsEl = document.getElementById('journalNameSuggestions');
if (journalNameSuggestionsEl) {
  journalNameSuggestionsEl.addEventListener('click', (e) => {
    const item = e.target.closest('.journal-name-suggestion-item');
    if (!item) return;
    journalNameInput.value = item.dataset.name;
    hideJournalNameSuggestions();
  });
}
document.addEventListener('click', (e) => {
  if (!journalAddOverlay || journalAddOverlay.classList.contains('hidden')) return;
  if (e.target === journalNameInput || (journalNameSuggestionsEl && journalNameSuggestionsEl.contains(e.target))) return;
  hideJournalNameSuggestions();
});

  function openJournalAdd(prefillName) {
    if (!journalAddOverlay) return;
    if (journalAddError) journalAddError.classList.add('hidden');
    journalNameInput.value = prefillName || '';
    journalDateInput.value = toDateStr(new Date());
    journalTimeInput.value = '';
    journalAddStatus = 'seen';
    if (journalStatusToggle) {
      journalStatusToggle.querySelectorAll('.level-mode-btn').forEach((b) => b.classList.toggle('active', b.dataset.status === 'seen'));
    }
    hideJournalNameSuggestions();
    ensureJournalSuggestCatalog(); // remplace populateJournalDatalist()
    journalAddOverlay.classList.remove('hidden');
  }

  function closeJournalAdd() {
    if (journalAddOverlay) journalAddOverlay.classList.add('hidden');
    hideJournalNameSuggestions();
  }

  if (journalAddBtn) journalAddBtn.addEventListener('click', () => openJournalAdd());
  if (journalAddClose) journalAddClose.addEventListener('click', closeJournalAdd);
  if (journalAddOverlay) {
    journalAddOverlay.addEventListener('click', (e) => {
      if (e.target.id === 'journalAddOverlay') closeJournalAdd();
    });
  }
  if (journalAddSubmit) {
    journalAddSubmit.addEventListener('click', async () => {
      const name = (journalNameInput.value || '').trim();
      if (!name) {
        journalAddError.textContent = 'Indique le nom de l\u2019objet.';
        journalAddError.classList.remove('hidden');
        return;
      }
      const status = journalAddStatus;
      const catalogItem = (catalogList || []).find((o) => o.name.toLowerCase() === name.toLowerCase());
      const category = catalogItem ? catalogItem.category : '';
      journalAddSubmit.disabled = true;
      try {
        await addJournalEntry({
          name, category, status,
          date: journalDateInput.value || toDateStr(new Date()),
          time: journalTimeInput.value || '',
        });
        closeJournalAdd();
      } catch (e) {
        journalAddError.textContent = 'Impossible d\u2019ajouter cette observation.';
        journalAddError.classList.remove('hidden');
      } finally {
        journalAddSubmit.disabled = false;
      }
    });
  }

  // ---------- Timeline du plan : n'affiche que les objets choisis pour la
  // nuit prévue, avec la now-line si on est aujourd'hui et dans la bonne
  // plage horaire (même logique que la timetable de l'agenda). ----------
  let planTtData = null;
  let planTlZoomMode = 'auto';
  let planTlZoomLevel = 1;

  function updatePlanOpenTimelineBtn() {
    const btn = document.getElementById('planOpenTimelineBtn');
    if (btn) btn.classList.toggle('hidden', planSelectedNames.size === 0);
  }

  function positionPlanTtLoadingOverlay() {
    const overlay = document.getElementById('planTtLoadingOverlay');
    if (!overlay) return;
    const topbar = document.querySelector('.topbar');
    const topbarH = topbar ? topbar.offsetHeight : 0;
    const navH = bottomNav ? bottomNav.offsetHeight : 0;
    overlay.style.top = `${topbarH}px`;
    overlay.style.bottom = `${navH}px`;
  }

  function showPlanTtLoading(msg) {
    const overlay = document.getElementById('planTtLoadingOverlay');
    const text = document.getElementById('planTtLoadingText');
    if (!overlay) return;
    if (text && msg) text.textContent = msg;
    positionPlanTtLoadingOverlay();
    overlay.classList.remove('hidden');
  }

  function hidePlanTtLoading() {
    const overlay = document.getElementById('planTtLoadingOverlay');
    if (overlay) overlay.classList.add('hidden');
  }

  function openPlanTimetable() {
    if (planSelectedNames.size === 0) return;
    document.getElementById('planMainView').classList.add('hidden');
    document.getElementById('planTimetableView').classList.remove('hidden');
    planTlZoomMode = 'auto';
    loadPlanTimetable();
  }

  function closePlanTimetable() {
    hidePlanTtLoading();
    document.getElementById('planTimetableView').classList.add('hidden');
    document.getElementById('planMainView').classList.remove('hidden');
  }

  async function loadPlanTimetable() {
    const dateStr = planCurrentDate;
    const dateLabel = document.getElementById('planTtDate');
    const hours = document.getElementById('planTlHours');
    const wrap = document.getElementById('planTlWrap');
    const lanes = document.getElementById('planTlLanes');

    const d = new Date(dateStr);
    dateLabel.textContent = d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });

    hours.innerHTML = '';
    wrap.style.height = '220px';
    lanes.style.height = '220px';
    lanes.style.backgroundImage = 'none';
    lanes.innerHTML = '';
    ['planSunsetLine', 'planSunriseLine', 'planNowLine'].forEach((id) => {
      document.getElementById(id).style.display = 'none';
    });
    const countEl = document.getElementById('planTtCount');
    if (countEl) countEl.textContent = '';
    showPlanTtLoading('Chargement du programme…');

    try {
      const s = planCurrentSettings || {};
      const { lat, lon, elev } = getPlanLocation();
      if (lat === null || lon === null || isNaN(lat) || isNaN(lon)) {
        hidePlanTtLoading();
        lanes.innerHTML = '<div class="lib-empty">Aucune position définie pour ce plan.</div>';
        return;
      }
      const url = buildSkyUrl(lat, lon, elev, dateStr, s);
      const res = await fetch(url);
      if (!res.ok) throw new Error();
      const data = await res.json();

      if (planCurrentDate !== dateStr) return;

      planTtData = data;
      hidePlanTtLoading();
      const visible = (data.objects || []).filter((o) => planSelectedNames.has(o.name));
      if (visible.length === 0) {
        lanes.innerHTML = '<div class="lib-empty">Aucun des objets prévus n\u2019est visible cette nuit-là.</div>';
        if (countEl) countEl.textContent = 'Aucun objet visible';
      } else {
        renderPlanTimeline(data);
        positionPlanNowLine(data);
        positionPlanSunLines(data);
      }
    } catch (e) {
      if (planCurrentDate === dateStr) {
        hidePlanTtLoading();
        lanes.innerHTML = '<div class="lib-empty">Impossible de charger le programme.</div>';
      }
    }
  }

  // Réimplémentation JS de assign_lanes() (app.py) : coloration gloutonne
  // d'intervalles pour ne pas superposer deux objets qui se chevauchent,
  // mais sur un sous-ensemble d'objets seulement (compacte les numéros de
  // lane pour éviter les colonnes vides quand on filtre).
  function assignCompactLanes(objects) {
    const sorted = [...objects].sort((a, b) => new Date(a.rise_iso) - new Date(b.rise_iso));
    const laneEndIso = [];
    return sorted.map((o) => {
      let placed = false;
      let lane = laneEndIso.length;
      for (let i = 0; i < laneEndIso.length; i++) {
        if (o.rise_iso >= laneEndIso[i]) {
          lane = i;
          laneEndIso[i] = o.set_iso;
          placed = true;
          break;
        }
      }
      if (!placed) laneEndIso.push(o.set_iso);
      return { ...o, lane };
    });
  }

  function computePlanFitZoom(data) {
    const wrap = document.getElementById('planTlWrap');
    const start = new Date(data.window_start).getTime();
    const end = new Date(data.window_end).getTime();
    const totalMin = (end - start) / 60000;
    if (!totalMin || totalMin <= 0) return 1;

    const navH = bottomNav ? bottomNav.offsetHeight : 0;
    const wrapTop = wrap.getBoundingClientRect().top;
    const buffer = 20;
    const availableHeight = Math.max(window.innerHeight - wrapTop - navH - buffer, 100);

    const fit = (availableHeight - 20) / (totalMin * BASE_PX_PER_MIN);
    return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, fit));
  }

  function renderPlanTimeline(data, recomputeZoom = true) {
    const hours = document.getElementById('planTlHours');
    const lanesScroll = document.getElementById('planTlLanesScroll');
    const lanes = document.getElementById('planTlLanes');
    const wrap = document.getElementById('planTlWrap');
    hours.innerHTML = '';
    lanes.innerHTML = '';

    if (planTlZoomMode === 'auto' && recomputeZoom) {
      planTlZoomLevel = computePlanFitZoom(data);
    }
    const fitBtn = document.getElementById('planZoomFit');
    if (fitBtn) fitBtn.classList.toggle('active', planTlZoomMode === 'auto');

    const pxPerMin = BASE_PX_PER_MIN * planTlZoomLevel;
    const start = new Date(data.window_start).getTime();
    const end = new Date(data.window_end).getTime();
    const totalMin = (end - start) / 60000;
    const totalPx = Math.max(totalMin * pxPerMin, 300);
    const hourPx = 60 * pxPerMin;

    hours.style.height = `${totalPx}px`;
    lanes.style.height = `${totalPx}px`;
    wrap.style.height = `${totalPx + 15}px`;

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

    // Ne garde que les objets choisis pour ce plan : c'est tout l'intérêt
    // de cette timeline dédiée par rapport à celle de l'agenda. Les lanes
    // renvoyées par le serveur sont calculées sur TOUS les objets de la
    // nuit ; une fois filtrés sur la sélection du plan, elles seraient
    // éparses (ex: lane 0 et lane 6 sur 8) et laisseraient des colonnes
    // vides. On réassigne donc des lanes compactes, localement, en ne
    // tenant compte que des objets affichés, pour occuper toute la largeur.
    const rawVisible = (data.objects || []).filter((o) => planSelectedNames.has(o.name));
    const visibleObjects = assignCompactLanes(rawVisible);
    const countEl = document.getElementById('planTtCount');
    if (countEl) {
      countEl.textContent = `${visibleObjects.length} objet${visibleObjects.length > 1 ? 's' : ''} prévu${visibleObjects.length > 1 ? 's' : ''}`;
    }

    const laneCount = Math.max(visibleObjects.reduce((max, o) => Math.max(max, o.lane + 1), 0), 1);
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

    visibleObjects.forEach((o) => {
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
      // La phase (lune/planètes) doit refléter la nuit et le lieu du plan
      // prévu, pas "maintenant" : on transmet la date du plan ainsi que son
      // lieu (manuel si défini, sinon lieu courant de l'app).
      const planLoc = getPlanLocation();
      const planPhaseCtx = { dateStr: planCurrentDate, lat: planLoc.lat, lon: planLoc.lon, elev: planLoc.elev };
      block.addEventListener('click', () => openInfo(o, planPhaseCtx));

      lanes.appendChild(block);
    });

    const pctEl = document.getElementById('planZoomPct');
    if (pctEl) pctEl.textContent = `${Math.round(planTlZoomLevel * 100)}%`;
  }

  function positionPlanNowLine(data) {
    const nowLine = document.getElementById('planNowLine');
    const start = new Date(data.window_start).getTime();
    const end = new Date(data.window_end).getTime();
    const now = Date.now();
    if (now < start || now > end) {
      nowLine.style.display = 'none';
      return;
    }
    nowLine.style.display = 'block';
    const pxPerMin = BASE_PX_PER_MIN * planTlZoomLevel;
    nowLine.style.top = `${((now - start) / 60000) * pxPerMin}px`;
  }

  function positionPlanSunLines(data) {
    const sunsetLine = document.getElementById('planSunsetLine');
    const sunriseLine = document.getElementById('planSunriseLine');
    const pxPerMin = BASE_PX_PER_MIN * planTlZoomLevel;
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

  function setPlanZoom(newZoom) {
    if (!planTtData) return;
    planTlZoomMode = 'manual';
    planTlZoomLevel = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, newZoom));
    renderPlanTimeline(planTtData);
    positionPlanNowLine(planTtData);
    positionPlanSunLines(planTtData);
  }

  function resetPlanZoomToFit() {
    if (!planTtData) return;
    planTlZoomMode = 'auto';
    renderPlanTimeline(planTtData);
    positionPlanNowLine(planTtData);
    positionPlanSunLines(planTtData);
  }

  const planOpenTimelineBtnEl = document.getElementById('planOpenTimelineBtn');
  if (planOpenTimelineBtnEl) planOpenTimelineBtnEl.addEventListener('click', openPlanTimetable);
  const planTtCloseEl = document.getElementById('planTtClose');
  if (planTtCloseEl) planTtCloseEl.addEventListener('click', closePlanTimetable);
  const planZoomFitEl = document.getElementById('planZoomFit');
  if (planZoomFitEl) planZoomFitEl.addEventListener('click', resetPlanZoomToFit);
  const planZoomInEl = document.getElementById('planZoomIn');
  if (planZoomInEl) planZoomInEl.addEventListener('click', () => setPlanZoom(planTlZoomLevel + 0.25));
  const planZoomOutEl = document.getElementById('planZoomOut');
  if (planZoomOutEl) planZoomOutEl.addEventListener('click', () => setPlanZoom(planTlZoomLevel - 0.25));

  let planNowLineTimer = setInterval(() => {
    if (planTtData && !document.getElementById('planTimetableView').classList.contains('hidden')) {
      positionPlanNowLine(planTtData);
    }
  }, 30000);

  window.addEventListener('resize', () => {
    const overlay = document.getElementById('planTtLoadingOverlay');
    if (overlay && !overlay.classList.contains('hidden')) positionPlanTtLoadingOverlay();
  });

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
    document.querySelectorAll('#toolLevel .level-mode-btn').forEach((btn) => {
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

  document.querySelectorAll('#toolLevel .level-mode-btn').forEach((btn) => {
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
    let hourAngle = lstHours - POLARIS_RA_HOURS; // hours (0..24)
    hourAngle = ((hourAngle % 24) + 24) % 24;
    const hourAngle12 = hourAngle % 12; // cadran 12h : Polaris fait 2 tours par jour sidéral
    const angleDeg = hourAngle12 * 30; // 0..360, 30°/heure sur un cadran de 12h

    // Convention: HA=0 -> Polaris at top (12 o'clock) as seen looking at the pole,
    // increasing HA rotates clockwise.
    const cx = 100, cy = 100, r = 82;
    const rad = (angleDeg - 90) * Math.PI / 180;
    const px = cx + r * Math.cos(rad);
    const py = cy + r * Math.sin(rad);

    let svgMarkup = `
      <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="var(--hairline)" stroke-width="1"/>
    `;

    // Graduations : petites toutes les heures, moyennes toutes les 3h, grandes toutes les 6h (cadran 12h)
    for (let h = 0; h < 12; h++) {
      const a = (h * 30 - 90) * Math.PI / 180;
      const isMajor = h % 6 === 0; // 12h et 6h
      const isMedium = !isMajor && h % 3 === 0; // 3h et 9h
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
    ['12','3','6','9'].forEach((h) => {
      const a = (Number(h) * 30 - 90) * Math.PI / 180;
      const lx = cx + (r + 12) * Math.cos(a);
      const ly = cy + (r + 12) * Math.sin(a);
      svgMarkup += `<text x="${lx}" y="${ly}" fill="var(--text-muted)" font-size="9" font-family="var(--font-mono)" text-anchor="middle" dominant-baseline="middle">${h}h</text>`;
    });
    svg.innerHTML = svgMarkup;

    readout.textContent = `HA ${hourAngle12.toFixed(2)}h (12h) · LST ${lstHours.toFixed(2)}h`;
  }

  function startPolarClock() {
    drawPolarClock();
    polarTimer = setInterval(drawPolarClock, 15000);
  }

// ---------- Bootstrap ----------
  // Au premier chargement (ouverture de l'application), on affiche d'abord
  // un écran de confirmation des paramètres (localisation / plage horaire /
  // altitude minimale) avant de lancer le calcul. Ce comportement ne
  // s'applique qu'à l'ouverture : le bouton ⟳ (refreshBtn) et "Try again"
  // (retryBtn) appellent resolveLocation() directement et ne repassent pas
  // par cet écran.
  async function bootstrapConfirmFlow() {
    //statusPanel.classList.remove('hidden');
    renderStepDots();
    setStatus('Chargement des paramètres…');
    setStep(0);
    try { await loadSettingsFromServer(); } catch (e) { /* valeurs par défaut conservées */ }
    try { await loadFavorites(); } catch (e) { /* best effort */ }

    // Si ce reload fait suite à un enregistrement explicite depuis l'écran
    // Paramètres (commitSettingsAndReload), on ne redemande pas confirmation :
    // les valeurs viennent d'être validées par l'utilisateur.
    let skipConfirm = false;
    try { skipConfirm = sessionStorage.getItem('skyme_skip_confirm') === '1'; } catch (e) { /* ignore */ }
    if (skipConfirm) {
      try { sessionStorage.removeItem('skyme_skip_confirm'); } catch (e) { /* ignore */ }
      await runLoadSequence();
      return;
    }

    populateConfirmPanel();
    confirmStartBtn.disabled = false;
    confirmStartBtn.textContent = 'Commencer';
    statusPanel.classList.add('hidden');
    confirmPanel.classList.remove('hidden');
  }

  // Écran de chargement : l'app ne s'ouvre qu'une fois TOUT reçu, y compris
  // la bibliothèque (horaires lever/coucher de chaque objet) et les stats
  // du catalogue. Chaque étape avance la barre de progression ; une fois
  // toutes les étapes terminées, on révèle l'app d'un coup — plus aucune
  // surprise ensuite tant que les réglages ne sont pas explicitement
  // sauvegardés (voir commitSettingsAndReload). Appelé une fois les
  // paramètres confirmés par l'utilisateur (voir confirmStartBtn ci-dessus).
  async function runLoadSequence() {
    const steps = [
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
      ['Chargement de l\u2019agenda…', loadAgendaFavCounts],
      ['Chargement des plans…', loadPlanDatesRange],
      ['Chargement du journal…', loadJournal],
    ];

    // Le point 0 (Paramètres) a déjà été marqué "fait" par bootstrapConfirmFlow ;
    // les étapes de ce tableau occupent donc les points 1 à steps.length.
    for (let i = 0; i < steps.length; i++) {
      const [label, fn] = steps[i];
      setStatus(label);
      setStep(i + 1);
      try { await fn(); } catch (e) { /* on continue : app offline-friendly */ }
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

    // Dernière étape : un point supplémentaire "succès" s'allume et un
    // message confirme que tout est prêt, affiché 2 secondes avant
    // d'ouvrir l'app (pas de nouvelle surprise ensuite : initialLoadDone
    // n'est mis à true qu'après ce délai).
    setStep(LOAD_STEPS.length - 1, { success: true });
    setStatus('Tout est prêt !');
    if (statusPanel) statusPanel.classList.add('status-panel-success');
    await new Promise((resolve) => setTimeout(resolve, 2000));
    if (statusPanel) statusPanel.classList.remove('status-panel-success');

    initialLoadDone = true;
    showAppShell();

    // Le zoom "fit" calculé pendant le chargement (DOM encore caché) est
    // faux : on le recalcule maintenant que mainContent/bottomNav/#app sont
    // réellement visibles et ont leurs vraies dimensions. On attend une
    // frame supplémentaire (requestAnimationFrame) pour être certain que le
    // navigateur a bien appliqué le retrait de la classe "hidden" et calculé
    // le nouveau layout avant de lire les dimensions (getBoundingClientRect /
    // offsetHeight) : sans ce délai, le calcul pouvait encore tomber sur
    // l'ancien layout (display:none) et produire un zoom "auto" trop élevé,
    // ce qui faisait apparaître le coucher de soleil très bas dans la
    // timeline juste après l'initialisation.
    if (currentData) {
      requestAnimationFrame(() => {
        renderTimeline(currentData);
        positionNowLine(currentData);
        positionSunLines(currentData);
        requestAnimationFrame(() => {
          renderTimeline(currentData);
          positionNowLine(currentData);
          positionSunLines(currentData);
        });
      });

      // Le double requestAnimationFrame ne suffit pas : au premier chargement,
      // les polices web (Cormorant Garamond / Inter / IBM Plex Mono) ne sont pas
      // forcément encore appliquées, ce qui change la hauteur de la topbar et
      // du header de date (tl-date) une fois qu'elles finissent de charger.
      // computeFitZoom() (basé sur tlWrap.getBoundingClientRect().top) avait
      // donc calculé son "fit" sur un layout encore provisoire, plus haut que
      // le layout final : une fois les polices appliquées, tlWrap descendait
      // légèrement, mais le zoom déjà calculé restait figé jusqu'au prochain
      // clic manuel sur "fit" — d'où la ligne sunrise/sunset affichée trop
      // bas tant qu'on ne relance pas le calcul soi-même. On attend donc que
      // les polices soient prêtes (document.fonts.ready) puis on recalcule
      // une dernière fois.
      if (document.fonts && document.fonts.ready) {
        document.fonts.ready.then(() => {
          if (!currentData || zoomMode !== 'auto') return;
          renderTimeline(currentData);
          positionNowLine(currentData);
          positionSunLines(currentData);
        });
      }
    }
    
    

    renderLibraryList();
    renderOverviewFavorites();
    startLibraryCountdownTimer();
  }
  function getObjectJournalStatus(name) {
  if (!journalEntries || journalEntries.length === 0) return 'unattempted';
  // Trouve toutes les entrées du journal pour cet objet
  const entries = journalEntries.filter(e => e.object_name === name);
  if (entries.length === 0) return 'unattempted';
  // Si au moins une entrée est marquée 'seen', on considère l'objet comme vu
  if (entries.some(e => e.status === 'seen')) return 'seen';
  // Sinon (il n'a que des entrées 'failed'), c'est un échec
  return 'failed';
}
  switchView('overview')
  bootstrapConfirmFlow();
  console.log(zoomMode)
  resetZoomToFit();
})();

function loadingBlockHtml(msg, abs = false) {
  return `<div class="locked-state${abs ? ' locked-state-abs' : ''}"><div class="spinner"></div><p>${msg}</p></div>`;
}

// NB : #app est désormais révélé directement dans showAppShell() (voir
// plus haut), au même moment que mainContent/bottomNav, et non plus via un
// setTimeout(100) indépendant. Ce découplage faisait que le recalcul du
// zoom "auto" (computeFitZoom) s'exécutait pendant que #app avait encore
// `display: none`, donnant des mesures de layout nulles/fausses et un
// zoom bien trop élevé : la timeline devenait beaucoup plus haute que
// l'écran et le coucher de soleil se retrouvait très bas, hors de vue.