const DEFAULT_COORDS = {
  latitude: -1.228552,
  longitude: 116.881761,
  accuracy: null,
  source: 'default',
};

const state = {
  appCsrfToken: '',
  csrfToken: '',
  locations: [],
  settings: {
    defaultLocationId: '',
    workingFrom: '',
    scheduleEnabled: false,
    checkInTime: '09:00',
    checkOutTime: '18:00',
    randomCheckInEnabled: false,
    randomCheckOutEnabled: false,
    randomPhotoEnabled: false,
    selectedPhotoId: '',
    checkInStartTime: '08:45',
    checkInEndTime: '09:00',
    checkOutStartTime: '17:45',
    checkOutEndTime: '18:15',
  },
  coords: { ...DEFAULT_COORDS },
  imageBase64: '',
  selectedPhotoId: '',
  randomPhotoEnabled: false,
  photos: [],
  modal: null,
  clockOutOptions: null,
  scheduledAction: '',
  scheduleDetailsExpanded: localStorage.getItem('hris-schedule-details-expanded') !== '0',
  photoSettingsSaveId: 0,
  photoSettingsSaveQueue: Promise.resolve(),
  stream: null,
};

const els = {
  loginForm: document.querySelector('#loginForm'),
  loginFields: document.querySelector('#loginFields'),
  email: document.querySelector('#email'),
  password: document.querySelector('#password'),
  sessionStatus: document.querySelector('#sessionStatus'),
  refreshSession: document.querySelector('#refreshSession'),
  logout: document.querySelector('#logout'),
  hrisClock: document.querySelector('#hrisClock'),
  hrisDate: document.querySelector('#hrisDate'),
  hrisStatus: document.querySelector('#hrisStatus'),
  hrisClockInAt: document.querySelector('#hrisClockInAt'),
  locationSelect: document.querySelector('#locationSelect'),
  workingFrom: document.querySelector('#workingFrom'),
  officeName: document.querySelector('#officeName'),
  officeCoords: document.querySelector('#officeCoords'),
  saveSettings: document.querySelector('#saveSettings'),
  scheduleEnabled: document.querySelector('#scheduleEnabled'),
  scheduleCollapse: document.querySelector('#scheduleCollapse'),
  scheduleInfo: document.querySelector('#scheduleInfo'),
  scheduleDetails: document.querySelector('#scheduleDetails'),
  checkInTime: document.querySelector('#checkInTime'),
  checkOutTime: document.querySelector('#checkOutTime'),
  randomCheckInEnabled: document.querySelector('#randomCheckInEnabled'),
  randomCheckOutEnabled: document.querySelector('#randomCheckOutEnabled'),
  checkInStartTime: document.querySelector('#checkInStartTime'),
  checkInEndTime: document.querySelector('#checkInEndTime'),
  checkOutStartTime: document.querySelector('#checkOutStartTime'),
  checkOutEndTime: document.querySelector('#checkOutEndTime'),
  saveSchedule: document.querySelector('#saveSchedule'),
  cameraBox: document.querySelector('#cameraBox'),
  startCamera: document.querySelector('#startCamera'),
  snap: document.querySelector('#snap'),
  photoLabel: document.querySelector('#photoLabel'),
  savePhoto: document.querySelector('#savePhoto'),
  randomPhoto: document.querySelector('#randomPhoto'),
  refreshPhotos: document.querySelector('#refreshPhotos'),
  photoList: document.querySelector('#photoList'),
  selectedPhotoInfo: document.querySelector('#selectedPhotoInfo'),
  getLocation: document.querySelector('#getLocation'),
  clockIn: document.querySelector('#clockIn'),
  clockOut: document.querySelector('#clockOut'),
  video: document.querySelector('#video'),
  canvas: document.querySelector('#canvas'),
  preview: document.querySelector('#preview'),
  geoStatus: document.querySelector('#geoStatus'),
  modalInfo: document.querySelector('#modalInfo'),
  clockOutInfo: document.querySelector('#clockOutInfo'),
  refreshClockOut: document.querySelector('#refreshClockOut'),
  fixBox: document.querySelector('#fixBox'),
  fixClockOutTime: document.querySelector('#fixClockOutTime'),
  fixClockOutNote: document.querySelector('#fixClockOutNote'),
  log: document.querySelector('#log'),
};

function log(message, data) {
  const time = new Date().toLocaleTimeString('id-ID');
  const extra = data ? `\n${JSON.stringify(data, null, 2)}` : '';
  els.log.textContent = `[${time}] ${message}${extra}`;
}

function renderGeoStatus() {
  const suffix = state.coords.source === 'default' ? ' (default)' : '';
  els.geoStatus.textContent = `${state.coords.latitude.toFixed(6)}, ${state.coords.longitude.toFixed(6)}${suffix}`;
}

