const DEFAULT_COORDS = {
  latitude: -1.228552,
  longitude: 116.881761,
  accuracy: null,
  source: 'default',
};

const state = {
  csrfToken: '',
  locations: [],
  settings: { defaultLocationId: '', workingFrom: '' },
  coords: { ...DEFAULT_COORDS },
  imageBase64: '',
  modal: null,
  clockOutOptions: null,
  stream: null,
};

const els = {
  loginForm: document.querySelector('#loginForm'),
  email: document.querySelector('#email'),
  password: document.querySelector('#password'),
  sessionStatus: document.querySelector('#sessionStatus'),
  refreshSession: document.querySelector('#refreshSession'),
  hrisClock: document.querySelector('#hrisClock'),
  hrisDate: document.querySelector('#hrisDate'),
  hrisStatus: document.querySelector('#hrisStatus'),
  hrisClockInAt: document.querySelector('#hrisClockInAt'),
  locationSelect: document.querySelector('#locationSelect'),
  workingFrom: document.querySelector('#workingFrom'),
  officeName: document.querySelector('#officeName'),
  officeCoords: document.querySelector('#officeCoords'),
  saveSettings: document.querySelector('#saveSettings'),
  startCamera: document.querySelector('#startCamera'),
  snap: document.querySelector('#snap'),
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

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const payload = await response.json();
  if (!response.ok || payload.status === 'error') {
    throw new Error(payload.message || 'Request gagal');
  }
  return payload;
}

function renderSettings() {
  els.workingFrom.value = state.settings.workingFrom || '';
  els.officeName.textContent = state.settings.officeName || 'PT Minergo Visi Maxima';
  els.officeCoords.textContent = `${state.settings.officeLatitude || DEFAULT_COORDS.latitude}, ${state.settings.officeLongitude || DEFAULT_COORDS.longitude}`;
  renderGeoStatus();
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
    throw new Error('Session tersimpan tidak valid atau sudah habis. Silakan login ulang.');
  }

  els.sessionStatus.textContent = 'Sudah login';
  await loadDashboardStatus().catch((error) => log(`Load dashboard gagal: ${error.message}`));
  await loadClockOutOptions().catch((error) => log(`Cek clock-out gagal: ${error.message}`));
  await loadClockInOptions().catch((error) => log(`Load clock-in gagal: ${error.message}`));
  log(message);
}

async function restoreSession() {
  try {
    await refreshFromSavedSession('Session tersimpan dipakai ulang.');
  } catch (error) {
    els.sessionStatus.textContent = 'Belum login';
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
    els.password.value = '';
    log('Login sukses', payload);
    await loadDashboardStatus().catch((error) => log(`Load dashboard gagal: ${error.message}`));
    await loadClockOutOptions().catch((error) => log(`Cek clock-out gagal: ${error.message}`));
    await loadClockInOptions().catch((error) => log(`Load clock-in gagal: ${error.message}`));
  } catch (error) {
    els.sessionStatus.textContent = 'Login gagal';
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
    log('Default location tersimpan', payload);
  } catch (error) {
    log(error.message);
  }
});

els.startCamera.addEventListener('click', async () => {
  try {
    state.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' }, audio: false });
    els.video.srcObject = state.stream;
    els.preview.hidden = true;
    els.video.hidden = false;
    log('Kamera aktif. Klik Ambil Foto sebelum submit clock-in.');
  } catch (error) {
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
  els.preview.src = state.imageBase64;
  els.preview.hidden = false;
  els.video.hidden = true;
  log('Foto siap untuk clock-in.');
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
    return;
  }
  if (!state.coords) {
    state.coords = { ...DEFAULT_COORDS };
  }
  if (!state.imageBase64) {
    log('Ambil foto dulu.');
    return;
  }
  if (state.modal?.requiresFixClockOut && (!els.fixClockOutTime.value.trim() || !els.fixClockOutNote.value.trim())) {
    log('Isi Clock Out Kemarin dan Alasan dulu.');
    return;
  }

  const confirmed = window.confirm('Submit clock-in ke HRIS sekarang? Ini akan membuat record absensi sungguhan.');
  if (!confirmed) return;

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
        imageBase64: state.imageBase64,
        fix_clock_out_time: els.fixClockOutTime.value.trim(),
        fix_clock_out_note: els.fixClockOutNote.value.trim(),
        last_attendance_id: state.modal?.lastAttendanceId || '',
        last_attendance_date: state.modal?.lastAttendanceDate || '',
      }),
    });
    log('Clock-in sukses', payload);
    await loadDashboardStatus().catch(() => {});
    await loadClockOutOptions().catch(() => {});
    await loadClockInOptions().catch(() => {});
  } catch (error) {
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
      log(error.message);
      return;
    }
  }

  if (!options?.canClockOut) {
    log('Belum ada clock-in aktif untuk di-clock-out.');
    return;
  }

  const confirmed = window.confirm('Submit clock-out ke HRIS sekarang? Ini akan menutup absensi aktif.');
  if (!confirmed) return;

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
  } catch (error) {
    log(error.message);
  }
});

await loadSettings().catch((error) => log(error.message));
renderLocations();
await restoreSession().catch((error) => {
  els.sessionStatus.textContent = 'Belum login';
  log(`Cek session tersimpan gagal: ${error.message}`);
});