function setLoginVisible(visible) {
  els.loginForm.hidden = !visible;
  els.loginFields.hidden = !visible;
  els.email.required = visible;
  els.password.required = visible;
  els.refreshSession.hidden = visible;
  els.logout.hidden = visible;
  document.body.classList.toggle('session-ready', !visible);
}

function resetHrisState() {
  state.csrfToken = '';
  state.locations = [];
  state.modal = null;
  state.clockOutOptions = null;
  state.imageBase64 = '';
  state.selectedPhotoId = '';
  state.randomPhotoEnabled = false;
  els.hrisClock.textContent = '--:--';
  els.hrisDate.textContent = '-';
  els.hrisStatus.textContent = 'Belum login';
  els.hrisClockInAt.textContent = '-';
  els.modalInfo.textContent = 'Login dulu untuk load opsi';
  els.clockOutInfo.textContent = 'Belum dicek';
  els.locationSelect.innerHTML = '';
  els.fixBox.hidden = true;
  hideCameraBox();
  renderPhotos();
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(state.appCsrfToken ? { 'X-App-CSRF-Token': state.appCsrfToken } : {}),
      ...(options.headers || {}),
    },
  });
  const responseText = await response.text();
  let payload = null;

  try {
    payload = responseText ? JSON.parse(responseText) : {};
  } catch {
    const message = responseText || response.statusText || 'Response bukan JSON';
    throw new Error(`${path} gagal (${response.status}): ${message}`);
  }

  if (!response.ok || payload.status === 'error') {
    throw new Error(payload.message || `${path} gagal`);
  }
  return payload;
}

async function loadBootstrap() {
  const payload = await api('/api/bootstrap');
  state.appCsrfToken = payload.appCsrfToken || '';
}

function renderSettings() {
  const storedRandomPhoto = localStorage.getItem('hris-random-photo-enabled');
  const storedSelectedPhotoId = localStorage.getItem('hris-selected-photo-id');
  state.randomPhotoEnabled = storedRandomPhoto !== null
    ? storedRandomPhoto === '1'
    : Boolean(state.settings.randomPhotoEnabled);
  state.selectedPhotoId = storedSelectedPhotoId !== null
    ? storedSelectedPhotoId
    : String(state.settings.selectedPhotoId || '');
  els.workingFrom.value = state.settings.workingFrom || '';
  els.officeName.textContent = state.settings.officeName || 'PT Minergo Visi Maxima';
  els.officeCoords.textContent = `${state.settings.officeLatitude || DEFAULT_COORDS.latitude}, ${state.settings.officeLongitude || DEFAULT_COORDS.longitude}`;
  renderGeoStatus();
  renderSchedule();
  renderPhotos();
}

function renderSchedule() {
  const enabled = Boolean(state.settings.scheduleEnabled);
  const checkInTime = normalizeTime(state.settings.checkInTime, '09:00');
  const checkOutTime = normalizeTime(state.settings.checkOutTime, '18:00');
  const randomCheckIn = Boolean(state.settings.randomCheckInEnabled);
  const randomCheckOut = Boolean(state.settings.randomCheckOutEnabled);

  els.checkInTime.value = checkInTime;
  els.checkOutTime.value = checkOutTime;
  els.checkInStartTime.value = normalizeTime(state.settings.checkInStartTime, '08:45');
  els.checkInEndTime.value = normalizeTime(state.settings.checkInEndTime, '09:00');
  els.checkOutStartTime.value = normalizeTime(state.settings.checkOutStartTime, '17:45');
  els.checkOutEndTime.value = normalizeTime(state.settings.checkOutEndTime, '18:15');

  renderToggle(els.scheduleEnabled, enabled, 'Schedule');
  els.scheduleDetails.hidden = !enabled || !state.scheduleDetailsExpanded;
  els.scheduleCollapse.hidden = !enabled;
  els.scheduleCollapse.innerHTML = state.scheduleDetailsExpanded ? '&#9652;' : '&#9662;';
  els.scheduleCollapse.setAttribute('aria-expanded', String(state.scheduleDetailsExpanded));
  els.scheduleCollapse.setAttribute('aria-label', state.scheduleDetailsExpanded ? 'Sembunyikan detail jadwal' : 'Tampilkan detail jadwal');
  renderToggle(els.randomCheckInEnabled, randomCheckIn, 'Random CI');
  renderToggle(els.randomCheckOutEnabled, randomCheckOut, 'Random CO');

  if (!enabled) {
    els.scheduleInfo.textContent = 'Jadwal nonaktif';
    return;
  }

  const checkInTarget = getScheduleTime('clock-in');
  const checkOutTarget = getScheduleTime('clock-out');
  els.scheduleInfo.textContent = `Aktif: check-in ${checkInTarget}, check-out ${checkOutTarget}`;
}

function renderToggle(element, enabled, label) {
  element.textContent = `${label}: ${enabled ? 'ON' : 'OFF'}`;
  element.setAttribute('aria-pressed', String(enabled));
  element.classList.toggle('active', enabled);
}

function todayKey(action, targetTime) {
  const date = new Date().toLocaleDateString('en-CA');
  return `hris-schedule:${date}:${action}:${targetTime}`;
}

function alreadyPrompted(action, targetTime) {
  return localStorage.getItem(todayKey(action, targetTime)) === '1';
}

function markPrompted(action, targetTime) {
  localStorage.setItem(todayKey(action, targetTime), '1');
}

function normalizeTime(value, fallback) {
  const match = String(value || '').match(/^(\d{1,2}):(\d{2})$/);
  const hour = match ? Number(match[1]) : NaN;
  const minute = match ? Number(match[2]) : NaN;
  if (!match || hour > 23 || minute > 59) return fallback;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function minutesFromTime(value, fallback) {
  const normalized = normalizeTime(value, fallback || '00:00');
  const [hour, minute] = normalized.split(':').map(Number);
  return hour * 60 + minute;
}

function timeFromMinutes(minutes) {
  const normalized = Math.max(0, Math.min(1439, minutes));
  const hour = String(Math.floor(normalized / 60)).padStart(2, '0');
  const minute = String(normalized % 60).padStart(2, '0');
  return `${hour}:${minute}`;
}

function dailyRandomTarget(action, startTime, endTime) {
  const start = minutesFromTime(startTime, '09:00');
  const end = Math.max(start, minutesFromTime(endTime, startTime));
  const date = new Date().toLocaleDateString('en-CA');
  const key = `hris-random-target:${date}:${action}:${startTime}-${endTime}`;
  const saved = localStorage.getItem(key);
  if (saved) return saved;
  const target = timeFromMinutes(start + Math.floor(Math.random() * (end - start + 1)));
  localStorage.setItem(key, target);
  return target;
}

function getScheduleTime(action) {
  if (action === 'clock-in') {
    if (!state.settings.randomCheckInEnabled) return normalizeTime(state.settings.checkInTime, '09:00');
    return dailyRandomTarget(action, state.settings.checkInStartTime || '08:45', state.settings.checkInEndTime || '09:00');
  }
  if (!state.settings.randomCheckOutEnabled) return normalizeTime(state.settings.checkOutTime, '18:00');
  return dailyRandomTarget(action, state.settings.checkOutStartTime || '17:45', state.settings.checkOutEndTime || '18:15');
}

async function saveScheduleSettings(patch) {
  const payload = await api('/api/settings', {
    method: 'POST',
    body: JSON.stringify({
      scheduleEnabled: Boolean(state.settings.scheduleEnabled),
      checkInTime: normalizeTime(els.checkInTime.value, '09:00'),
      checkOutTime: normalizeTime(els.checkOutTime.value, '18:00'),
      randomCheckInEnabled: Boolean(state.settings.randomCheckInEnabled),
      randomCheckOutEnabled: Boolean(state.settings.randomCheckOutEnabled),
      checkInStartTime: normalizeTime(els.checkInStartTime.value, '08:45'),
      checkInEndTime: normalizeTime(els.checkInEndTime.value, '09:00'),
      checkOutStartTime: normalizeTime(els.checkOutStartTime.value, '17:45'),
      checkOutEndTime: normalizeTime(els.checkOutEndTime.value, '18:15'),
      ...patch,
    }),
  });
  state.settings = payload;
  renderSchedule();
  return payload;
}

async function savePhotoSettings(patch) {
  const saveId = ++state.photoSettingsSaveId;
  const next = {
    randomPhotoEnabled: Boolean(state.randomPhotoEnabled),
    selectedPhotoId: state.selectedPhotoId || '',
    ...patch,
  };

  // Keep photo random state local too, so the toggle stays responsive even if save is slow.
  localStorage.setItem('hris-random-photo-enabled', next.randomPhotoEnabled ? '1' : '0');
  localStorage.setItem('hris-selected-photo-id', next.selectedPhotoId || '');
  state.randomPhotoEnabled = Boolean(next.randomPhotoEnabled);
  state.selectedPhotoId = String(next.selectedPhotoId || '');
  state.settings = { ...state.settings, ...next };

  const saveTask = state.photoSettingsSaveQueue.catch(() => {}).then(async () => {
    const payload = await api('/api/settings', {
      method: 'POST',
      body: JSON.stringify(next),
    });

    if (saveId !== state.photoSettingsSaveId) return null;

    state.settings = { ...payload, ...next };
    state.randomPhotoEnabled = Boolean(next.randomPhotoEnabled);
    state.selectedPhotoId = String(next.selectedPhotoId || '');
    return payload;
  });
  state.photoSettingsSaveQueue = saveTask;

  try {
    await saveTask;
  } catch (error) {
    if (saveId === state.photoSettingsSaveId) log(`Simpan random foto ke server gagal, pakai lokal: ${error.message}`);
  }

  if (saveId === state.photoSettingsSaveId) renderPhotos();
  return { ...state.settings, randomPhotoEnabled: state.randomPhotoEnabled, selectedPhotoId: state.selectedPhotoId };
}

function triggerScheduledAction(action, targetTime) {
  const label = action === 'clock-in' ? 'check-in' : 'check-out';
  state.scheduledAction = { action, targetTime };
  log(`Jadwal ${label} ${targetTime} aktif. Submit HRIS otomatis berjalan.`);
  if (action === 'clock-in') els.clockIn.click();
  if (action === 'clock-out') els.clockOut.click();
}

function isScheduleDue(currentTime, targetTime) {
  const currentMinutes = minutesFromTime(currentTime, '00:00');
  const targetMinutes = minutesFromTime(targetTime, '00:00');
  return currentMinutes >= targetMinutes && currentMinutes <= targetMinutes + 1;
}

function checkScheduleTick() {
  if (!state.settings.scheduleEnabled || state.scheduledAction) return;
  const now = new Date();
  const current = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const checkInTarget = getScheduleTime('clock-in');
  const checkOutTarget = getScheduleTime('clock-out');

  if (isScheduleDue(current, checkInTarget) && !alreadyPrompted('clock-in', checkInTarget)) {
    triggerScheduledAction('clock-in', checkInTarget);
    return;
  }
  if (isScheduleDue(current, checkOutTarget) && !alreadyPrompted('clock-out', checkOutTarget)) {
    triggerScheduledAction('clock-out', checkOutTarget);
  }
}

function finishScheduledAction(action, succeeded) {
  if (!state.scheduledAction || state.scheduledAction.action !== action) return;
  if (succeeded) markPrompted(action, state.scheduledAction.targetTime);
  state.scheduledAction = '';
}

function renderLocations() {
  const selected = state.settings.defaultLocationId || state.locations.find((item) => item.selected)?.id || '';
  els.locationSelect.innerHTML = '<option value="">Pilih location</option>';
  for (const location of state.locations) {
    const option = document.createElement('option');
    option.value = location.id;
    option.textContent = `${location.name} (#${location.id})`;
    option.dataset.isRadius = location.isRadius;
    option.selected = location.id === selected;
    els.locationSelect.append(option);
  }
  renderSettings();
}

async function loadSettings() {
  state.settings = await api('/api/settings');
  renderSettings();
}

function formatPhotoDate(value) {
  if (!value) return '-';
  return new Date(value).toLocaleString('id-ID', { dateStyle: 'short', timeStyle: 'short' });
}

function renderPhotos() {
  const selectedPhoto = state.photos.find((item) => String(item.id) === String(state.selectedPhotoId));
  els.randomPhoto.textContent = state.randomPhotoEnabled ? 'Random: ON' : 'Random: OFF';
  els.randomPhoto.setAttribute('aria-pressed', String(state.randomPhotoEnabled));
  els.randomPhoto.classList.toggle('active', state.randomPhotoEnabled);
  els.selectedPhotoInfo.textContent = state.randomPhotoEnabled
    ? 'Random aktif, foto dipilih otomatis saat clock-in'
    : selectedPhoto
      ? `${selectedPhoto.label} dipilih untuk clock-in`
      : state.imageBase64 && !state.selectedPhotoId
        ? 'Foto baru siap, belum disimpan'
        : 'Belum ada foto dipilih';

  if (state.randomPhotoEnabled) {
    els.photoList.innerHTML = '<p class="hint empty-photos">Mode random aktif. Daftar foto disembunyikan.</p>';
    return;
  }

  if (!state.photos.length) {
    els.photoList.innerHTML = '<p class="hint empty-photos">Belum ada foto tersimpan.</p>';
    return;
  }

  els.photoList.innerHTML = '';
  for (const photo of state.photos) {
    const card = document.createElement('article');
    card.className = `photo-card${String(photo.id) === String(state.selectedPhotoId) ? ' selected' : ''}`;

    const img = document.createElement('img');
    img.src = photo.imageBase64;
    img.alt = photo.label;

    const meta = document.createElement('div');
    meta.className = 'photo-meta';
    const title = document.createElement('b');
    title.textContent = photo.label;
    const created = document.createElement('span');
    created.textContent = formatPhotoDate(photo.createdAt);
    meta.append(title, created);

    const actions = document.createElement('div');
    actions.className = 'photo-actions';

    const selectButton = document.createElement('button');
    selectButton.className = 'secondary compact';
    selectButton.type = 'button';
    selectButton.textContent = String(photo.id) === String(state.selectedPhotoId) ? 'Dipilih' : 'Pilih';
    selectButton.addEventListener('click', () => {
      selectPhoto(photo.id).catch((error) => log(error.message));
    });

    const deleteButton = document.createElement('button');
    deleteButton.className = 'secondary compact ghost';
    deleteButton.type = 'button';
    deleteButton.textContent = 'Hapus';
    deleteButton.addEventListener('click', () => deleteSavedPhoto(photo.id));

    actions.append(selectButton, deleteButton);
    card.append(img, meta, actions);
    els.photoList.append(card);
  }
}

async function selectPhoto(photoId, options = {}) {
  const photo = state.photos.find((item) => String(item.id) === String(photoId));
  if (!photo) return null;
  state.randomPhotoEnabled = false;
  state.selectedPhotoId = String(photo.id);
  state.imageBase64 = photo.imageBase64;
  if (!options.keepCamera) stopCameraStream();
  showCameraBox();
  els.preview.src = photo.imageBase64;
  els.preview.hidden = false;
  els.video.hidden = false;
  els.selectedPhotoInfo.textContent = `${photo.label} dipilih untuk clock-in`;
  renderPhotos();
  await savePhotoSettings({ randomPhotoEnabled: false, selectedPhotoId: state.selectedPhotoId });
  return photo;
}

function getRandomPhoto() {
  if (!state.photos.length) return null;
  const lastRandomPhotoId = localStorage.getItem('hris-last-random-photo-id') || '';
  const unusedPhotos = state.photos.filter((photo) => !photo.usedAt);
  let pool = unusedPhotos;

  if (!pool.length) {
    const oldestUsedAt = state.photos
      .map((photo) => photo.usedAt || '')
      .sort()[0];
    pool = state.photos.filter((photo) => (photo.usedAt || '') === oldestUsedAt);
  }

  if (pool.length > 1) {
    pool = pool.filter((photo) => String(photo.id) !== String(state.selectedPhotoId));
  }
  if (pool.length > 1) {
    const withoutLast = pool.filter((photo) => String(photo.id) !== String(lastRandomPhotoId));
    if (withoutLast.length) pool = withoutLast;
  }

  return pool[Math.floor(Math.random() * pool.length)];
}

function rememberRandomPhotoUsed(photoId) {
  if (photoId) localStorage.setItem('hris-last-random-photo-id', String(photoId));
}

function setCameraToggle(active) {
  els.startCamera.textContent = active ? 'Matikan Kamera' : 'Nyalakan Kamera';
  els.startCamera.setAttribute('aria-pressed', String(active));
  els.startCamera.classList.toggle('active', active);
}

function showCameraBox() {
  els.cameraBox.hidden = false;
}

function stopCameraStream() {
  if (state.stream) {
    state.stream.getTracks().forEach((track) => track.stop());
    state.stream = null;
  }
  els.video.srcObject = null;
  setCameraToggle(false);
}

function hideCameraBox() {
  stopCameraStream();
  els.preview.hidden = true;
  els.video.hidden = true;
  els.cameraBox.hidden = true;
}

function hidePhotoPreview() {
  els.preview.hidden = true;
  if (!els.video.srcObject) {
    els.video.hidden = true;
    els.cameraBox.hidden = true;
  }
}

async function setRandomPhotoEnabled(enabled) {
  state.randomPhotoEnabled = enabled;
  if (enabled) {
    state.selectedPhotoId = '';
    state.imageBase64 = '';
    hidePhotoPreview();
  }
  renderPhotos();
  await savePhotoSettings({ randomPhotoEnabled: enabled, selectedPhotoId: state.selectedPhotoId });
}

async function loadPhotos() {
  const payload = await api('/api/photos');
  state.photos = payload.photos || [];
  if (state.selectedPhotoId && !state.photos.some((photo) => String(photo.id) === String(state.selectedPhotoId))) {
    state.selectedPhotoId = '';
    state.settings.selectedPhotoId = '';
    savePhotoSettings({ selectedPhotoId: '' }).catch((error) => log(`Reset foto tersimpan gagal: ${error.message}`));
  }
  renderPhotos();
  return state.photos;
}

async function deleteSavedPhoto(photoId) {
  const photo = state.photos.find((item) => String(item.id) === String(photoId));
  if (!photo) return;
  if (!window.confirm(`Hapus foto "${photo.label}" dari database lokal?`)) return;

  await api(`/api/photos/${photoId}`, { method: 'DELETE' });
  if (String(state.selectedPhotoId) === String(photoId)) {
    state.selectedPhotoId = '';
    state.imageBase64 = '';
    hideCameraBox();
    els.selectedPhotoInfo.textContent = 'Belum ada foto dipilih';
    await savePhotoSettings({ selectedPhotoId: '' });
  }
  await loadPhotos();
  log('Foto tersimpan dihapus.');
}

async function loadClockInOptions() {
  const payload = await api('/api/clock-in-options');
  state.csrfToken = payload.csrfToken;
  state.locations = payload.locations || [];
  state.settings = payload.settings || state.settings;
  state.modal = payload;
  renderLocations();

  if (payload.requiresFixClockOut) {
    els.fixBox.hidden = false;
    els.modalInfo.textContent = `Perlu fix clock-out ${payload.lastAttendanceDate || ''}`.trim();
  } else {
    els.fixBox.hidden = true;
    els.modalInfo.textContent = payload.rawTimeLabel || 'Opsi clock-in siap';
  }
}

async function loadClockOutOptions() {
  const payload = await api('/api/clock-out-options');
  state.clockOutOptions = payload;
  if (payload.canClockOut) {
    els.clockOutInfo.textContent = `Siap clock-out attendance #${payload.attendanceId}`;
  } else {
    els.clockOutInfo.textContent = 'Belum ada clock-in aktif';
  }
  return payload;
}

async function loadDashboardStatus() {
  const payload = await api('/api/dashboard-status');
  els.hrisClock.textContent = payload.dashboardClock || '--:--';
  els.hrisDate.textContent = payload.attendanceDate || payload.dashboardDay || '-';
  els.hrisStatus.textContent = payload.attendanceStatusLabel || '-';
  els.hrisClockInAt.textContent = payload.clockInAt || '-';
  return payload;
}

async function refreshFromSavedSession(message = 'Data berhasil direload dari session tersimpan.') {
  els.sessionStatus.textContent = 'Cek session...';
  const payload = await api('/api/session');
  if (!payload.loggedIn) {
    els.sessionStatus.textContent = 'Belum login';
    setLoginVisible(true);
    throw new Error('Session tersimpan tidak valid atau sudah habis. Silakan login ulang.');
  }

  els.sessionStatus.textContent = 'Sudah login';
  setLoginVisible(false);
  await loadDashboardStatus().catch((error) => log(`Load dashboard gagal: ${error.message}`));
  await loadClockOutOptions().catch((error) => log(`Cek clock-out gagal: ${error.message}`));
  await loadClockInOptions().catch((error) => log(`Load clock-in gagal: ${error.message}`));
  await loadPhotos().catch((error) => log(`Load foto gagal: ${error.message}`));
  log(message);
}

async function restoreSession() {
  try {
    await refreshFromSavedSession('Session tersimpan dipakai ulang.');
  } catch (error) {
    els.sessionStatus.textContent = 'Belum login';
    setLoginVisible(true);
  }
}

els.loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const email = els.email.value.trim();
  const password = els.password.value;
  if (!email || !password) return;

  els.sessionStatus.textContent = 'Login...';
  try {
    const payload = await api('/api/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });
    els.sessionStatus.textContent = 'Sudah login';
    setLoginVisible(false);
    els.password.value = '';
    log('Login sukses, refresh data...', payload);
    await refreshFromSavedSession('Login sukses. Data berhasil direfresh.');
  } catch (error) {
    els.sessionStatus.textContent = 'Login gagal';
    setLoginVisible(true);
    log(error.message);
  }
});

els.refreshSession.addEventListener('click', async () => {
  try {
    await refreshFromSavedSession();
  } catch (error) {
    log(error.message);
  }
});

els.logout.addEventListener('click', async () => {
  const confirmed = window.confirm('Logout dari session HRIS tersimpan di aplikasi ini?');
  if (!confirmed) return;

  try {
    await api('/api/logout', { method: 'POST' });
    resetHrisState();
    els.sessionStatus.textContent = 'Belum login';
    setLoginVisible(true);
    log('Logout sukses. Session HRIS lokal sudah dihapus.');
  } catch (error) {
    log(error.message);
  }
});

els.saveSettings.addEventListener('click', async () => {
  try {
    const payload = await api('/api/settings', {
      method: 'POST',
      body: JSON.stringify({
        defaultLocationId: els.locationSelect.value,
        workingFrom: els.workingFrom.value.trim(),
      }),
    });
    state.settings = payload;
    renderSettings();
    log('Default location tersimpan', payload);
  } catch (error) {
    log(error.message);
  }
});

els.scheduleEnabled.addEventListener('click', async () => {
  try {
    const enabled = !state.settings.scheduleEnabled;
    const payload = await saveScheduleSettings({ scheduleEnabled: enabled });
    log(enabled ? 'Jadwal otomatis aktif.' : 'Jadwal otomatis nonaktif.', payload);
  } catch (error) {
    log(error.message);
  }
});

els.scheduleCollapse.addEventListener('click', () => {
  state.scheduleDetailsExpanded = !state.scheduleDetailsExpanded;
  localStorage.setItem('hris-schedule-details-expanded', state.scheduleDetailsExpanded ? '1' : '0');
  renderSchedule();
});

els.randomCheckInEnabled.addEventListener('click', async () => {
  try {
    const enabled = !state.settings.randomCheckInEnabled;
    const payload = await saveScheduleSettings({ randomCheckInEnabled: enabled });
    log(enabled ? 'Random check-in aktif.' : 'Random check-in nonaktif.', payload);
  } catch (error) {
    log(error.message);
  }
});

els.randomCheckOutEnabled.addEventListener('click', async () => {
  try {
    const enabled = !state.settings.randomCheckOutEnabled;
    const payload = await saveScheduleSettings({ randomCheckOutEnabled: enabled });
    log(enabled ? 'Random check-out aktif.' : 'Random check-out nonaktif.', payload);
  } catch (error) {
    log(error.message);
  }
});

els.saveSchedule.addEventListener('click', async () => {
  try {
    const payload = await saveScheduleSettings({
      checkInTime: normalizeTime(els.checkInTime.value, '09:00'),
      checkOutTime: normalizeTime(els.checkOutTime.value, '18:00'),
      checkInStartTime: normalizeTime(els.checkInStartTime.value, '08:45'),
      checkInEndTime: normalizeTime(els.checkInEndTime.value, '09:00'),
      checkOutStartTime: normalizeTime(els.checkOutStartTime.value, '17:45'),
      checkOutEndTime: normalizeTime(els.checkOutEndTime.value, '18:15'),
    });
    log('Jadwal otomatis tersimpan.', payload);
  } catch (error) {
    log(error.message);
  }
});

els.startCamera.addEventListener('click', async () => {
  if (state.stream) {
    hideCameraBox();
    log('Kamera dimatikan.');
    return;
  }

  try {
    showCameraBox();
    state.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' }, audio: false });
    els.video.srcObject = state.stream;
    els.preview.hidden = true;
    els.video.hidden = false;
    setCameraToggle(true);
    log('Kamera aktif. Klik Ambil Foto sebelum submit clock-in.');
  } catch (error) {
    hideCameraBox();
    log(`Gagal membuka kamera: ${error.message}`);
  }
});

els.snap.addEventListener('click', () => {
  if (!els.video.srcObject) {
    log('Kamera belum aktif.');
    return;
  }
  const ctx = els.canvas.getContext('2d');
  ctx.drawImage(els.video, 0, 0, els.canvas.width, els.canvas.height);
  state.imageBase64 = els.canvas.toDataURL('image/jpeg', 0.86);
  state.selectedPhotoId = '';
  state.randomPhotoEnabled = false;
  savePhotoSettings({ randomPhotoEnabled: false, selectedPhotoId: '' }).catch((error) => log(error.message));
  showCameraBox();
  els.preview.src = state.imageBase64;
  els.preview.hidden = false;
  els.video.hidden = false;
  els.selectedPhotoInfo.textContent = 'Foto baru siap, belum disimpan';
  renderPhotos();
  log('Foto siap untuk clock-in. Klik Simpan Foto jika ingin masuk database.');
});

els.savePhoto.addEventListener('click', async () => {
  if (!state.imageBase64) {
    log('Ambil foto dulu sebelum disimpan.');
    return;
  }

  try {
    const photo = await api('/api/photos', {
      method: 'POST',
      body: JSON.stringify({
        label: els.photoLabel.value.trim(),
        imageBase64: state.imageBase64,
      }),
    });
    els.photoLabel.value = '';
    await loadPhotos();
    await selectPhoto(photo.id, { keepCamera: true });
    log('Foto tersimpan di database lokal.', { id: photo.id, label: photo.label });
  } catch (error) {
    log(error.message);
  }
});

els.randomPhoto.addEventListener('click', async () => {
  const enabled = els.randomPhoto.getAttribute('aria-pressed') !== 'true';
  try {
    if (enabled && !state.photos.length) await loadPhotos().catch(() => {});
    await setRandomPhotoEnabled(enabled);
    log(enabled
      ? state.photos.length
        ? 'Mode random foto aktif dan tersimpan. Foto akan dipilih otomatis saat clock-in.'
        : 'Mode random foto aktif, tapi belum ada foto tersimpan. Simpan foto dulu agar random bisa dipakai.'
      : 'Mode random foto nonaktif dan tersimpan. Pilih foto manual atau ambil foto baru.');
  } catch (error) {
    log(error.message);
  }
});

els.refreshPhotos.addEventListener('click', async () => {
  try {
    const photos = await loadPhotos();
    log(`${photos.length} foto tersimpan dimuat.`);
  } catch (error) {
    log(error.message);
  }
});

els.refreshClockOut.addEventListener('click', async () => {
  try {
    await loadDashboardStatus().catch(() => {});
    const payload = await loadClockOutOptions();
    log('Status clock-out berhasil dicek', payload);
  } catch (error) {
    log(error.message);
  }
});

els.getLocation.addEventListener('click', () => {
  if (!navigator.geolocation) {
    log('Browser tidak mendukung geolocation.');
    return;
  }
  els.geoStatus.textContent = 'Mengambil GPS...';
  navigator.geolocation.getCurrentPosition(
    (position) => {
      state.coords = {
        latitude: position.coords.latitude,
        longitude: position.coords.longitude,
        accuracy: position.coords.accuracy,
        source: 'browser',
      };
      renderGeoStatus();
      log('GPS berhasil diambil', state.coords);
    },
    (error) => {
      state.coords = { ...DEFAULT_COORDS };
      renderGeoStatus();
      log(`Gagal mengambil GPS: ${error.message}. Pakai lokasi default.`, state.coords);
    },
    { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 },
  );
});

els.clockIn.addEventListener('click', async () => {
  if (!state.csrfToken) {
    log('Belum login atau opsi clock-in belum diload.');
    finishScheduledAction('clock-in', false);
    return;
  }
  if (!state.coords) {
    state.coords = { ...DEFAULT_COORDS };
  }

  let photoId = state.selectedPhotoId;
  let imageBase64 = state.imageBase64;
  if (state.randomPhotoEnabled) {
    if (!state.photos.length) await loadPhotos().catch(() => {});
    const randomPhoto = getRandomPhoto();
    if (!randomPhoto) {
      log('Mode random aktif, tapi belum ada foto tersimpan.');
      finishScheduledAction('clock-in', false);
      return;
    }
    photoId = String(randomPhoto.id);
    imageBase64 = '';
    log('Foto random dipilih untuk clock-in.', { id: randomPhoto.id, label: randomPhoto.label });
  }

  if (!photoId && !imageBase64) {
    log('Ambil foto dulu, pilih foto tersimpan, atau aktifkan Random.');
    finishScheduledAction('clock-in', false);
    return;
  }
  if (state.modal?.requiresFixClockOut && (!els.fixClockOutTime.value.trim() || !els.fixClockOutNote.value.trim())) {
    log('Isi Clock Out Kemarin dan Alasan dulu.');
    finishScheduledAction('clock-in', false);
    return;
  }

  try {
    const payload = await api('/api/clock-in', {
      method: 'POST',
      body: JSON.stringify({
        csrfToken: state.csrfToken,
        location: els.locationSelect.value,
        working_from: els.workingFrom.value.trim(),
        work_from_type: 'office',
        currentLatitude: state.coords.latitude,
        currentLongitude: state.coords.longitude,
        photoId,
        imageBase64: photoId ? '' : imageBase64,
        fix_clock_out_time: els.fixClockOutTime.value.trim(),
        fix_clock_out_note: els.fixClockOutNote.value.trim(),
        last_attendance_id: state.modal?.lastAttendanceId || '',
        last_attendance_date: state.modal?.lastAttendanceDate || '',
      }),
    });
    if (photoId) rememberRandomPhotoUsed(photoId);
    log('Clock-in sukses', payload);
    await loadDashboardStatus().catch(() => {});
    await loadClockOutOptions().catch(() => {});
    await loadClockInOptions().catch(() => {});
    await loadPhotos().catch(() => {});
    finishScheduledAction('clock-in', true);
  } catch (error) {
    finishScheduledAction('clock-in', false);
    log(error.message);
  }
});

els.clockOut.addEventListener('click', async () => {
  if (!state.coords) {
    state.coords = { ...DEFAULT_COORDS };
  }

  let options = state.clockOutOptions;
  if (!options?.canClockOut) {
    try {
      options = await loadClockOutOptions();
    } catch (error) {
      finishScheduledAction('clock-out', false);
      log(error.message);
      return;
    }
  }

  if (!options?.canClockOut) {
    log('Belum ada clock-in aktif untuk di-clock-out.');
    finishScheduledAction('clock-out', false);
    return;
  }

  try {
    const payload = await api('/api/clock-out', {
      method: 'POST',
      body: JSON.stringify({
        csrfToken: options.csrfToken,
        attendanceId: options.attendanceId,
        currentLatitude: state.coords.latitude,
        currentLongitude: state.coords.longitude,
      }),
    });
    log('Clock-out sukses', payload);
    await loadDashboardStatus().catch(() => {});
    await loadClockOutOptions().catch(() => {});
    await loadClockInOptions().catch(() => {});
    finishScheduledAction('clock-out', true);
  } catch (error) {
    finishScheduledAction('clock-out', false);
    log(error.message);
  }
});

await loadBootstrap().catch((error) => log(`Init aplikasi gagal: ${error.message}`));
await loadSettings().catch((error) => log(error.message));
await loadPhotos().catch((error) => log(`Load foto gagal: ${error.message}`));
renderLocations();
await restoreSession().catch((error) => {
  els.sessionStatus.textContent = 'Belum login';
  log(`Cek session tersimpan gagal: ${error.message}`);
});
checkScheduleTick();
setInterval(checkScheduleTick, 30000);
