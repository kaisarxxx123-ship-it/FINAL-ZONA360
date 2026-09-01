(function () {
  'use strict';

  const CONFIG = {
    projectId: 'zona360',
    databaseURL: 'https://zona360-default-rtdb.asia-southeast1.firebasedatabase.app',
    apiKey: 'AIzaSyBbnPBXBhciKxVxTIGe5VAgXYfClRJQgL4',
    appId: '1:1028330928592:android:93dd1337c67a486db1a1d5',
    packageName: 'com.zona360.salestracker'
  };

  const ROOT = 'zona360_v1';
  const ROOT_URL = CONFIG.databaseURL.replace(/\/$/, '') + '/' + ROOT;
  const COLLECTIONS = [
    'users', 'sales', 'stores', 'products', 'barcodes',
    'activities', 'visits', 'orders', 'feedback', 'roles', 'gpsHistory'
  ];
  const SIMPLE_KEYS = ['barcodeSettings', 'visitRadius'];
  const DB_KEY = 'zona360_db';
  const SESSION_KEY = 'zona360_session';
  const PENDING_KEY = 'zona360_cloud_pending_v1';
  const DEVICE_KEY = 'zona360_device_id_v1';
  const AUTH_KEY = 'zona360_firebase_auth_v2';
  const ADMIN_WORKER_URL_KEY = 'zona360_admin_worker_url_v1';
  const ADMIN_WORKER_OK_KEY = 'zona360_admin_worker_ok_v1';
  const CLOUD_DATA_SYNC_ENABLED = true; // SPARK FREE: authenticated operational sync enabled.


  const FEATURE_DATA_VERSION = 3;
  const PRODUCT_CATALOG = [
    { id:'prd-1',  name:'AVITA GELAS',        brand:'AVITA', size:'220ML', unit:'KARTON', price:18000, status:'active', active:true },
    { id:'prd-2',  name:'AVITA GALON BIASA', brand:'AVITA', size:'19L',   unit:'GALON',  price:44000, status:'active', active:true },
    { id:'prd-3',  name:'AVITA GALON BIASA', brand:'AVITA', size:'19L',   unit:'REFILL', price:6000,  status:'active', active:true },
    { id:'prd-4',  name:'AVITA GALON GOLD',  brand:'AVITA', size:'19L',   unit:'GALON',  price:72000, status:'active', active:true },
    { id:'prd-5',  name:'AVITA GALON GOLD',  brand:'AVITA', size:'19L',   unit:'GALON',  price:19000, status:'active', active:true },
    { id:'prd-6',  name:'EDEL GELAS',         brand:'EDEL',  size:'220ML', unit:'KARTON', price:17500, status:'active', active:true },
    { id:'prd-7',  name:'EDEL BOTOL',         brand:'EDEL',  size:'330ML', unit:'KARTON', price:43000, status:'active', active:true },
    { id:'prd-8',  name:'EDEL BOTOL',         brand:'EDEL',  size:'600ML', unit:'KARTON', price:48000, status:'active', active:true },
    { id:'prd-9',  name:'EDEL GALON',         brand:'EDEL',  size:'19L',   unit:'GALON',  price:72000, status:'active', active:true },
    { id:'prd-10', name:'EDEL GALON',         brand:'EDEL',  size:'19L',   unit:'REFILL', price:11000, status:'active', active:true },
    { id:'prd-11', name:'EDEL GOLD GALON',    brand:'EDEL',  size:'19L',   unit:'GALON',  price:62000, status:'active', active:true },
    { id:'prd-12', name:'EDEL GOLD GALON',    brand:'EDEL',  size:'19L',   unit:'REFILL', price:12000, status:'active', active:true }
  ];

  // Admin access is fixed to the complete FINAL workspace. Partial/stale Firebase
  // permission arrays must never hide Admin menus.
  const ADMIN_PERMISSIONS = ['overview','manage_sales','manage_stores','manage_products','manage_barcodes','monitoring','reports','orders','feedback','manage_access'];
  const ADMIN_DASHBOARD = ['overview','sales','stores','products','barcodes','monitoring','reports','orders','feedback','access'];

  const nativeGet = Storage.prototype.getItem;
  const nativeSet = Storage.prototype.setItem;
  const nativeRemove = Storage.prototype.removeItem;

  let applyingRemote = false;
  let flushing = false;
  let bootstrapped = false;
  let pollTimer = null;
  let watchId = null;
  let watchMode = null;
  let trackedUserId = null;
  let firstTrackPoint = true;
  let lastPointSavedAt = 0;
  let lastLiveWriteAt = 0;
  let lastPoint = null;
  let lastAcceptedPoint = null;
  let lastAcceptedPointAt = 0;
  let cloudState = 'offline';
  let cloudMessage = 'Mode lokal siap';
  let cloudStarted = false;
  let barcodeDataDirty = true;
  let barcodeDataCache = null;
  let barcodeDataCacheRaw = '';

  const deviceId = (() => {
    let id = nativeGet.call(localStorage, DEVICE_KEY);
    if (!id) {
      id = 'dev-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 9);
      nativeSet.call(localStorage, DEVICE_KEY, id);
    }
    return id;
  })();

  function parseJSON(value, fallback = null) {
    if (!value) return fallback;
    try { return JSON.parse(value); } catch (_) { return fallback; }
  }

  // Every screen in the React bundle expects these collections to be arrays.
  // Keep the local database shape complete even when an older/corrupt Firebase
  // snapshot only contains one or two collections.
  function ensureLocalShape(db) {
    const out = db && typeof db === 'object' && !Array.isArray(db) ? db : {};
    COLLECTIONS.forEach((name) => {
      if (!Array.isArray(out[name])) out[name] = [];
    });
    if (!out.barcodeSettings || typeof out.barcodeSettings !== 'object') {
      out.barcodeSettings = { target: 250, active: Array.isArray(out.barcodes) ? out.barcodes.length : 0, visitRadius: 100 };
    }
    if (!Number.isFinite(Number(out.barcodeSettings.visitRadius))) out.barcodeSettings.visitRadius = 100;


    // Product catalog migration: preserve additional products, but make the 12 requested
    // Zona360 SKUs authoritative and structurally complete. Product IDs remain stable.
    const productMap = new Map((out.products || []).filter(Boolean).map((p) => [String(p.id || ''), p]));
    PRODUCT_CATALOG.forEach((item) => {
      const old = productMap.get(item.id) || {};
      productMap.set(item.id, { ...old, ...item, type:item.unit, productId:item.id });
    });
    out.products = Array.from(productMap.values()).filter(Boolean);

    // Every store gets one persistent unique code. Existing assigned barcode codes are
    // preserved when possible; stores without a code receive TOKO-0001, TOKO-0002, ... .
    const allBarcodes = Array.isArray(out.barcodes) ? out.barcodes.filter(Boolean) : [];
    const barcodeByStore = new Map();
    allBarcodes.forEach((bc) => {
      const sid = bc && bc.storeId != null ? String(bc.storeId) : '';
      if (sid && !barcodeByStore.has(sid) && String(bc.code || bc.barcodeValue || '').trim()) barcodeByStore.set(sid, bc);
    });
    const usedCodes = new Set();
    let nextStoreCode = 1;
    const takeNextStoreCode = () => {
      let code;
      do { code = 'TOKO-' + String(nextStoreCode++).padStart(4, '0'); } while (usedCodes.has(code));
      usedCodes.add(code); return code;
    };
    const normalizedStores = [];
    (out.stores || []).filter(Boolean).forEach((store) => {
      const sid = String(store.id || store.storeId || 'store-' + (normalizedStores.length + 1));
      const linked = barcodeByStore.get(sid);
      let code = String(store.storeCode || store.barcodeValue || (linked && (linked.code || linked.barcodeValue)) || '').trim().toUpperCase();
      if (!code || usedCodes.has(code)) code = takeNextStoreCode(); else usedCodes.add(code);
      normalizedStores.push({ ...store, id:sid, code:code, storeCode:code, barcodeValue:code });
    });
    out.stores = normalizedStores;
    const keptUnassigned = allBarcodes.filter((bc) => !bc || !bc.storeId);
    const normalizedStoreBarcodes = out.stores.map((store) => {
      const old = barcodeByStore.get(String(store.id)) || {};
      return { ...old, id:old.id || ('bc-store-' + safeKey(store.id)), code:store.storeCode, barcodeValue:store.storeCode, storeId:store.id, storeName:store.name || store.storeName || 'Toko', assigned:true, status:'active', active:true };
    });
    out.barcodes = keptUnassigned.concat(normalizedStoreBarcodes);
    out.barcodeSettings.featureDataVersion = FEATURE_DATA_VERSION;
    out.barcodeSettings.active = normalizedStoreBarcodes.length;
    out.users = out.users.map((user) => {
      if (!user || String(user.role || '').toLowerCase() !== 'admin') return user;
      return { ...user, role: 'admin', permissions: ADMIN_PERMISSIONS.slice(), dashboard: ADMIN_DASHBOARD.slice() };
    });
    // The authenticated session role came from authoritative /users/{uid} during login.
    // Never let an older operational copy in zona360_v1/users silently demote/promote it.
    const session = parseJSON(nativeGet.call(localStorage, SESSION_KEY), null);
    if (session && session.id && (session.role === 'admin' || session.role === 'sales')) {
      out.users = out.users.map((user) => {
        if (!user || String(user.id || user.uid || '') !== String(session.id)) return user;
        const fixed = { ...user, role: session.role };
        if (session.role === 'admin') {
          fixed.permissions = ADMIN_PERMISSIONS.slice();
          fixed.dashboard = ADMIN_DASHBOARD.slice();
        }
        return fixed;
      });
      if (session.role === 'admin') {
        out.sales = out.sales.filter((user) => user && String(user.id || user.uid || '') !== String(session.id));
      }
    }
    return out;
  }

  // Synchronous migration before React starts: repair any Admin profile that was
  // previously synced with a truncated dashboard such as only orders/feedback.
  (function repairPersistedAdminAccess(){
    try {
      const raw = nativeGet.call(localStorage, DB_KEY);
      if (!raw) return;
      const parsed = parseJSON(raw, null);
      if (!parsed) return;
      const next = JSON.stringify(ensureLocalShape(parsed));
      if (next !== raw) nativeSet.call(localStorage, DB_KEY, next);
    } catch (_) {}
  })();

  function safeKey(value) {
    return String(value == null ? '' : value).replace(/[.#$\[\]\/]/g, '_') || ('record_' + Math.random().toString(36).slice(2));
  }

  function normalizeUsername(value) {
    let v = String(value == null ? '' : value).trim().toLowerCase();
    if (v.includes('@')) v = v.split('@')[0];
    v = v.replace(/\s+/g, '').replace(/[^a-z0-9._-]/g, '');
    return v;
  }

  function usernameToFirebaseEmail(value) {
    const username = normalizeUsername(value);
    return username ? username + '@zona360.app' : '';
  }

  function displayUsername(profile, authEmail) {
    const raw = String(profile && profile.username || '').trim();
    if (raw && !raw.includes('@')) return raw;
    const email = String(profile && profile.email || authEmail || raw || '').trim().toLowerCase();
    return email.includes('@') ? email.split('@')[0] : email;
  }

  function byId(arr) {
    const out = {};
    (Array.isArray(arr) ? arr : []).forEach((record, index) => {
      if (!record || typeof record !== 'object') return;
      const id = record.id || ('record-' + index);
      const clean = { ...record };
      delete clean.password;
      delete clean.passwordHash;
      out[safeKey(id)] = clean;
    });
    return out;
  }

  function normalizeDb(db) {
    const source = db && typeof db === 'object' ? db : {};
    const out = {};
    COLLECTIONS.forEach((name) => { out[name] = byId(source[name]); });
    SIMPLE_KEYS.forEach((name) => {
      if (source[name] !== undefined) out[name] = source[name];
    });
    return out;
  }

  function valuesOf(remoteCollection) {
    if (Array.isArray(remoteCollection)) return remoteCollection.filter(Boolean);
    if (!remoteCollection || typeof remoteCollection !== 'object') return [];
    return Object.values(remoteCollection).filter(Boolean);
  }

  function denormalizeDb(remote) {
    const source = remote && typeof remote === 'object' ? remote : {};
    const out = {};
    COLLECTIONS.forEach((name) => { out[name] = valuesOf(source[name]); });
    SIMPLE_KEYS.forEach((name) => {
      if (source[name] !== undefined && source[name] !== null) out[name] = source[name];
    });
    return out;
  }

  function comparableDb(db) {
    const normalized = normalizeDb(db);
    return JSON.stringify(normalized);
  }

  function setCloudStatus(state, message) {
    cloudState = state;
    cloudMessage = message;
    updateCloudBadge();
    window.dispatchEvent(new CustomEvent('zona360-cloud-status', { detail: { state, message } }));
  }

  async function getValidAuthState(forceRefresh = false) {
    let state = parseJSON(nativeGet.call(localStorage, AUTH_KEY), null);
    if (!state || !state.uid || !state.idToken) return null;
    const lifetimeMs = Math.max(60, Number(state.expiresIn || 3600)) * 1000;
    const stillValid = !forceRefresh && Date.now() < Number(state.issuedAt || 0) + lifetimeMs - 120000;
    if (stillValid || !state.refreshToken) return state;
    const refreshUrl = 'https://securetoken.googleapis.com/v1/token?key=' + encodeURIComponent(CONFIG.apiKey);
    const body = 'grant_type=refresh_token&refresh_token=' + encodeURIComponent(state.refreshToken);
    const data = await fetchJsonWithTimeout(refreshUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body
    }, 8000);
    state = {
      ...state,
      uid: data.user_id || state.uid,
      idToken: data.id_token || state.idToken,
      refreshToken: data.refresh_token || state.refreshToken,
      expiresIn: Number(data.expires_in || state.expiresIn || 3600),
      issuedAt: Date.now()
    };
    nativeSet.call(localStorage, AUTH_KEY, JSON.stringify(state));
    return state;
  }

  function withAuthQuery(url, token) {
    if (!token) return url;
    return url + (url.includes('?') ? '&' : '?') + 'auth=' + encodeURIComponent(token);
  }

  async function request(path, options = {}, timeoutMs = 3500, retryAuth = true) {
    const authState = await getValidAuthState(false);
    if (!authState || !authState.idToken) {
      const error = new Error('Firebase Authentication session tidak tersedia. Login ulang.');
      error.status = 401;
      throw error;
    }
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    let timeoutHandle = null;
    const baseUrl = ROOT_URL + path + '.json';
    const url = withAuthQuery(baseUrl, authState.idToken);
    const fetchPromise = (async () => {
      const response = await fetch(url, {
        cache: 'no-store',
        ...options,
        headers: {
          'Content-Type': 'application/json',
          ...(options.headers || {})
        },
        ...(controller ? { signal: controller.signal } : {})
      });
      if (!response.ok) {
        const body = await response.text().catch(() => '');
        const error = new Error('Firebase HTTP ' + response.status + (body ? ': ' + body.slice(0, 160) : ''));
        error.status = response.status;
        throw error;
      }
      const text = await response.text();
      return text ? parseJSON(text, null) : null;
    })();
    const timeoutPromise = new Promise((_, reject) => {
      timeoutHandle = setTimeout(() => {
        try { if (controller) controller.abort(); } catch (_) {}
        const error = new Error('Firebase timeout');
        error.code = 'FIREBASE_TIMEOUT';
        reject(error);
      }, Math.max(1000, timeoutMs));
    });
    try {
      return await Promise.race([fetchPromise, timeoutPromise]);
    } catch (error) {
      if (retryAuth && error && (error.status === 401 || error.status === 403)) {
        try {
          const fresh = await getValidAuthState(true);
          if (fresh && fresh.idToken && fresh.idToken !== authState.idToken) {
            return await request(path, options, timeoutMs, false);
          }
        } catch (_) {}
      }
      throw error;
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }
  }

  function loadPendingPatch() {
    return parseJSON(nativeGet.call(localStorage, PENDING_KEY), {}) || {};
  }

  function savePendingPatch(patch) {
    if (!patch || !Object.keys(patch).length) {
      nativeRemove.call(localStorage, PENDING_KEY);
      return;
    }
    nativeSet.call(localStorage, PENDING_KEY, JSON.stringify(patch));
  }

  function mergePendingPatch(nextPatch) {
    if (!CLOUD_DATA_SYNC_ENABLED) return;
    const current = loadPendingPatch();
    Object.keys(nextPatch || {}).forEach((key) => { current[key] = nextPatch[key]; });
    savePendingPatch(current);
    flushPendingPatch();
  }

  async function flushPendingPatch() {
    if (flushing) return;
    const patch = loadPendingPatch();
    if (!Object.keys(patch).length) return;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      setCloudStatus('offline', 'Offline · data menunggu sinkronisasi');
      return;
    }
    flushing = true;
    if (getSession()) setCloudStatus('syncing', 'Menyinkronkan data…');
    try {
      await request('', { method: 'PATCH', body: JSON.stringify(patch) }, 7000);
      savePendingPatch({});
      setCloudStatus('online', getSession() ? 'Firebase Online' : 'Mode lokal siap');
    } catch (error) {
      if (error && (error.status === 401 || error.status === 403)) {
        setCloudStatus('blocked', 'Firebase ditolak · cek Database Rules');
      } else {
        setCloudStatus('offline', 'Firebase belum tersambung · data disimpan lokal');
      }
    } finally {
      flushing = false;
    }
  }

  function makeDiff(previousDb, nextDb) {
    const previous = normalizeDb(previousDb || {});
    const next = normalizeDb(nextDb || {});
    const patch = {};

    COLLECTIONS.forEach((name) => {
      const before = previous[name] || {};
      const after = next[name] || {};
      const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
      keys.forEach((key) => {
        const a = before[key];
        const b = after[key];
        if (JSON.stringify(a) !== JSON.stringify(b)) {
          patch[name + '/' + key] = b === undefined ? null : b;
        }
      });
    });

    SIMPLE_KEYS.forEach((name) => {
      if (JSON.stringify(previous[name]) !== JSON.stringify(next[name])) {
        patch[name] = next[name] === undefined ? null : next[name];
      }
    });

    if (Object.keys(patch).length) {
      patch['_meta/lastDeviceId'] = deviceId;
      patch['_meta/lastClientUpdate'] = new Date().toISOString();
      patch['_meta/serverTimestamp'] = { '.sv': 'timestamp' };
      patch['_meta/version'] = 10;
    }
    return patch;
  }

  function onStoreOrBarcodePage() {
    try {
      const headings=[...document.querySelectorAll('h2')].map(h=>String(h.textContent||'').trim().toLowerCase());
      return headings.includes('data toko') || headings.includes('barcode toko');
    } catch (_) { return false; }
  }

  function notifyDbChanged(changedCollections) {
    const cols = Array.isArray(changedCollections) ? changedCollections.filter(Boolean) : [];
    if (cols.length && onStoreOrBarcodePage()) {
      const relevant = cols.some((c)=>c==='stores'||c==='barcodes'||c==='barcodeSettings'||c==='products'||c==='users');
      if (!relevant) return;
    }
    window.dispatchEvent(new CustomEvent('zona360-remote-update', { detail:{ collections:cols } }));
  }

  function writeDbFromExternal(db) {
    db = ensureLocalShape(db);
    const previousRaw = nativeGet.call(localStorage, DB_KEY);
    const previous = ensureLocalShape(parseJSON(previousRaw, {}));
    nativeSet.call(localStorage, DB_KEY, JSON.stringify(db));
    const patch = makeDiff(previous, db);
    const patchKeys = Object.keys(patch);
    if (patchKeys.some((k) => k === 'stores' || k.startsWith('stores/') || k === 'barcodes' || k.startsWith('barcodes/'))) barcodeDataDirty = true;
    if (patchKeys.length) mergePendingPatch(patch);
    notifyDbChanged(patchKeys.map((k)=>String(k).split('/')[0]));
  }

  function installStorageBridge() {
    if (window.__z360StorageBridgeInstalled) return;
    window.__z360StorageBridgeInstalled = true;

    Storage.prototype.setItem = function (key, value) {
      if (this !== localStorage || key !== DB_KEY) {
        nativeSet.call(this, key, value);
        if (this === localStorage && key === SESSION_KEY) {
          setTimeout(ensureTrackingUi, 30);
          setTimeout(startCloudAfterLogin, 80);
        }
        return;
      }
      const previousRaw = nativeGet.call(this, key);
      const normalizedNext = ensureLocalShape(parseJSON(value, {}));
      value = JSON.stringify(normalizedNext);
      nativeSet.call(this, key, value);
      if (applyingRemote) return;
      const previous = parseJSON(previousRaw, {});
      const next = normalizedNext;
      const patch = makeDiff(previous, next);
      const patchKeys = Object.keys(patch);
      if (patchKeys.some((k) => k === 'stores' || k.startsWith('stores/') || k === 'barcodes' || k.startsWith('barcodes/'))) barcodeDataDirty = true;
      if (patchKeys.length) mergePendingPatch(patch);
      scheduleProfileSync(next);
    };

    Storage.prototype.removeItem = function (key) {
      nativeRemove.call(this, key);
      if (this === localStorage && key === SESSION_KEY) {
        nativeRemove.call(localStorage, AUTH_KEY);
        cloudStarted = false;
        if (realtimeStream) { try { realtimeStream.close(); } catch (_) {} realtimeStream = null; }
        if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
        if (watchId !== null) stopTracking('logout');
        setTimeout(ensureTrackingUi, 30);
      }
    };
  }

  async function initializeRemoteFromLocal(localDb) {
    const payload = normalizeDb(localDb);
    payload._meta = {
      initialized: true,
      version: 10,
      createdByDevice: deviceId,
      createdAt: new Date().toISOString(),
      serverTimestamp: { '.sv': 'timestamp' }
    };
    await request('', { method: 'PUT', body: JSON.stringify(payload) }, 7000);
  }

  function applyRemote(remote) {
    if (!remote || typeof remote !== 'object') return false;

    // Merge collection-by-collection instead of replacing the whole local DB.
    // Older RC builds could create a Firebase root containing only `users`;
    // replacing the local DB with that snapshot caused screens such as the
    // Admin dashboard to crash when reading stores.length/products.length.
    const localDb = ensureLocalShape(parseJSON(nativeGet.call(localStorage, DB_KEY), {}));
    const merged = { ...localDb };

    COLLECTIONS.forEach((name) => {
      if (Object.prototype.hasOwnProperty.call(remote, name) && remote[name] != null) {
        merged[name] = valuesOf(remote[name]);
      }
    });
    SIMPLE_KEYS.forEach((name) => {
      if (Object.prototype.hasOwnProperty.call(remote, name) && remote[name] != null) {
        merged[name] = remote[name];
      }
    });
    ensureLocalShape(merged);

    if (comparableDb(localDb) === comparableDb(merged)) return false;
    applyingRemote = true;
    try {
      nativeSet.call(localStorage, DB_KEY, JSON.stringify(merged));
    } finally {
      applyingRemote = false;
    }
    // A full Firebase refresh can replace stores/barcodes without passing through
    // Storage.setItem, so the barcode cache MUST be invalidated here as well.
    barcodeDataDirty = true;
    barcodeDataCache = null;
    barcodeDataCacheRaw = '';
    notifyDbChanged();
    return true;
  }

  async function fetchAndApplyRemote() {
    if (flushing || Object.keys(loadPendingPatch()).length) return;
    try {
      const remote = await request('', { method: 'GET' }, 5000);
      if (remote && typeof remote === 'object') {
        applyRemote(remote);
        setCloudStatus('online', 'Firebase Online');
      }
    } catch (error) {
      if (error && (error.status === 401 || error.status === 403)) {
        setCloudStatus('blocked', 'Firebase ditolak · cek Database Rules');
      } else if (navigator.onLine === false) {
        setCloudStatus('offline', 'Offline · memakai data lokal');
      }
    }
  }

  let realtimeStream = null;
  let realtimeReconnectTimer = null;

  async function bootstrapOperationalCloud() {
    const session = getSession();
    if (!session) return;
    try {
      setCloudStatus('connecting', 'Menghubungkan data operasional Firebase…');
      const remote = await request('', { method: 'GET' }, 6500);
      if (remote && typeof remote === 'object') {
        applyRemote(remote);
        setCloudStatus('online', 'Firebase Realtime aktif');
        return;
      }
      if (session.role === 'admin') {
        await initializeRemoteFromLocal(getDb() || ensureLocalShape({}));
        setCloudStatus('online', 'Firebase diinisialisasi · realtime aktif');
      } else {
        setCloudStatus('online', 'Firebase aktif · menunggu data Admin');
      }
    } catch (error) {
      if (error && (error.status === 401 || error.status === 403)) {
        setCloudStatus('blocked', 'Data operasional ditolak Firebase Rules');
      } else {
        setCloudStatus('offline', 'Firebase data belum tersambung · mode lokal aman');
      }
    }
  }

  function findRemoteRecordIndex(arr, key) {
    return (arr||[]).findIndex((item)=>{
      if(!item)return false;
      const id=String(item.id||item.uid||item.userId||'');
      return id===String(key)||safeKey(id)===String(key);
    });
  }

  function setNestedRemoteValue(target, parts, value) {
    if (!parts.length) return value;
    let obj=target;
    for(let i=0;i<parts.length-1;i++){
      const k=parts[i];
      if(!obj[k]||typeof obj[k]!=='object')obj[k]={};
      obj=obj[k];
    }
    const last=parts[parts.length-1];
    if(value===null) delete obj[last]; else obj[last]=value;
    return target;
  }

  function applyRealtimePath(db, path, value, mode) {
    const parts=String(path||'/').split('/').filter(Boolean);
    if(!parts.length){
      if(mode==='put' && value && typeof value==='object') return applyRemote(value);
      return false;
    }
    const collection=parts[0];
    if(!COLLECTIONS.includes(collection) && !SIMPLE_KEYS.includes(collection)) return false;
    if(SIMPLE_KEYS.includes(collection)){
      if(parts.length===1) db[collection]=value;
      else db[collection]=setNestedRemoteValue({...((db[collection]&&typeof db[collection]==='object')?db[collection]:{})},parts.slice(1),value);
      return true;
    }
    db[collection]=Array.isArray(db[collection])?db[collection]:[];
    if(parts.length===1){
      if(mode==='put') db[collection]=valuesOf(value);
      else if(value&&typeof value==='object') Object.entries(value).forEach(([k,v])=>applyRealtimePath(db,'/'+collection+'/'+k,v,'patch'));
      return true;
    }
    const key=parts[1];
    let idx=findRemoteRecordIndex(db[collection],key);
    if(parts.length===2){
      if(value===null){ if(idx>=0) db[collection].splice(idx,1); return true; }
      const existing=idx>=0?db[collection][idx]:{};
      const record={...existing,...(value&&typeof value==='object'?value:{value})};
      if(!record.id && !record.uid) record.id=key;
      if(idx>=0) db[collection][idx]=record; else db[collection].push(record);
      return true;
    }
    let record=idx>=0?{...db[collection][idx]}:{id:key};
    record=setNestedRemoteValue(record,parts.slice(2),value);
    if(idx>=0) db[collection][idx]=record; else db[collection].push(record);
    return true;
  }

  function applyRealtimeEvent(event, mode) {
    try {
      const payload=parseJSON(event&&event.data, null);
      if(!payload||typeof payload!=='object')return;
      const path=String(payload.path||'/');
      const data=payload.data;
      if(path==='/' && mode==='put') { applyRemote(data||{}); return; }
      const local=ensureLocalShape(parseJSON(nativeGet.call(localStorage,DB_KEY),{}));
      const changed=new Set();
      let touched=false;
      if(path==='/' && mode==='patch' && data && typeof data==='object'){
        Object.entries(data).forEach(([k,v])=>{
          const clean=String(k).replace(/^\/+/, '');
          const col=clean.split('/')[0];
          if(col==='_meta')return;
          if(applyRealtimePath(local,'/'+clean,v,'patch')){touched=true;changed.add(col)}
        });
      }else{
        const col=path.split('/').filter(Boolean)[0];
        touched=applyRealtimePath(local,path,data,mode);
        if(touched&&col)changed.add(col);
      }
      if(!touched)return;
      ensureLocalShape(local);
      applyingRemote=true;
      try{nativeSet.call(localStorage,DB_KEY,JSON.stringify(local))}finally{applyingRemote=false}
      if(changed.has('stores')||changed.has('barcodes'))barcodeDataDirty=true;
      notifyDbChanged([...changed]);
      setCloudStatus('online','Firebase Realtime aktif');
    } catch(e) { console.warn('Zona360 realtime event',e); }
  }

  async function startRealtimeStream() {
    if (!getSession() || typeof EventSource === 'undefined') return;
    try {
      const authState = await getValidAuthState(false);
      if (!authState || !authState.idToken) return;
      if (realtimeStream) { try { realtimeStream.close(); } catch (_) {} realtimeStream = null; }
      const url = withAuthQuery(ROOT_URL + '.json', authState.idToken);
      const es = new EventSource(url);
      realtimeStream = es;
      es.addEventListener('put', (ev)=>applyRealtimeEvent(ev,'put'));
      es.addEventListener('patch', (ev)=>applyRealtimeEvent(ev,'patch'));
      es.onopen = () => setCloudStatus('online', 'Firebase Realtime aktif');
      es.onerror = () => {
        try { es.close(); } catch (_) {}
        if (realtimeStream === es) realtimeStream = null;
        clearTimeout(realtimeReconnectTimer);
        realtimeReconnectTimer = setTimeout(startRealtimeStream, 5000);
      };
    } catch (e) {
      console.warn('Zona360 realtime stream', e);
    }
  }

  function startPolling() {
    if (!getSession()) return;
    if (pollTimer) clearInterval(pollTimer);
    // EventSource is the realtime path. Polling is only a safety fallback, not a
    // 2.5-second full-database fetch that can freeze low-end Android WebViews.
    pollTimer = setInterval(() => {
      flushPendingPatch();
      if (!realtimeStream) fetchAndApplyRemote();
      ensureTrackingUi();
      ensureAdvancedMonitoringUi();
    }, 12000);
    if(!window.__z360NetworkHooksInstalled){
      window.__z360NetworkHooksInstalled=true;
      window.addEventListener('online', () => { flushPendingPatch(); if(!realtimeStream)fetchAndApplyRemote(); });
      window.addEventListener('offline', () => setCloudStatus('offline', 'Offline · data disimpan lokal'));
    }
  }

  function getSession() {
    return parseJSON(nativeGet.call(localStorage, SESSION_KEY), null);
  }

  function getDb() {
    const raw = parseJSON(nativeGet.call(localStorage, DB_KEY), null);
    return raw ? ensureLocalShape(raw) : null;
  }

  function distanceMeters(a, b) {
    if (!a || !b) return Infinity;
    const R = 6371000;
    const p1 = a.lat * Math.PI / 180;
    const p2 = b.lat * Math.PI / 180;
    const dp = (b.lat - a.lat) * Math.PI / 180;
    const dl = (b.lng - a.lng) * Math.PI / 180;
    const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  function updateUserTracking(db, session, point, status) {
    if (!db || !session) return db;
    const now = new Date().toISOString();
    const patchUser = (user) => user && user.id === session.id ? {
      ...user,
      status: user.status || 'active',
      trackingStatus: status,
      lastSeen: now,
      ...(point ? { lastLocation: { lat: point.lat, lng: point.lng, accuracy: point.accuracy, timestamp: now } } : {})
    } : user;
    db.users = (db.users || []).map(patchUser);
    db.sales = (db.sales || []).map(patchUser);
    return db;
  }

  function appendTrackingActivity(db, session, action, point, extra = {}) {
    if (!db || !session) return;
    const now = new Date().toISOString();
    db.activities = Array.isArray(db.activities) ? db.activities : [];
    db.activities.unshift({
      id: 'track-' + session.id + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
      userId: session.id,
      userName: session.name,
      storeId: null,
      storeName: 'Perjalanan Sales',
      action,
      timestamp: now,
      lat: point && point.lat,
      lng: point && point.lng,
      accuracy: point && point.accuracy,
      gpsStatus: point ? 'live' : 'unknown',
      tracking: true,
      ...extra
    });
  }

  function persistTrackPoint(point) {
    const session = getSession();
    if (!session || session.role !== 'sales') return;
    const db = getDb();
    if (!db) return;

    const nowMs = Date.now();
    const moved = lastPoint ? distanceMeters(lastPoint, point) : Infinity;
    const shouldHistory = firstTrackPoint || nowMs - lastPointSavedAt >= 10000 || moved >= 10;
    const shouldLiveWrite = firstTrackPoint || shouldHistory || nowMs - lastLiveWriteAt >= 2500;
    if (!shouldLiveWrite) { updateTrackingUiState('active', point); return; }

    updateUserTracking(db, session, point, 'active');
    db.gpsHistory = Array.isArray(db.gpsHistory) ? db.gpsHistory : [];

    if (shouldHistory) {
      const timestamp = new Date().toISOString();
      db.gpsHistory.unshift({
        id: 'gps-' + session.id + '-' + nowMs,
        userId: session.id,
        userName: session.name,
        lat: point.lat,
        lng: point.lng,
        accuracy: point.accuracy,
        timestamp,
        deviceId
      });
      if (db.gpsHistory.length > 6000) db.gpsHistory = db.gpsHistory.slice(0, 6000);
      appendTrackingActivity(db, session, firstTrackPoint ? 'Mulai kerja' : 'GPS realtime', point);
      lastPointSavedAt = nowMs;
      lastPoint = point;
      firstTrackPoint = false;
    }

    writeDbFromExternal(db);
    lastLiveWriteAt = nowMs;
    updateTrackingUiState('active', point);
  }

  function handlePosition(position) {
    if (!position || !position.coords) return;
    const accuracy = Number(position.coords.accuracy || 0);
    if (!Number.isFinite(position.coords.latitude) || !Number.isFinite(position.coords.longitude)) return;
    const point = {
      lat: Number(position.coords.latitude),
      lng: Number(position.coords.longitude),
      accuracy: Number.isFinite(accuracy) ? accuracy : 0
    };
    const now=Date.now();

    // Reject very poor fixes and impossible teleports so the route does not jump
    // across the map when Android briefly reports an unstable location.
    if (point.accuracy > 250 && lastAcceptedPoint) {
      updateTrackingUiState('active', lastAcceptedPoint, 'Menunggu akurasi GPS membaik…');
      return;
    }
    if (lastAcceptedPoint && lastAcceptedPointAt) {
      const meters=distanceMeters(lastAcceptedPoint,point);
      const seconds=Math.max(0.5,(now-lastAcceptedPointAt)/1000);
      const speed=meters/seconds;
      if (meters>500 && speed>60) {
        updateTrackingUiState('active', lastAcceptedPoint, 'Mengabaikan lonjakan GPS tidak wajar…');
        return;
      }
    }
    lastAcceptedPoint=point;
    lastAcceptedPointAt=now;
    persistTrackPoint(point);
  }

  function setLoginStatus(stage, message, state) {
    try { nativeSet.call(localStorage, 'zona360_login_stage', stage); } catch (_) {}
    try {
      if (!document.body) return;
      let el = document.getElementById('z360-auth-live');
      if (!el) {
        el = document.createElement('div');
        el.id = 'z360-auth-live';
        // Keep diagnostics OUTSIDE React-managed form/root and never intercept taps.
        el.style.cssText = 'position:fixed;left:12px;right:12px;bottom:12px;z-index:2147483000;pointer-events:none;padding:9px 10px;border-radius:8px;font:600 11px/1.45 system-ui,-apple-system,Segoe UI,sans-serif;background:#eef7f5;color:#176b5c;border:1px solid #d5ebe6;box-shadow:0 5px 18px rgba(0,0,0,.10)';
        document.body.appendChild(el);
      }
      const nextText = String(message || stage || '');
      const nextState = String(state || 'info');
      if (el.textContent !== nextText) el.textContent = nextText;
      if (el.dataset.state !== nextState) el.dataset.state = nextState;
      if (nextState === 'error') {
        if (el.style.background !== 'rgb(255, 240, 240)') el.style.background='#fff0f0';
        el.style.color='#a93434'; el.style.borderColor='#ffd3d3';
      } else if (nextState === 'ok') {
        el.style.background='#e9f8f3'; el.style.color='#087a65'; el.style.borderColor='#cceee4';
      } else {
        el.style.background='#fff5eb'; el.style.color='#9b542c'; el.style.borderColor='#f7dcc8';
      }
    } catch (_) {}
  }

  function ensureLoginStatusUi() {
    if (getSession()) {
      const el = document.getElementById('z360-auth-live');
      if (el) el.remove();
      return;
    }
    // Minimal login: do not show a permanent technical Firebase banner.
    // Status appears only while authenticating or when an error needs attention.
    if (document.querySelector('form.login-form') && !document.getElementById('z360-auth-live')) {
      try { nativeSet.call(localStorage,'zona360_login_stage','READY'); } catch (_) {}
    }
  }


  function ensureModernPresentation() {
    if (!document.head) return;
    if (!document.getElementById('z360-modern-style')) {
      const style=document.createElement('style');
      style.id='z360-modern-style';
      style.textContent=`
        :root{--z360-navy:#132b36;--z360-orange:#f2663b;--z360-teal:#1f9d8a;--z360-bg:#f5f7f6;--z360-line:#dfe6e3}
        .login-page{background:#102832!important}
        .login-panel{position:relative;isolation:isolate;overflow:hidden;background:
          radial-gradient(circle at 18% 15%,rgba(31,157,138,.16),transparent 34%),
          radial-gradient(circle at 88% 86%,rgba(242,102,59,.15),transparent 34%),
          linear-gradient(160deg,#f8fbfa 0%,#eef4f1 100%)!important}
        .login-panel:before{content:"";position:absolute;inset:0;z-index:-2;background:url('/manus-storage/logo_bddc6c14.png') center 13%/180px 180px no-repeat;opacity:.055;filter:saturate(.8)}
        .login-panel:after{content:"";position:absolute;width:360px;height:360px;border:1px solid rgba(31,157,138,.12);border-radius:50%;left:50%;top:11%;transform:translate(-50%,-50%);z-index:-1;box-shadow:0 0 0 48px rgba(31,157,138,.035),0 0 0 96px rgba(242,102,59,.025)}
        .login-box{border:1px solid rgba(20,53,62,.10)!important;border-left:0!important;background:rgba(255,255,255,.92);backdrop-filter:blur(12px);border-radius:22px;padding:24px!important;width:min(410px,100%)!important;box-shadow:0 24px 70px rgba(17,43,53,.13)!important}
        .login-rule,.login-box>.eyebrow,.login-box>p,.login-security,.login-box:after{display:none!important}
        .z360-login-brand{display:flex;align-items:center;gap:12px;margin-bottom:18px}
        .z360-login-brand img{width:46px;height:46px;border-radius:14px;box-shadow:0 8px 24px rgba(18,50,61,.14)}
        .z360-login-brand b{display:block;color:var(--z360-navy);font-size:18px;letter-spacing:-.2px}
        .z360-login-brand span{display:block;color:#77908d;font-size:10px;letter-spacing:1.4px;margin-top:2px;text-transform:uppercase}
        .login-box h2{font-size:28px!important;letter-spacing:-.7px;margin:0 0 20px!important;color:var(--z360-navy)}
        .login-box>.toolbar{display:grid!important;grid-template-columns:1fr 1fr;gap:8px;margin:0 0 18px!important}
        .login-box>.toolbar .btn{min-height:42px;border-radius:12px!important}
        .login-form{gap:13px!important}
        .login-form .field label{font-size:10px!important;letter-spacing:.9px;color:#566c70}
        .login-form input{height:48px!important;border-radius:12px!important;border:1px solid #d9e2df!important;background:#fbfdfc!important;padding:0 14px!important;font-size:15px!important;outline:none}
        .login-form input:focus{border-color:var(--z360-teal)!important;box-shadow:0 0 0 3px rgba(31,157,138,.10)}
        .login-form .btn.orange{height:48px;border-radius:12px!important;box-shadow:0 10px 22px rgba(242,102,59,.20)}
        #z360-auth-live{left:50%!important;right:auto!important;bottom:18px!important;transform:translateX(-50%);width:min(420px,calc(100% - 28px));box-sizing:border-box;text-align:center;border-radius:12px!important;font-size:10px!important}
        .z360-modal-overlay{position:fixed;inset:0;z-index:2147483000;background:rgba(8,28,35,.60);display:flex;align-items:center;justify-content:center;padding:16px;overflow:auto;backdrop-filter:blur(4px)}
        .z360-modal-card{width:min(560px,100%);background:#fff;border-radius:20px;padding:20px;box-shadow:0 30px 90px rgba(0,0,0,.28);font-family:inherit;color:#162a31}
        .z360-modal-head{display:flex;justify-content:space-between;gap:14px;align-items:flex-start;margin-bottom:18px}
        .z360-modal-kicker{font-size:9px;font-weight:900;letter-spacing:1.5px;color:var(--z360-orange)}
        .z360-modal-title{font-size:21px;font-weight:900;margin-top:4px}.z360-modal-sub{font-size:11px;color:#718084;line-height:1.55;margin-top:5px}
        .z360-icon-btn{border:0;background:#f1f4f3;border-radius:10px;width:34px;height:34px;font-weight:900;color:#53666b}
        .z360-form-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}.z360-span-2{grid-column:1/-1}
        .z360-field{display:block;font-size:10px;font-weight:900;letter-spacing:.6px;color:#53666b}
        .z360-field input,.z360-field select{display:block;width:100%;box-sizing:border-box;margin-top:6px;padding:11px 12px;min-height:44px;border:1px solid #d9e2df;border-radius:11px;font:inherit;background:#fff;color:#172d35;outline:none}
        .z360-field input:focus,.z360-field select:focus{border-color:var(--z360-teal);box-shadow:0 0 0 3px rgba(31,157,138,.10)}
        .z360-username-wrap{display:flex;align-items:center;margin-top:6px;border:1px solid #d9e2df;border-radius:11px;overflow:hidden;background:#fff}.z360-username-wrap span{padding-left:12px;color:#83918f;font-weight:800}.z360-username-wrap input{margin:0;border:0!important;box-shadow:none!important}
        .z360-helper{margin-top:12px;padding:10px 12px;border-radius:10px;background:#f1f8f6;color:#52706b;font-size:10px;line-height:1.5}
        .z360-modal-msg{margin-top:12px;padding:10px 12px;border-radius:10px;font-size:11px}.z360-modal-msg[data-ok="1"]{background:#e9f7ef;color:#19764a}.z360-modal-msg[data-ok="0"]{background:#fff0ed;color:#b73d26}
        .z360-modal-actions{display:flex;justify-content:flex-end;gap:9px;margin-top:16px}
        #z360-advanced-monitor{border:1px solid #e1e7e4!important;border-radius:18px!important;box-shadow:0 12px 34px rgba(18,43,53,.07)!important;background:#fff!important;overflow:visible!important}
        .z360-monitor-head{display:flex;justify-content:space-between;align-items:flex-start;gap:12px}.z360-monitor-title{font-size:16px;font-weight:900;color:#18333d}.z360-monitor-sub{font-size:10px;color:#738487;margin-top:4px;line-height:1.5}
        .z360-live-pill{display:inline-flex;align-items:center;gap:6px;border-radius:999px;padding:7px 10px;background:#e9f8f3;color:#087a65;font-size:9px;font-weight:900;white-space:nowrap}.z360-live-pill:before{content:"";width:7px;height:7px;border-radius:50%;background:#19aa86;box-shadow:0 0 0 4px rgba(25,170,134,.14);animation:z360pulse 1.6s infinite}
        @keyframes z360pulse{50%{box-shadow:0 0 0 7px rgba(25,170,134,0)}}
        .z360-monitor-toolbar{display:grid;grid-template-columns:minmax(150px,1.4fr) 1fr 1fr auto auto;gap:8px;margin:13px 0}
        .z360-monitor-toolbar .search,.z360-monitor-toolbar .btn{min-width:0;width:100%;box-sizing:border-box;min-height:40px;border-radius:10px!important}
        .z360-monitor-stats{display:flex;gap:7px;flex-wrap:wrap;margin-bottom:10px}.z360-stat-chip{padding:7px 9px;border-radius:9px;background:#f3f6f5;font-size:9px;color:#5e7074;font-weight:800}
        .z360-map-shell{position:relative;height:clamp(330px,52vh,480px);border-radius:15px;overflow:hidden;background:#dcebe5;border:1px solid #dbe4e0}
        #z360-route-map{height:100%!important;border-radius:0!important}
        .z360-map-legend{position:absolute;z-index:700;left:10px;bottom:10px;background:rgba(255,255,255,.94);backdrop-filter:blur(8px);border-radius:10px;padding:8px 10px;box-shadow:0 5px 18px rgba(17,42,50,.13);font-size:9px;color:#53666b;display:flex;gap:10px;flex-wrap:wrap}
        .z360-map-legend i{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:4px}.z360-map-legend .sales i{background:#f2663b}.z360-map-legend .route i{background:#1f9d8a}.z360-map-legend .visited i{background:#2da36b}
        .z360-sales-marker{width:34px;height:34px;border-radius:50%;background:#f2663b;color:#fff;border:3px solid #fff;box-shadow:0 6px 16px rgba(19,43,54,.28);display:grid;place-items:center;font:900 10px system-ui;position:relative}.z360-sales-marker:after{content:"";position:absolute;inset:-7px;border-radius:50%;border:2px solid rgba(242,102,59,.30);animation:z360marker 1.8s infinite}@keyframes z360marker{70%,100%{transform:scale(1.35);opacity:0}}
        .z360-store-marker{width:28px;height:28px;border-radius:9px;background:#24996c;color:#fff;border:2px solid #fff;box-shadow:0 5px 14px rgba(17,43,53,.22);display:grid;place-items:center;font:900 14px system-ui}
        .z360-monitor-base-grid .map-card{display:none!important}.z360-monitor-base-grid{grid-template-columns:1fr!important}
        .z360-monitor-base-grid .card{max-width:100%!important}
        .mobile-backdrop{z-index:5000!important}.mobile-drawer{z-index:5001!important;background:#f8faf9!important;box-shadow:-20px 0 60px rgba(16,38,47,.24)!important}.mobile-toolbar{z-index:4900!important}
        @media(max-width:720px){
          .login-panel{padding:18px!important;align-items:center!important}.login-panel:before{background-size:145px 145px;background-position:center 7%}.login-box{padding:20px!important;border-radius:18px!important}.login-box h2{font-size:25px!important}
          .z360-form-grid{grid-template-columns:1fr}.z360-span-2{grid-column:auto}.z360-modal-card{padding:17px;border-radius:17px}
          .z360-monitor-toolbar{grid-template-columns:1fr 1fr}.z360-monitor-toolbar #z360-mon-sales{grid-column:1/-1}.z360-monitor-toolbar .btn{min-height:38px}
          .z360-map-shell{height:360px}.z360-map-legend{right:10px;gap:7px;justify-content:center}
          #z360-advanced-monitor{padding:13px!important;margin-top:12px!important}.z360-monitor-head{align-items:center}.z360-monitor-sub{max-width:230px}
        }
      `;
      document.head.appendChild(style);
    }

    const session=getSession();
    if(session) return;
    const form=document.querySelector('form.login-form');
    if(!form) return;
    const box=form.closest('.login-box');
    if(!box) return;

    box.querySelectorAll('.field').forEach((field)=>{
      const label=field.querySelector('label');
      if(!label)return;
      const text=String(label.textContent||'').trim().toUpperCase();
      const input=field.querySelector('input');
      if(text.includes('EMAIL FIREBASE')||text==='EMAIL'){
        label.childNodes[0].nodeValue='USERNAME';
        if(input){
          input.type='text'; input.placeholder='username'; input.autocomplete='username';
          input.setAttribute('autocapitalize','none'); input.setAttribute('spellcheck','false');
        }
      }else if(text.includes('PASSWORD FIREBASE')){
        label.childNodes[0].nodeValue='PASSWORD';
        if(input)input.autocomplete='current-password';
      }
    });

    let brand=box.querySelector('.z360-login-brand');
    if(!brand){
      brand=document.createElement('div');
      brand.className='z360-login-brand';
      brand.innerHTML='<img src="/manus-storage/logo_bddc6c14.png" alt="Zona360"><div><b>Zona360</b><span>Sales Tracker</span></div>';
      const h2=box.querySelector('h2');
      if(h2)box.insertBefore(brand,h2);
      else box.insertBefore(brand,box.firstChild);
    }
    const h2=box.querySelector('h2');
    if(h2 && h2.textContent!=='Masuk ke Zona360')h2.textContent='Masuk ke Zona360';
  }

  function firebaseAuthErrorMessage(code) {
    const map = {
      INVALID_LOGIN_CREDENTIALS: 'Username atau password salah.',
      EMAIL_NOT_FOUND: 'Username tidak ditemukan.',
      INVALID_PASSWORD: 'Password salah.',
      USER_DISABLED: 'Akun Firebase dinonaktifkan.',
      TOO_MANY_ATTEMPTS_TRY_LATER: 'Terlalu banyak percobaan login. Coba lagi beberapa saat.',
      NETWORK_REQUEST_FAILED: 'Tidak dapat terhubung ke Firebase. Periksa internet.',
      API_KEY_INVALID: 'API key Firebase tidak valid.',
      API_KEY_SERVICE_BLOCKED: 'API key Firebase diblokir untuk Authentication.',
      OPERATION_NOT_ALLOWED: 'Login Email/Password belum diaktifkan di Firebase Authentication.',
      INVALID_EMAIL: 'Username tidak valid.'
    };
    return map[code] || ('Firebase Authentication gagal' + (code ? ': ' + code : '.'));
  }

  async function fetchJsonWithTimeout(url, options = {}, timeoutMs = 8000) {
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    let timer;
    try {
      const fetchPromise = fetch(url, {
        cache: 'no-store',
        ...options,
        headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
        ...(controller ? { signal: controller.signal } : {})
      });
      const timeoutPromise = new Promise((_, reject) => {
        timer = setTimeout(() => {
          try { if (controller) controller.abort(); } catch (_) {}
          const err = new Error('Koneksi Firebase timeout. Periksa internet lalu coba lagi.');
          err.code = 'FIREBASE_TIMEOUT';
          reject(err);
        }, timeoutMs);
      });
      let response;
      try {
        response = await Promise.race([fetchPromise, timeoutPromise]);
      } catch (networkError) {
        setLoginStatus('NETWORK_ERROR', networkError && networkError.message ? networkError.message : 'Tidak dapat menghubungi Firebase.', 'error');
        throw networkError;
      }
      const text = await response.text();
      const data = text ? parseJSON(text, {}) : {};
      if (!response.ok) {
        const code = data && data.error && data.error.message ? String(data.error.message).split(' : ')[0] : ('HTTP_' + response.status);
        const err = new Error(firebaseAuthErrorMessage(code));
        err.code = code;
        err.status = response.status;
        setLoginStatus('FIREBASE_ERROR_' + code, err.message, 'error');
        throw err;
      }
      return data;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  function normalizeProfile(uid, authEmail, profile) {
    const role = String(profile.role || '').toLowerCase();
    const active = profile.active === true || profile.active === 'true' || profile.status === 'active';
    const username = displayUsername(profile, authEmail);
    const common = {
      ...profile,
      id: String(uid),
      uid: String(uid),
      email: String(profile.email || authEmail || ''),
      username,
      name: String(profile.name || username || 'Pengguna'),
      role,
      active,
      status: active ? 'active' : 'inactive'
    };
    if (role === 'admin') {
      common.permissions = ADMIN_PERMISSIONS.slice();
      common.dashboard = ADMIN_DASHBOARD.slice();
    } else if (role === 'sales') {
      if (!Array.isArray(common.permissions)) common.permissions = ['orders','monitoring'];
      if (!Array.isArray(common.dashboard)) common.dashboard = ['field','visits','scan','orders','feedback'];
    }
    return common;
  }

  async function authenticate(selectedRole, emailOrUsername, password) {
    setLoginStatus('AUTH_START', 'Memverifikasi username dan password…', 'info');
    const requestedRole = selectedRole === 'sales' ? 'sales' : 'admin';
    const loginId = String(emailOrUsername || '').trim();
    const cleanPass = String(password || '');
    if (!loginId || !cleanPass) throw new Error('Masukkan username dan password.');

    // User only types a simple username. Firebase Email/Password stays behind the scenes.
    // Existing full-email login remains supported for backward compatibility.
    const firebaseEmail = loginId.includes('@') ? loginId.toLowerCase() : usernameToFirebaseEmail(loginId);
    if (!firebaseEmail || !firebaseEmail.includes('@')) {
      throw new Error('Username tidak valid. Gunakan huruf, angka, titik, garis bawah, atau tanda minus.');
    }

    setCloudStatus('syncing', 'Memverifikasi Firebase Authentication…');
    const authUrl = 'https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=' + encodeURIComponent(CONFIG.apiKey);
    const auth = await fetchJsonWithTimeout(authUrl, {
      method: 'POST',
      body: JSON.stringify({ email: firebaseEmail, password: cleanPass, returnSecureToken: true })
    }, 9000);

    setLoginStatus('AUTH_RESPONSE', '2/3 Firebase Authentication berhasil · mengambil UID…', 'ok');
    const uid = auth && auth.localId;
    const idToken = auth && auth.idToken;
    if (!uid || !idToken) { setLoginStatus('AUTH_NO_UID','Firebase Auth berhasil tetapi UID/token tidak diterima.','error'); throw new Error('Firebase Authentication berhasil tetapi UID/token tidak diterima.'); }

    setLoginStatus('AUTH_OK_PROFILE_FETCH', '2/3 UID diterima · membaca profile /users/{uid}…', 'info');
    setCloudStatus('syncing', 'Membaca profile dan role…');
    const profileUrl = CONFIG.databaseURL.replace(/\/$/, '') + '/users/' + encodeURIComponent(uid) + '.json?auth=' + encodeURIComponent(idToken);
    let profile;
    try {
      profile = await fetchJsonWithTimeout(profileUrl, { method: 'GET' }, 7000);
    } catch (error) {
      if (error && error.status === 401) throw new Error('Login berhasil, tetapi token Firebase ditolak oleh Realtime Database.');
      if (error && error.status === 403) throw new Error('Login berhasil, tetapi Security Rules menolak akses profile user.');
      throw error;
    }

    if (!profile || typeof profile !== 'object' || Array.isArray(profile) || !Object.keys(profile).length) {
      setLoginStatus('PROFILE_MISSING','Login berhasil, tetapi profile/role tidak ditemukan di /users/' + uid + '.','error'); throw new Error('Login berhasil, tetapi profile/role user tidak ditemukan di database.');
    }

    setLoginStatus('PROFILE_OK', '3/3 Profile ditemukan · memeriksa role…', 'ok');
    const user = normalizeProfile(uid, auth.email || firebaseEmail, profile);
    if (!user.active) { setLoginStatus('PROFILE_INACTIVE','Akun ditemukan tetapi statusnya tidak aktif.','error'); throw new Error('Akun ditemukan tetapi statusnya tidak aktif.'); }
    if (user.role !== 'admin' && user.role !== 'sales') { setLoginStatus('ROLE_INVALID','Role user tidak valid: ' + user.role,'error'); throw new Error('Role user tidak valid. Gunakan role admin atau sales.'); }
    if (user.role !== requestedRole) { setLoginStatus('ROLE_MISMATCH','Role akun adalah ' + user.role + '. Pilih tombol yang sesuai.','error'); throw new Error('Role akun adalah ' + user.role + '. Pilih tombol ' + (user.role === 'admin' ? 'Admin' : 'Sales') + ' sebelum login.'); }

    nativeSet.call(localStorage, AUTH_KEY, JSON.stringify({
      uid,
      email: auth.email || firebaseEmail,
      idToken,
      refreshToken: auth.refreshToken || '',
      expiresIn: Number(auth.expiresIn || 3600),
      issuedAt: Date.now()
    }));

    // Keep the authenticated profile in the app's local user list so existing screens
    // can resolve name/role without storing the Firebase password anywhere.
    const localDb = ensureLocalShape(parseJSON(nativeGet.call(localStorage, DB_KEY), {}) || {});
    localDb.users = (localDb.users || []).filter((u) => u && u.id !== user.id && u.email !== user.email);
    localDb.users.unshift(user);
    if (user.role === 'sales') {
      localDb.sales = (localDb.sales || []).filter((u) => u && u.id !== user.id);
      localDb.sales.unshift(user);
    }
    applyingRemote = true;
    try { nativeSet.call(localStorage, DB_KEY, JSON.stringify(localDb)); } finally { applyingRemote = false; }
    // Do not dispatch a React database refresh while the async login component is
    // still resolving. RC12 could transition and refresh two independent G6 hooks
    // in the same tick. Persist first; the login callback performs a clean reload.
    setLoginStatus('PROFILE_READY', 'Login berhasil · membuka Dashboard ' + user.role + '…', 'ok');
    setCloudStatus('online', 'Firebase Auth aktif · ' + user.role);
    return user;
  }

  async function requestUserProfile(uid, options = {}, timeoutMs = 6000) {
    const authState = await getValidAuthState(false);
    if (!authState || !authState.idToken) throw new Error('Session Admin Firebase tidak tersedia. Login ulang.');
    const url = withAuthQuery(CONFIG.databaseURL.replace(/\/$/, '') + '/users/' + encodeURIComponent(uid) + '.json', authState.idToken);
    return await fetchJsonWithTimeout(url, options, timeoutMs);
  }

  // Spark/free user management. No Cloud Functions or Blaze plan required.
  // Firebase Auth REST is called directly so creating another user does NOT replace
  // the currently logged-in Admin session stored by Zona360.
  function managedProfileDefaults(role) {
    const r = String(role || '').toLowerCase() === 'admin' ? 'admin' : 'sales';
    return r === 'admin'
      ? { role: 'admin', permissions: ADMIN_PERMISSIONS.slice(), dashboard: ADMIN_DASHBOARD.slice() }
      : { role: 'sales', permissions: ['orders','monitoring'], dashboard: ['field','visits','scan','orders','feedback'] };
  }

  function firebaseAuthError(error, fallback) {
    const code = String(error && error.code || '').toUpperCase();
    const map = {
      EMAIL_EXISTS: 'Email tersebut sudah terdaftar di Firebase Authentication.',
      INVALID_EMAIL: 'Username tidak valid.',
      WEAK_PASSWORD: 'Password terlalu lemah. Gunakan minimal 6 karakter.',
      OPERATION_NOT_ALLOWED: 'Login Email/Password belum diaktifkan di Firebase Authentication.',
      TOO_MANY_ATTEMPTS_TRY_LATER: 'Terlalu banyak percobaan. Coba lagi beberapa saat.',
      EMAIL_NOT_FOUND: 'Email tersebut tidak terdaftar di Firebase Authentication.'
    };
    return new Error(map[code] || (error && error.message) || fallback || 'Firebase Authentication gagal.');
  }

  async function signUpFirebaseUser(email, password) {
    const url = 'https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=' + encodeURIComponent(CONFIG.apiKey);
    try {
      const data = await fetchJsonWithTimeout(url, {
        method: 'POST',
        body: JSON.stringify({ email, password, returnSecureToken: true })
      }, 12000);
      const uid = String(data && data.localId || '').trim();
      if (!uid) throw new Error('Firebase tidak mengembalikan UID user baru.');
      return { uid, email: String(data.email || email), idToken: String(data.idToken || '') };
    } catch (error) {
      throw firebaseAuthError(error, 'Gagal membuat akun Firebase Authentication.');
    }
  }

  async function writeManagedProfile(profile) {
    const uid = String(profile && (profile.uid || profile.id) || '').trim();
    if (!uid) throw new Error('UID user baru tidak tersedia.');
    const clean = { ...profile, id: uid, uid };
    delete clean.password;
    delete clean.passwordHash;

    // /users/{uid} is authoritative for login role.
    await requestUserProfile(uid, { method: 'PUT', body: JSON.stringify(clean) }, 8000);

    // Keep operational copies in sync for existing Dashboard screens.
    try {
      await request('/users/' + safeKey(uid), { method: 'PUT', body: JSON.stringify(clean) }, 7000);
      if (clean.role === 'sales') {
        await request('/sales/' + safeKey(uid), { method: 'PUT', body: JSON.stringify(clean) }, 7000);
      } else {
        await request('/sales/' + safeKey(uid), { method: 'DELETE' }, 7000).catch(() => null);
      }
    } catch (error) {
      console.warn('Zona360 operational profile sync', error);
      // Authoritative /users profile already exists; operational sync can retry later.
    }
    return clean;
  }

  function getAdminWorkerUrl() {
    const fallback = 'https://frosty-math-534dzona360-admin.hidekenzo10.workers.dev';
    return String(nativeGet.call(localStorage, ADMIN_WORKER_URL_KEY) || fallback).trim().replace(/\/+$/, '');
  }

  function setAdminWorkerUrl(url) {
    const value = String(url || '').trim().replace(/\/+$/, '');
    if (!/^https:\/\/.+/i.test(value)) throw new Error('URL Cloudflare Worker harus diawali https://');
    nativeSet.call(localStorage, ADMIN_WORKER_URL_KEY, value);
    nativeRemove.call(localStorage, ADMIN_WORKER_OK_KEY);
    return value;
  }

  async function callAdminWorker(path, payload, timeoutMs = 15000) {
    const workerUrl = getAdminWorkerUrl();
    if (!workerUrl) throw new Error('Backend Cloudflare belum diatur. Buka Akses Pengguna → Backend Cloudflare.');
    const authState = await getValidAuthState(false);
    if (!authState || !authState.idToken) throw new Error('Session Firebase Admin tidak tersedia. Login ulang.');
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => { try { controller.abort(); } catch (_) {} }, timeoutMs) : null;
    try {
      const response = await fetch(workerUrl + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + authState.idToken },
        body: JSON.stringify(payload || {}),
        ...(controller ? { signal: controller.signal } : {})
      });
      const text = await response.text();
      const data = text ? parseJSON(text, null) : null;
      if (!response.ok || !data || data.ok === false) {
        const message = data && data.message ? data.message : ('Backend Cloudflare HTTP ' + response.status);
        const error = new Error(message);
        error.status = response.status;
        error.code = data && data.code ? data.code : 'WORKER_ERROR';
        throw error;
      }
      return data;
    } catch (error) {
      if (error && error.name === 'AbortError') throw new Error('Backend Cloudflare timeout. Periksa internet/URL Worker.');
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function testAdminWorker(urlOverride) {
    const workerUrl = String(urlOverride || getAdminWorkerUrl() || '').trim().replace(/\/+$/, '');
    if (!workerUrl) throw new Error('Masukkan URL Cloudflare Worker.');
    const response = await fetchJsonWithTimeout(workerUrl + '/health', { method: 'GET' }, 10000);
    if (!response || response.ok !== true) throw new Error('Worker tidak merespons dengan benar.');
    if (response.configured !== true) throw new Error('Worker aktif tetapi secret FIREBASE_SERVICE_ACCOUNT_JSON belum dipasang.');
    nativeSet.call(localStorage, ADMIN_WORKER_OK_KEY, String(Date.now()));
    return response;
  }

  async function createManagedUser(input) {
    const session = getSession();
    if (!session || session.role !== 'admin') throw new Error('Hanya Admin yang dapat menambahkan pengguna.');
    const username = normalizeUsername(input && (input.username || input.email) || '');
    const email = usernameToFirebaseEmail(username);
    const password = String(input && input.password || '');
    const role = String(input && input.role || '').trim().toLowerCase();
    if (role !== 'admin' && role !== 'sales') throw new Error('Role user wajib Admin atau Sales.');
    if (username.length < 3) throw new Error('Username minimal 3 karakter.');
    if (username.length > 32) throw new Error('Username maksimal 32 karakter.');
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(username)) throw new Error('Username hanya boleh huruf kecil, angka, titik, garis bawah, atau tanda minus.');
    if (password.length < 6) throw new Error('Password minimal 6 karakter.');
    const data = await callAdminWorker('/create-user', {
      name: String(input && input.name || '').trim(),
      username, email, password, role,
      phone: String(input && input.phone || '').trim(),
      status: input && input.status === 'inactive' ? 'inactive' : 'active'
    }, 18000);
    const rawProfile = data && data.profile;
    if (!rawProfile || !rawProfile.uid) throw new Error('Backend tidak mengembalikan profile user baru.');
    const profile = { ...rawProfile, username, email, area: '' };

    // Compatibility with an already-deployed Worker: keep username clean in Firebase
    // without touching the authoritative role.
    try {
      await requestUserProfile(profile.uid, {
        method: 'PATCH',
        body: JSON.stringify({ username, email, name: profile.name, phone: profile.phone || '', area: '' })
      }, 8000);
      await request('/users/' + safeKey(profile.uid), { method: 'PATCH', body: JSON.stringify({ username, email, area: '' }) }, 7000).catch(() => null);
      if (profile.role === 'sales') {
        await request('/sales/' + safeKey(profile.uid), { method: 'PATCH', body: JSON.stringify({ username, email, area: '' }) }, 7000).catch(() => null);
      }
    } catch (e) { console.warn('Zona360 username profile sync', e); }

    const db = getDb() || ensureLocalShape({});
    db.users = (db.users || []).filter((u) => u && String(u.id || u.uid || '') !== String(profile.uid) && String(u.email || '').toLowerCase() !== email);
    db.users.unshift(profile);
    if (profile.role === 'sales') {
      db.sales = (db.sales || []).filter((u) => u && String(u.id || u.uid || '') !== String(profile.uid));
      db.sales.unshift(profile);
    }
    writeDbFromExternal(db);
    return profile;
  }

  async function setManagedUserRole(target, nextRole) {
    const session = getSession();
    if (!session || session.role !== 'admin') throw new Error('Hanya Admin yang dapat mengubah role.');
    const role = String(nextRole || '').trim().toLowerCase();
    if (role !== 'admin' && role !== 'sales') throw new Error('Role user wajib Admin atau Sales.');
    const targetUid = String(target && (target.uid || target.id) || '').trim();
    if (!targetUid) throw new Error('UID pengguna tidak tersedia.');
    if (String(session.id || '') === targetUid && role !== 'admin') throw new Error('Admin yang sedang login tidak boleh mengubah dirinya sendiri menjadi Sales.');
    const data = await callAdminWorker('/set-role', { uid: targetUid, role }, 15000);
    const profile = data && data.profile;
    if (!profile) throw new Error('Backend tidak mengembalikan profile setelah perubahan role.');
    const db = getDb() || ensureLocalShape({});
    db.users = (db.users || []).map((u) => String(u && (u.id || u.uid) || '') === targetUid ? profile : u);
    if (profile.role === 'sales') {
      db.sales = (db.sales || []).filter((u) => String(u && (u.id || u.uid) || '') !== targetUid);
      db.sales.unshift(profile);
    } else {
      db.sales = (db.sales || []).filter((u) => String(u && (u.id || u.uid) || '') !== targetUid);
    }
    writeDbFromExternal(db);
    return profile;
  }

  async function resetManagedUserPassword(target, newPassword) {
    const session = getSession();
    if (!session || session.role !== 'admin') throw new Error('Hanya Admin yang dapat reset password.');
    const uid = String(target && (target.uid || target.id) || '').trim();
    const password = String(newPassword || '');
    if (!uid) throw new Error('UID pengguna tidak tersedia.');
    if (password.length < 6) throw new Error('Password baru minimal 6 karakter.');
    const data = await callAdminWorker('/reset-password', { uid, password }, 15000);
    return data && data.result ? data.result : { uid, changed: true };
  }

  async function createAdminUser(input) {
    return createManagedUser({ ...input, role: 'admin' });
  }

  async function createSalesUser(input) {
    return createManagedUser({ ...input, role: 'sales' });
  }

  async function sendPasswordResetEmail(email) {
    const session = getSession();
    if (!session || session.role !== 'admin') throw new Error('Hanya Admin yang dapat mengirim reset password.');
    const targetEmail = String(email || '').trim().toLowerCase();
    if (!targetEmail || !targetEmail.includes('@')) throw new Error('Email pengguna tidak valid.');
    const url = 'https://identitytoolkit.googleapis.com/v1/accounts:sendOobCode?key=' + encodeURIComponent(CONFIG.apiKey);
    try {
      const response = await fetchJsonWithTimeout(url, {
        method: 'POST',
        body: JSON.stringify({ requestType: 'PASSWORD_RESET', email: targetEmail })
      }, 9000);
      return { email: String(response && response.email || targetEmail) };
    } catch (error) {
      throw firebaseAuthError(error, 'Gagal mengirim reset password Firebase.');
    }
  }

  function closeResetPasswordModal() {
    const old = document.getElementById('z360-reset-password-modal');
    if (old) old.remove();
  }

  function localManagedUsers() {
    const db = getDb() || ensureLocalShape({});
    return (Array.isArray(db.users) ? db.users : [])
      .filter((u) => u && (u.uid || u.id))
      .map((u) => {
        const email = String(u.email || '').trim().toLowerCase();
        const username = displayUsername(u, email);
        return {
          uid: String(u.uid || u.id || ''),
          id: String(u.id || u.uid || ''),
          name: String(u.name || username || 'Pengguna'),
          email,
          username,
          role: String(u.role || '')
        };
      })
      .filter((u, i, a) => u.uid && a.findIndex((x) => x.uid === u.uid) === i)
      .sort((a,b) => a.name.localeCompare(b.name));
  }

  function openResetPasswordModal() {
    closeResetPasswordModal();
    const users = localManagedUsers();
    const esc = (v) => String(v || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    const options = users.length
      ? users.map((u, i) => '<option value="' + i + '">' + esc(u.name + ' · @' + u.username + (u.role ? ' · ' + u.role : '')) + '</option>').join('')
      : '<option value="">Tidak ada user Firebase tersimpan</option>';
    const overlay = document.createElement('div');
    overlay.id = 'z360-reset-password-modal';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483000;background:rgba(6,18,24,.62);display:flex;align-items:center;justify-content:center;padding:18px;overflow:auto';
    overlay.innerHTML = `
      <div style="width:min(520px,100%);background:#fff;border-radius:14px;padding:20px;box-shadow:0 24px 80px rgba(0,0,0,.28);font-family:inherit;color:#16242b">
        <div style="display:flex;justify-content:space-between;gap:12px;align-items:flex-start;margin-bottom:16px">
          <div><div style="font-size:18px;font-weight:800">Reset Password Langsung</div><div style="font-size:12px;color:#6d777b;margin-top:4px">Password diubah melalui Cloudflare Worker + Firebase Admin API. Password tidak disimpan di Realtime Database.</div></div>
          <button id="z360-rp-close" type="button" style="border:0;background:#f1f3f2;border-radius:8px;padding:7px 10px;font-weight:800">✕</button>
        </div>
        <label style="font-size:11px;font-weight:800">PILIH AKUN
          <select id="z360-rp-user" style="display:block;width:100%;box-sizing:border-box;margin-top:6px;padding:11px;border:1px solid #d9dfdc;border-radius:8px;font:inherit;background:#fff">${options}</select>
        </label>
        <label style="display:block;font-size:11px;font-weight:800;margin-top:13px">PASSWORD BARU
          <input id="z360-rp-pass" type="password" autocomplete="new-password" placeholder="Minimal 6 karakter" style="display:block;width:100%;box-sizing:border-box;margin-top:6px;padding:11px;border:1px solid #d9dfdc;border-radius:8px;font:inherit">
        </label>
        <label style="display:block;font-size:11px;font-weight:800;margin-top:13px">ULANGI PASSWORD BARU
          <input id="z360-rp-pass2" type="password" autocomplete="new-password" placeholder="Ketik ulang password" style="display:block;width:100%;box-sizing:border-box;margin-top:6px;padding:11px;border:1px solid #d9dfdc;border-radius:8px;font:inherit">
        </label>
        <div id="z360-rp-msg" style="display:none;margin-top:12px;padding:10px;border-radius:8px;font-size:12px"></div>
        <div style="display:flex;justify-content:flex-end;gap:9px;margin-top:16px">
          <button id="z360-rp-cancel" type="button" style="padding:10px 15px;border:1px solid #cad3cf;background:#fff;border-radius:8px;font-weight:800">Batal</button>
          <button id="z360-rp-send" type="button" style="padding:10px 15px;border:0;background:#ff6938;color:#fff;border-radius:8px;font-weight:800">Ubah Password</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    const select = overlay.querySelector('#z360-rp-user');
    const msg = overlay.querySelector('#z360-rp-msg');
    const setMsg = (text, ok) => { msg.style.display='block'; msg.style.background=ok?'#e9f7ef':'#fff0ed'; msg.style.color=ok?'#19764a':'#b73d26'; msg.textContent=text; };
    overlay.querySelector('#z360-rp-close').onclick = closeResetPasswordModal;
    overlay.querySelector('#z360-rp-cancel').onclick = closeResetPasswordModal;
    overlay.addEventListener('click', (e) => { if (e.target === overlay) closeResetPasswordModal(); });
    overlay.querySelector('#z360-rp-send').onclick = async () => {
      const btn = overlay.querySelector('#z360-rp-send');
      const idx = Number(select && select.value);
      const target = Number.isInteger(idx) ? users[idx] : null;
      const pass = String(overlay.querySelector('#z360-rp-pass').value || '');
      const pass2 = String(overlay.querySelector('#z360-rp-pass2').value || '');
      if (!target) return setMsg('Pilih akun Firebase yang akan direset.', false);
      if (pass.length < 6) return setMsg('Password baru minimal 6 karakter.', false);
      if (pass !== pass2) return setMsg('Konfirmasi password tidak sama.', false);
      btn.disabled = true; btn.textContent = 'Mengubah...';
      try {
        await resetManagedUserPassword(target, pass);
        setMsg('Password @' + target.username + ' berhasil diubah. User dapat login dengan password baru.', true);
        btn.textContent = 'Berhasil';
      } catch (e) {
        setMsg(e && e.message ? e.message : 'Gagal mengubah password.', false);
        btn.disabled = false; btn.textContent = 'Ubah Password';
      }
    };
  }

  function closeAdminCreateModal() {
    const old = document.getElementById('z360-add-user-modal');
    if (old) old.remove();
  }

  function openAdminCreateModal() {
    closeAdminCreateModal();
    const overlay = document.createElement('div');
    overlay.id = 'z360-add-user-modal';
    overlay.className = 'z360-modal-overlay';
    overlay.innerHTML = `
      <div class="z360-modal-card">
        <div class="z360-modal-head">
          <div>
            <div class="z360-modal-kicker">USER MANAGEMENT</div>
            <div class="z360-modal-title">Tambah User</div>
            <div class="z360-modal-sub">Buat satu akun baru, lalu pilih role Admin atau Sales. Username digunakan saat login tanpa perlu mengetik @.</div>
          </div>
          <button id="z360-au-close" type="button" class="z360-icon-btn">✕</button>
        </div>
        <div class="z360-form-grid">
          <label class="z360-field z360-span-2">NAMA LENGKAP
            <input id="z360-au-name" autocomplete="name" placeholder="Contoh: Raka Pratama">
          </label>
          <label class="z360-field">USERNAME
            <div class="z360-username-wrap"><span>@</span><input id="z360-au-username" autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="raka.pratama"></div>
          </label>
          <label class="z360-field">ROLE USER
            <select id="z360-au-role"><option value="sales">Sales</option><option value="admin">Admin</option></select>
          </label>
          <label class="z360-field">PASSWORD
            <input id="z360-au-pass" type="password" autocomplete="new-password" placeholder="Minimal 6 karakter">
          </label>
          <label class="z360-field">NO. TELEPON
            <input id="z360-au-phone" inputmode="tel" autocomplete="tel" placeholder="08xxxxxxxxxx">
          </label>
        </div>
        <div class="z360-helper">Firebase tetap memakai alamat internal <b>username@zona360.app</b>. User cukup mengingat username + password.</div>
        <div id="z360-au-msg" class="z360-modal-msg" hidden></div>
        <div class="z360-modal-actions">
          <button id="z360-au-cancel" type="button" class="btn outline">Batal</button>
          <button id="z360-au-save" type="button" class="btn orange">Simpan User</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    const msg = overlay.querySelector('#z360-au-msg');
    const setMsg=(text,ok)=>{
      msg.hidden=false;
      msg.dataset.ok=ok?'1':'0';
      msg.textContent=text;
    };
    overlay.querySelector('#z360-au-close').onclick=closeAdminCreateModal;
    overlay.querySelector('#z360-au-cancel').onclick=closeAdminCreateModal;
    overlay.addEventListener('click',(e)=>{if(e.target===overlay)closeAdminCreateModal();});

    const userInput=overlay.querySelector('#z360-au-username');
    userInput.addEventListener('input',()=>{
      const cleaned=normalizeUsername(userInput.value);
      if(userInput.value!==cleaned) userInput.value=cleaned;
    });

    overlay.querySelector('#z360-au-save').onclick=async()=>{
      const btn=overlay.querySelector('#z360-au-save');
      const input={
        name:String(overlay.querySelector('#z360-au-name').value||'').trim(),
        username:normalizeUsername(overlay.querySelector('#z360-au-username').value),
        password:String(overlay.querySelector('#z360-au-pass').value||''),
        phone:String(overlay.querySelector('#z360-au-phone').value||'').trim(),
        role:String(overlay.querySelector('#z360-au-role').value||'sales').toLowerCase(),
        status:'active'
      };
      if(!input.name)return setMsg('Nama lengkap wajib diisi.',false);
      if(input.username.length<3)return setMsg('Username minimal 3 karakter.',false);
      if(!/^[a-z0-9][a-z0-9._-]*$/.test(input.username))return setMsg('Username hanya boleh huruf kecil, angka, titik, garis bawah, atau tanda minus.',false);
      if(input.password.length<6)return setMsg('Password minimal 6 karakter.',false);
      btn.disabled=true;btn.textContent='Menyimpan...';
      try{
        const profile=await createManagedUser(input);
        setMsg('User @'+displayUsername(profile,profile.email)+' berhasil dibuat sebagai '+(profile.role==='admin'?'Admin':'Sales')+'.',true);
        btn.textContent='Berhasil ✓';
        setTimeout(closeAdminCreateModal,1100);
      }catch(e){
        setMsg(e&&e.message?e.message:'Gagal membuat user.',false);
        btn.disabled=false;btn.textContent='Simpan User';
      }
    };
  }

  function closeWorkerConfigModal() {
    const old = document.getElementById('z360-worker-config-modal');
    if (old) old.remove();
  }

  function openWorkerConfigModal() {
    closeWorkerConfigModal();
    const overlay = document.createElement('div');
    overlay.id = 'z360-worker-config-modal';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483000;background:rgba(6,18,24,.62);display:flex;align-items:center;justify-content:center;padding:18px;overflow:auto';
    overlay.innerHTML = `
      <div style="width:min(560px,100%);background:#fff;border-radius:14px;padding:20px;box-shadow:0 24px 80px rgba(0,0,0,.28);font-family:inherit;color:#16242b">
        <div style="display:flex;justify-content:space-between;gap:12px;align-items:flex-start;margin-bottom:16px"><div><div style="font-size:18px;font-weight:800">Backend Cloudflare</div><div style="font-size:12px;color:#6d777b;margin-top:4px">Masukkan URL Worker gratis. Contoh: https://zona360-admin.nama.workers.dev</div></div><button id="z360-wc-close" type="button" style="border:0;background:#f1f3f2;border-radius:8px;padding:7px 10px;font-weight:800">✕</button></div>
        <label style="display:block;font-size:11px;font-weight:800">URL CLOUDFLARE WORKER<input id="z360-wc-url" type="url" autocapitalize="none" autocomplete="off" value="${String(getAdminWorkerUrl()).replace(/"/g,'&quot;')}" placeholder="https://zona360-admin....workers.dev" style="display:block;width:100%;box-sizing:border-box;margin-top:6px;padding:11px;border:1px solid #d9dfdc;border-radius:8px;font:inherit"></label>
        <div id="z360-wc-msg" style="margin-top:12px;padding:10px;border-radius:8px;font-size:12px;background:#f3f6f5;color:#536166">URL disimpan hanya di perangkat ini. Service account TIDAK disimpan di APK.</div>
        <div style="display:flex;justify-content:flex-end;gap:9px;margin-top:16px"><button id="z360-wc-cancel" type="button" style="padding:10px 15px;border:1px solid #cad3cf;background:#fff;border-radius:8px;font-weight:800">Batal</button><button id="z360-wc-save" type="button" style="padding:10px 15px;border:0;background:#ff6938;color:#fff;border-radius:8px;font-weight:800">Simpan & Tes</button></div>
      </div>`;
    document.body.appendChild(overlay);
    const msg = overlay.querySelector('#z360-wc-msg');
    const setMsg=(text,ok)=>{msg.style.background=ok?'#e9f7ef':'#fff0ed';msg.style.color=ok?'#19764a':'#b73d26';msg.textContent=text;};
    overlay.querySelector('#z360-wc-close').onclick=closeWorkerConfigModal;
    overlay.querySelector('#z360-wc-cancel').onclick=closeWorkerConfigModal;
    overlay.addEventListener('click',(e)=>{if(e.target===overlay)closeWorkerConfigModal();});
    overlay.querySelector('#z360-wc-save').onclick=async()=>{
      const btn=overlay.querySelector('#z360-wc-save');
      try{
        const url=setAdminWorkerUrl(overlay.querySelector('#z360-wc-url').value);
        btn.disabled=true;btn.textContent='Mengetes...';
        await testAdminWorker(url);
        setMsg('Backend terhubung dan service account siap.',true);
        btn.textContent='Terhubung ✓';
      }catch(e){setMsg(e&&e.message?e.message:'Gagal terhubung ke Worker.',false);btn.disabled=false;btn.textContent='Simpan & Tes';}
    };
  }

  function ensureWorkerConfigUi() {
    const session=getSession();
    const heading=[...document.querySelectorAll('h2')].find(h=>String(h.textContent||'').trim().toLowerCase()==='akses pengguna');
    const old=document.getElementById('z360-worker-config');
    if(!session||session.role!=='admin'||!heading){if(old)old.remove();return;}
    const toolbar=heading.closest('.section-heading')&&heading.closest('.section-heading').querySelector('.toolbar');
    if(!toolbar||(old&&old.isConnected))return;
    const btn=document.createElement('button');btn.id='z360-worker-config';btn.type='button';btn.className='btn outline';
    btn.textContent=nativeGet.call(localStorage,ADMIN_WORKER_OK_KEY)?'Backend Cloudflare ✓':'Backend Cloudflare';
    btn.addEventListener('click',openWorkerConfigModal);toolbar.appendChild(btn);
  }

  function ensureResetPasswordUi() {
    const session = getSession();
    const heading = [...document.querySelectorAll('h2')].find((h) => String(h.textContent || '').trim().toLowerCase() === 'akses pengguna');
    const old = document.getElementById('z360-reset-password');
    if (!session || session.role !== 'admin' || !heading) { if (old) old.remove(); return; }
    const sectionHeading = heading.closest('.section-heading');
    const toolbar = sectionHeading && sectionHeading.querySelector('.toolbar');
    if (!toolbar || (old && old.isConnected)) return;
    const btn = document.createElement('button');
    btn.id = 'z360-reset-password'; btn.type = 'button'; btn.className = 'btn outline'; btn.textContent = 'Reset Password';
    btn.addEventListener('click', openResetPasswordModal); toolbar.appendChild(btn);
  }

  function ensureAdminCreateUi() {
    const session=getSession();
    const heading=[...document.querySelectorAll('h2')].find(h=>String(h.textContent||'').trim().toLowerCase()==='akses pengguna');
    const old=document.getElementById('z360-add-user');
    if(!session||session.role!=='admin'||!heading){if(old)old.remove();return;}
    const section=heading.closest('.section-heading');
    const toolbar=section&&section.querySelector('.toolbar');
    if(!toolbar)return;

    // The old React "Tambah Sales" and old standalone "Tambah Admin" controls are
    // intentionally hidden. One authoritative flow prevents role drift.
    toolbar.querySelectorAll('button').forEach((button)=>{
      const text=String(button.textContent||'').trim().toLowerCase();
      if((text.includes('tambah sales')||text.includes('tambah admin')) && button.id!=='z360-add-user'){
        button.style.display='none';
        button.setAttribute('aria-hidden','true');
      }
    });
    const oldAdmin=document.getElementById('z360-add-admin');
    if(oldAdmin)oldAdmin.remove();

    if(!old||!old.isConnected){
      const btn=document.createElement('button');
      btn.id='z360-add-user';
      btn.type='button';
      btn.className='btn orange';
      btn.textContent='+ Tambah User';
      btn.addEventListener('click',openAdminCreateModal);
      toolbar.insertBefore(btn,toolbar.firstChild);
    }

    const content=heading.closest('.content')||document;
    // Remove the duplicate role selector. Role is authoritative in /users/{uid}
    // and selected only during Add User (or secure backend operations).
    content.querySelectorAll('.field').forEach((field)=>{
      const label=field.querySelector(':scope > label');
      if(label && String(label.textContent||'').trim().toUpperCase()==='ROLE USER'){
        field.style.display='none';
        field.dataset.z360RoleHidden='1';
      }
    });
    content.querySelectorAll('.card-sub').forEach((el)=>{
      if(String(el.textContent||'').includes('localStorage')) el.textContent='Permission tersimpan dan role dikunci oleh Firebase.';
    });

    // Existing profiles created before Username mode may still store username=email.
    content.querySelectorAll('.activity p').forEach((el)=>{
      const t=String(el.textContent||'');
      const match=t.match(/^([^·]+)\s*·\s*([^\s]+@zona360\.app)$/i);
      if(match) el.textContent=match[1].trim()+' · @'+match[2].split('@')[0];
    });
  }

  let profileSyncTimer = null;
  function scheduleProfileSync(db) {
    const session = getSession();
    if (!session || session.role !== 'admin') return;
    clearTimeout(profileSyncTimer);
    profileSyncTimer = setTimeout(async () => {
      const current = getDb() || db;
      const users = Array.isArray(current && current.users) ? current.users : [];
      for (const user of users) {
        if (!user || !user.id || !String(user.email || user.username || '').includes('@')) continue;
        try {
          // /users/{uid}.role is authoritative. Read it first and keep it unchanged.
          const authoritative = await requestUserProfile(user.id, { method: 'GET' }, 5000);
          if (!authoritative || !['admin','sales'].includes(String(authoritative.role || '').toLowerCase())) continue;
          const clean = { ...user, role: String(authoritative.role).toLowerCase() };
          if (clean.role === 'admin') {
            clean.permissions = ADMIN_PERMISSIONS.slice();
            clean.dashboard = ADMIN_DASHBOARD.slice();
          }
          delete clean.password;
          delete clean.passwordHash;
          await requestUserProfile(user.id, { method: 'PATCH', body: JSON.stringify(clean) }, 5000);
        } catch (e) { console.warn('Zona360 profile sync', user.id, e); }
      }
    }, 700);
  }

  async function startTracking() {
    const session = getSession();
    if (!session || session.role !== 'sales') return;
    if (watchId !== null && trackedUserId === session.id) return;

    nativeSet.call(localStorage, 'zona360_tracking_' + session.id, '1');
    trackedUserId = session.id;
    firstTrackPoint = true;
    lastPointSavedAt = 0;
    lastLiveWriteAt = 0;
    lastPoint = null;
    lastAcceptedPoint = null;
    lastAcceptedPointAt = 0;
    updateTrackingUiState('starting');

    try {
      const capacitorGeo = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Geolocation;
      if (capacitorGeo && typeof capacitorGeo.watchPosition === 'function') {
        try {
          if (typeof capacitorGeo.checkPermissions === 'function') {
            const permission = await capacitorGeo.checkPermissions();
            if (!permission || (permission.location !== 'granted' && permission.coarseLocation !== 'granted')) {
              if (typeof capacitorGeo.requestPermissions === 'function') await capacitorGeo.requestPermissions();
            }
          }
        } catch (_) {}
        watchMode = 'capacitor';
        watchId = await capacitorGeo.watchPosition({ enableHighAccuracy: true, timeout: 15000, maximumAge: 1000 }, (position, error) => {
          if (error) {
            updateTrackingUiState('error', null, 'GPS gagal: ' + (error.message || 'periksa izin lokasi'));
            return;
          }
          handlePosition(position);
        });
        return;
      }

      if (!navigator.geolocation) throw new Error('GPS tidak tersedia di perangkat');
      watchMode = 'browser';
      watchId = navigator.geolocation.watchPosition(
        handlePosition,
        (error) => updateTrackingUiState('error', null, 'GPS gagal: ' + (error.message || 'periksa izin lokasi')),
        { enableHighAccuracy: true, timeout: 15000, maximumAge: 1000 }
      );
    } catch (error) {
      watchId = null;
      watchMode = null;
      nativeRemove.call(localStorage, 'zona360_tracking_' + session.id);
      updateTrackingUiState('error', null, 'Tracking gagal dimulai. Aktifkan GPS dan izin lokasi.');
    }
  }

  async function stopTracking(reason) {
    const session = getSession() || (trackedUserId ? { id: trackedUserId, role: 'sales', name: 'Sales' } : null);
    try {
      if (watchId !== null) {
        if (watchMode === 'capacitor' && window.Capacitor?.Plugins?.Geolocation?.clearWatch) {
          await window.Capacitor.Plugins.Geolocation.clearWatch({ id: String(watchId) });
        } else if (watchMode === 'browser' && navigator.geolocation) {
          navigator.geolocation.clearWatch(watchId);
        }
      }
    } catch (_) {}

    watchId = null;
    watchMode = null;
    if (session && session.id) nativeRemove.call(localStorage, 'zona360_tracking_' + session.id);

    if (session && session.id) {
      const db = getDb();
      if (db) {
        const user = (db.users || []).find((u) => u.id === session.id) || session;
        const loc = user.lastLocation && Number.isFinite(Number(user.lastLocation.lat)) ? {
          lat: Number(user.lastLocation.lat),
          lng: Number(user.lastLocation.lng),
          accuracy: Number(user.lastLocation.accuracy || 0)
        } : null;
        updateUserTracking(db, session, loc, 'inactive');
        if (reason !== 'logout') appendTrackingActivity(db, session, 'Selesai kerja', loc, { reason: reason || 'manual' });
        writeDbFromExternal(db);
      }
    }
    trackedUserId = null;
    updateTrackingUiState('inactive');
  }

  function trackingIsRequested(session) {
    return !!(session && session.id && nativeGet.call(localStorage, 'zona360_tracking_' + session.id) === '1');
  }

  function updateTrackingUiState(state, point, message) {
    const box = document.getElementById('z360-live-track-state');
    const start = document.getElementById('z360-start-work');
    const stop = document.getElementById('z360-stop-work');
    if (box) {
      if (state === 'active' && point) {
        box.textContent = 'GPS realtime aktif · ' + point.lat.toFixed(5) + ', ' + point.lng.toFixed(5) + ' · ±' + Math.round(point.accuracy || 0) + ' m';
        box.dataset.state = 'online';
      } else if (state === 'starting') {
        box.textContent = 'Mengaktifkan GPS realtime…';
        box.dataset.state = 'syncing';
      } else if (state === 'error') {
        box.textContent = message || 'GPS bermasalah';
        box.dataset.state = 'error';
      } else {
        if (box.textContent !== 'Tracking belum aktif') box.textContent = 'Tracking belum aktif';
        if (box.dataset.state !== 'offline') box.dataset.state = 'offline';
      }
    }
    const active = state === 'active' || state === 'starting' || watchId !== null;
    if (start) start.disabled = active;
    if (stop) stop.disabled = !active;
  }

  function ensureStyles() {
    if (document.getElementById('z360-cloud-style')) return;
    const style = document.createElement('style');
    style.id = 'z360-cloud-style';
    style.textContent = `
      #z360-cloud-badge{position:fixed;right:12px;bottom:76px;z-index:9998;padding:7px 10px;border-radius:999px;font:600 10px/1.2 system-ui,-apple-system,Segoe UI,sans-serif;box-shadow:0 2px 12px rgba(0,0,0,.14);border:1px solid rgba(0,0,0,.08);background:#fff;color:#23323b;max-width:220px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      #z360-cloud-badge[data-state="online"]{background:#e9f8f3;color:#087a65}#z360-cloud-badge[data-state="syncing"],#z360-cloud-badge[data-state="connecting"]{background:#fff3e8;color:#b75621}#z360-cloud-badge[data-state="offline"],#z360-cloud-badge[data-state="blocked"]{background:#fff0f0;color:#b33838}
      .z360-live-track{margin-top:14px;padding:12px;border:1px solid rgba(255,255,255,.14);border-radius:10px;background:rgba(255,255,255,.07)}
      .z360-live-track-title{font-size:11px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:#fff;margin-bottom:7px}.z360-live-track-actions{display:flex;gap:8px;flex-wrap:wrap}.z360-live-track button{border:0;border-radius:8px;padding:9px 13px;font-size:12px;font-weight:800;cursor:pointer}.z360-live-track button:disabled{opacity:.45;cursor:not-allowed}#z360-start-work{background:#14b88a;color:#fff}#z360-stop-work{background:#fff;color:#ca4f2d}#z360-live-track-state{margin-top:8px;font-size:11px;color:#d9e4e9}#z360-live-track-state[data-state="online"]{color:#74efc8}#z360-live-track-state[data-state="error"]{color:#ffb0a7}
    `;
    document.head.appendChild(style);
  }

  function updateCloudBadge() {
    if (!document.body) return;
    const session = getSession();
    let existingBadge = document.getElementById('z360-cloud-badge');
    if (!session) { if (existingBadge) existingBadge.remove(); return; }
    ensureStyles();
    let badge = document.getElementById('z360-cloud-badge');
    if (!badge) {
      badge = document.createElement('div');
      badge.id = 'z360-cloud-badge';
      badge.title = 'Status sinkronisasi Zona360 ke Firebase';
      document.body.appendChild(badge);
    }
    badge.style.pointerEvents = 'none';
    badge.style.display = document.querySelector('.mobile-drawer.open') ? 'none' : '';
    if (badge.dataset.state !== cloudState) badge.dataset.state = cloudState;
    if (badge.textContent !== cloudMessage) badge.textContent = cloudMessage;
  }

  function hideSalesBypassControls() {
    const session = getSession();
    if (!session || session.role !== 'sales') return;
    document.querySelectorAll('input').forEach((input) => {
      const placeholder = String(input.getAttribute('placeholder') || '').toLowerCase();
      if (placeholder.includes('barcode manual')) {
        const toolbar = input.closest('.toolbar');
        if (toolbar) toolbar.style.display = 'none';
        else input.style.display = 'none';
      }
    });
    document.querySelectorAll('button').forEach((button) => {
      const text = String(button.textContent || '').trim().toLowerCase();
      if (text.includes('simulasikan hasil scan') || text === 'check-in + gps') {
        button.style.display = 'none';
      }
    });
  }

  function ensureTrackingUi() {
    if (!document.body) return;
    updateCloudBadge();
    const session = getSession();
    const existing = document.querySelector('.z360-live-track');
    if (!session || session.role !== 'sales') {
      if (existing) existing.remove();
      return;
    }
    hideSalesBypassControls();
    const hero = document.querySelector('.scan-hero');
    if (!hero) return;
    if (!existing) {
      const card = document.createElement('div');
      card.className = 'z360-live-track';
      card.innerHTML = '<div class="z360-live-track-title">GPS SALES REALTIME</div><div class="z360-live-track-actions"><button id="z360-start-work" type="button">Mulai Kerja</button><button id="z360-stop-work" type="button">Selesai Kerja</button></div><div id="z360-live-track-state" data-state="offline">Tracking belum aktif</div>';
      hero.appendChild(card);
      card.querySelector('#z360-start-work').addEventListener('click', startTracking);
      card.querySelector('#z360-stop-work').addEventListener('click', () => stopTracking('manual'));
    }
    if (watchId !== null) updateTrackingUiState('active', lastPoint || null);
    else if (trackingIsRequested(session)) updateTrackingUiState('starting');
    else updateTrackingUiState('inactive');
  }

  let advancedMap = null;
  let advancedRenderKey = '';
  let advancedFitKey = '';
  let leafletPromise = null;
  const advancedSalesMarkers = new Map();
  const advancedRouteLines = new Map();
  const advancedVisitMarkers = new Map();

  function loadLeafletAsync() {
    if (window.L) return Promise.resolve(window.L);
    if (leafletPromise) return leafletPromise;
    leafletPromise = new Promise((resolve, reject) => {
      if (!document.getElementById('z360-leaflet-css')) {
        const link = document.createElement('link');
        link.id = 'z360-leaflet-css'; link.rel = 'stylesheet';
        link.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
        document.head.appendChild(link);
      }
      const old = document.getElementById('z360-leaflet-js');
      if (old) {
        if (window.L) return resolve(window.L);
        old.addEventListener('load', () => resolve(window.L), { once:true });
        old.addEventListener('error', reject, { once:true });
        return;
      }
      const script = document.createElement('script');
      script.id = 'z360-leaflet-js'; script.async = true;
      script.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
      script.onload = () => window.L ? resolve(window.L) : reject(new Error('Leaflet tidak tersedia'));
      script.onerror = () => reject(new Error('Library Maps gagal dimuat'));
      document.head.appendChild(script);
    });
    return leafletPromise;
  }

  function localDateKey(value) {
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return '';
    return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
  }

  function todayLocalKey(offsetDays = 0) {
    const d = new Date(); d.setDate(d.getDate()+offsetDays);
    return localDateKey(d);
  }

  function monitoringSelectedData() {
    const db = getDb() || ensureLocalShape({});
    const root = document.getElementById('z360-advanced-monitor');
    const salesId = root && root.querySelector('#z360-mon-sales') ? root.querySelector('#z360-mon-sales').value : 'all';
    const start = root && root.querySelector('#z360-mon-start') ? root.querySelector('#z360-mon-start').value : todayLocalKey(-6);
    const end = root && root.querySelector('#z360-mon-end') ? root.querySelector('#z360-mon-end').value : todayLocalKey(0);
    const accept = (r) => {
      if (!r) return false;
      if (salesId !== 'all' && String(r.userId || r.salesId || '') !== salesId) return false;
      const k = localDateKey(r.timestamp || r.createdAt);
      return (!start || k >= start) && (!end || k <= end);
    };
    const points = (db.gpsHistory || []).filter(accept).filter(p => Number.isFinite(Number(p.lat)) && Number.isFinite(Number(p.lng)));
    const activities = (db.activities || []).filter(accept).filter(p => Number.isFinite(Number(p.lat)) && Number.isFinite(Number(p.lng)));
    const liveSales = (db.sales || []).filter((sale)=>{
      if(!sale)return false;
      if(salesId!=='all' && String(sale.id||sale.uid||'')!==salesId)return false;
      const loc=sale.lastLocation;
      return loc && Number.isFinite(Number(loc.lat)) && Number.isFinite(Number(loc.lng));
    });
    return { db, salesId, start, end, points, activities, liveSales };
  }

  function routeDistance(points) {
    let meters = 0;
    const sorted = [...points].sort((a,b)=>new Date(a.timestamp)-new Date(b.timestamp));
    for (let i=1;i<sorted.length;i++) {
      const a={lat:Number(sorted[i-1].lat),lng:Number(sorted[i-1].lng)};
      const b={lat:Number(sorted[i].lat),lng:Number(sorted[i].lng)};
      const d=distanceMeters(a,b);
      // Ignore impossible GPS teleports in route totals.
      if(Number.isFinite(d) && d < 5000) meters += d;
    }
    return meters;
  }

  function htmlEscape(value) {
    return String(value == null ? '' : value)
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function salesInitials(name) {
    return String(name||'S').trim().split(/\s+/).slice(0,2).map(x=>x[0]||'').join('').toUpperCase() || 'S';
  }

  function routeColorFor(id) {
    const palette=['#1f9d8a','#ef7042','#3b7fa1','#7d67b2','#b37a32','#3d8a5e'];
    let h=0; for(const c of String(id||''))h=(h*31+c.charCodeAt(0))>>>0;
    return palette[h%palette.length];
  }

  function animateLeafletMarker(marker, target, duration=1100) {
    if(!marker || !target)return;
    const start=marker.getLatLng();
    const end={lat:Number(target[0]),lng:Number(target[1])};
    if(!Number.isFinite(end.lat)||!Number.isFinite(end.lng))return;
    const delta=Math.abs(start.lat-end.lat)+Math.abs(start.lng-end.lng);
    if(delta<0.000001)return;
    if(marker.__z360Anim)cancelAnimationFrame(marker.__z360Anim);
    const t0=performance.now();
    const step=(now)=>{
      const p=Math.min(1,(now-t0)/duration);
      const eased=1-Math.pow(1-p,3);
      marker.setLatLng([start.lat+(end.lat-start.lat)*eased,start.lng+(end.lng-start.lng)*eased]);
      if(p<1)marker.__z360Anim=requestAnimationFrame(step);
    };
    marker.__z360Anim=requestAnimationFrame(step);
  }

  function removeMissingLayers(map, keep, remover) {
    for(const [id,layer] of map.entries()){
      if(keep.has(id))continue;
      try{remover(layer)}catch(_){}
      map.delete(id);
    }
  }

  async function renderAdvancedMonitoring(forceFit=false) {
    const root = document.getElementById('z360-advanced-monitor');
    if (!root) return;
    const data = monitoringSelectedData();
    const liveStamp=data.liveSales.map(s=>String(s.id||s.uid)+'@'+String(s.lastLocation&&s.lastLocation.timestamp||s.lastSeen||'')).join('|');
    const key = JSON.stringify([
      data.salesId,data.start,data.end,data.points.length,data.activities.length,
      (data.points[0]||{}).timestamp,(data.activities[0]||{}).timestamp,liveStamp
    ]);
    if (advancedRenderKey === key && !forceFit) return;
    advancedRenderKey = key;

    const routeMeters = routeDistance(data.points);
    const visitedActs=data.activities.filter(a=>{
      const action=String(a.action||'').toLowerCase();
      return !!a.storeId && (action.includes('scan')||action.includes('check-in'));
    });
    const visitedStoreIds=new Set(visitedActs.map(a=>String(a.storeId)));
    const stats=root.querySelector('#z360-mon-stats');
    if(stats){
      stats.innerHTML=
        '<span class="z360-stat-chip">'+data.liveSales.length+' Sales terpantau</span>'+
        '<span class="z360-stat-chip">'+data.points.length+' titik GPS</span>'+
        '<span class="z360-stat-chip">'+visitedStoreIds.size+' toko dikunjungi</span>'+
        '<span class="z360-stat-chip">Rute ±'+(routeMeters/1000).toFixed(2)+' km</span>';
    }

    const fallback = root.querySelector('#z360-mon-fallback');
    try {
      const L = await loadLeafletAsync();
      const mapEl = root.querySelector('#z360-route-map');
      if (!mapEl || !document.body.contains(mapEl)) return;
      if (!advancedMap) {
        advancedMap = L.map(mapEl,{
          zoomControl:true,attributionControl:true,zoomAnimation:true,fadeAnimation:true,
          markerZoomAnimation:true,preferCanvas:true
        }).setView([-.902,119.871],12);
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{
          maxZoom:19,attribution:'© OpenStreetMap contributors',updateWhenIdle:true
        }).addTo(advancedMap);
      }

      const bounds=[];
      const pointGroups=new Map();
      data.points.forEach(p=>{
        const id=String(p.userId||'unknown');
        if(!pointGroups.has(id))pointGroups.set(id,[]);
        pointGroups.get(id).push(p);
      });

      // Route history: update the existing polyline instead of recreating the map.
      const keepRoutes=new Set();
      pointGroups.forEach((arr,id)=>{
        arr.sort((a,b)=>new Date(a.timestamp)-new Date(b.timestamp));
        const latlngs=[];
        let prev=null;
        arr.forEach(p=>{
          const ll=[Number(p.lat),Number(p.lng)];
          if(!Number.isFinite(ll[0])||!Number.isFinite(ll[1]))return;
          if(prev && distanceMeters({lat:prev[0],lng:prev[1]},{lat:ll[0],lng:ll[1]})>5000)return;
          latlngs.push(ll); prev=ll; bounds.push(ll);
        });
        if(!latlngs.length)return;
        keepRoutes.add(id);
        let line=advancedRouteLines.get(id);
        if(!line){
          line=L.polyline(latlngs,{weight:5,opacity:.82,color:routeColorFor(id),lineCap:'round',lineJoin:'round'}).addTo(advancedMap);
          advancedRouteLines.set(id,line);
        }else line.setLatLngs(latlngs);
      });
      removeMissingLayers(advancedRouteLines,keepRoutes,(line)=>advancedMap.removeLayer(line));

      // Visited stores stay visible as history for the selected date range.
      const visitGroups=new Map();
      visitedActs.forEach(a=>{
        const id=String(a.storeId);
        if(!visitGroups.has(id))visitGroups.set(id,[]);
        visitGroups.get(id).push(a);
      });
      const keepVisits=new Set();
      visitGroups.forEach((arr,storeId)=>{
        arr.sort((a,b)=>new Date(b.timestamp)-new Date(a.timestamp));
        const latest=arr[0];
        const store=(data.db.stores||[]).find(x=>String(x.id)===storeId);
        const slat=Number(store&&(store.lat??store.latitude));
        const slng=Number(store&&(store.lng??store.longitude));
        const lat=Number.isFinite(slat)?slat:Number(latest.lat);
        const lng=Number.isFinite(slng)?slng:Number(latest.lng);
        if(!Number.isFinite(lat)||!Number.isFinite(lng))return;
        const id='store:'+storeId; keepVisits.add(id); bounds.push([lat,lng]);
        const salesNames=[...new Set(arr.map(x=>String(x.userName||'Sales')))].join(', ');
        const popup='<b>'+htmlEscape(store&&store.name||latest.storeName||'Toko')+'</b><br>'+
          '<span style="color:#18815d;font-weight:800">✓ Sudah Dikunjungi</span><br>'+
          'Kunjungan: '+arr.length+' · Sales: '+htmlEscape(salesNames)+'<br>'+
          'Terakhir: '+new Date(latest.timestamp).toLocaleString('id-ID');
        let marker=advancedVisitMarkers.get(id);
        if(!marker){
          marker=L.marker([lat,lng],{
            icon:L.divIcon({className:'',html:'<div class="z360-store-marker">✓</div>',iconSize:[28,28],iconAnchor:[14,14]})
          }).addTo(advancedMap);
          advancedVisitMarkers.set(id,marker);
        }else marker.setLatLng([lat,lng]);
        marker.bindPopup(popup);
      });
      removeMissingLayers(advancedVisitMarkers,keepVisits,(marker)=>advancedMap.removeLayer(marker));

      // Realtime sales marker, smoothly animated to each Firebase lastLocation.
      const keepSales=new Set();
      data.liveSales.forEach(sale=>{
        const id=String(sale.id||sale.uid||'');
        if(!id)return;
        const loc=sale.lastLocation||{};
        const lat=Number(loc.lat),lng=Number(loc.lng);
        if(!Number.isFinite(lat)||!Number.isFinite(lng))return;
        keepSales.add(id); bounds.push([lat,lng]);
        const username=displayUsername(sale,sale.email);
        const popup='<b>'+htmlEscape(sale.name||username||'Sales')+'</b><br>'+
          '@'+htmlEscape(username)+'<br>'+
          '<span style="color:#e25f36;font-weight:800">● Posisi realtime</span><br>'+
          'Akurasi: ±'+Math.round(Number(loc.accuracy||0))+' m<br>'+
          'Update: '+new Date(loc.timestamp||sale.lastSeen||Date.now()).toLocaleString('id-ID');
        let marker=advancedSalesMarkers.get(id);
        if(!marker){
          marker=L.marker([lat,lng],{
            zIndexOffset:1000,
            icon:L.divIcon({className:'',html:'<div class="z360-sales-marker">'+htmlEscape(salesInitials(sale.name||username))+'</div>',iconSize:[34,34],iconAnchor:[17,17]})
          }).addTo(advancedMap);
          advancedSalesMarkers.set(id,marker);
        }else{
          animateLeafletMarker(marker,[lat,lng],1100);
        }
        marker.bindPopup(popup);
      });
      removeMissingLayers(advancedSalesMarkers,keepSales,(marker)=>advancedMap.removeLayer(marker));

      // Fit once for a filter/data set. Live updates do not jerk the map around.
      const fitKey=JSON.stringify([data.salesId,data.start,data.end,[...keepRoutes].join(','),[...keepVisits].join(','),keepSales.size>0]);
      if((forceFit||advancedFitKey!==fitKey) && bounds.length){
        advancedFitKey=fitKey;
        if(bounds.length===1)advancedMap.setView(bounds[0],16,{animate:true});
        else advancedMap.fitBounds(bounds,{padding:[32,32],animate:true,maxZoom:16});
      }
      setTimeout(()=>{try{advancedMap.invalidateSize(false)}catch(_){}},80);
      if (fallback) fallback.textContent = bounds.length ? '' : 'Belum ada GPS atau kunjungan pada filter yang dipilih.';
    } catch (e) {
      console.warn('Zona360 monitoring map',e);
      if (fallback) fallback.textContent = 'Peta online belum tersedia. Data Firebase tetap tersimpan dan akan muncul saat koneksi Maps tersedia.';
    }
  }

  function destroyAdvancedMonitoring() {
    const root=document.getElementById('z360-advanced-monitor');
    if(root)root.remove();
    if(advancedMap){try{advancedMap.remove()}catch(_){} advancedMap=null;}
    advancedSalesMarkers.clear(); advancedRouteLines.clear(); advancedVisitMarkers.clear();
    advancedRenderKey=''; advancedFitKey='';
    document.querySelectorAll('.z360-monitor-base-grid').forEach(el=>el.classList.remove('z360-monitor-base-grid'));
  }

  function ensureAdvancedMonitoringUi() {
    const session=getSession();
    const heading=[...document.querySelectorAll('h2')].find(h=>String(h.textContent||'').trim()==='Monitoring lapangan');
    if(!session||session.role!=='admin'||!heading){
      if(document.getElementById('z360-advanced-monitor')) destroyAdvancedMonitoring();
      return;
    }

    const sectionHeading=heading.closest('.section-heading');
    if(sectionHeading){
      const p=sectionHeading.querySelector('p');
      if(p)p.textContent='Posisi Sales realtime, rute perjalanan, dan toko yang sudah dikunjungi dalam satu Map.';
      const toolbar=sectionHeading.querySelector('.toolbar');
      if(toolbar)toolbar.querySelectorAll('button').forEach(btn=>{
        if(String(btn.textContent||'').toLowerCase().includes('refresh posisi'))btn.style.display='none';
      });
    }

    let root=document.getElementById('z360-advanced-monitor');
    if(!root){
      root=document.createElement('section');
      root.id='z360-advanced-monitor';
      root.className='card';
      root.style.cssText='margin-top:12px;padding:16px;position:relative;z-index:2';
      root.innerHTML=`
        <div class="z360-monitor-head">
          <div><div class="z360-monitor-title">Monitoring Realtime</div><div class="z360-monitor-sub">Sales bergerak otomatis, rute tersambung, dan toko hasil scan tetap tercatat sebagai riwayat kunjungan.</div></div>
          <span class="z360-live-pill">Firebase Live</span>
        </div>
        <div class="z360-monitor-toolbar">
          <select id="z360-mon-sales" class="search" aria-label="Filter Sales"></select>
          <input id="z360-mon-start" type="date" class="search" aria-label="Tanggal mulai">
          <input id="z360-mon-end" type="date" class="search" aria-label="Tanggal akhir">
          <button id="z360-mon-today" class="btn outline" type="button">Hari ini</button>
          <button id="z360-mon-7d" class="btn outline" type="button">7 hari</button>
        </div>
        <div id="z360-mon-stats" class="z360-monitor-stats"></div>
        <div class="z360-map-shell">
          <div id="z360-route-map"></div>
          <div class="z360-map-legend">
            <span class="sales"><i></i>Sales realtime</span>
            <span class="route"><i></i>Rute</span>
            <span class="visited"><i></i>Toko dikunjungi</span>
          </div>
        </div>
        <div id="z360-mon-fallback" style="font-size:10px;color:#718084;margin-top:8px"></div>`;

      const parent=sectionHeading&&sectionHeading.parentElement;
      const originalGrid=sectionHeading&&sectionHeading.nextElementSibling;
      if(originalGrid && originalGrid.classList && originalGrid.classList.contains('grid')){
        originalGrid.classList.add('z360-monitor-base-grid');
        parent.insertBefore(root,originalGrid);
      }else{
        (parent||heading.parentElement||document.body).appendChild(root);
      }
      const start=root.querySelector('#z360-mon-start'),end=root.querySelector('#z360-mon-end');
      start.value=todayLocalKey(-6); end.value=todayLocalKey(0);
      const onChange=()=>{advancedRenderKey='';advancedFitKey='';renderAdvancedMonitoring(true)};
      root.querySelector('#z360-mon-sales').addEventListener('change',onChange);
      start.addEventListener('change',onChange); end.addEventListener('change',onChange);
      root.querySelector('#z360-mon-today').addEventListener('click',()=>{start.value=todayLocalKey(0);end.value=todayLocalKey(0);onChange()});
      root.querySelector('#z360-mon-7d').addEventListener('click',()=>{start.value=todayLocalKey(-6);end.value=todayLocalKey(0);onChange()});
    }else if(sectionHeading && root.previousElementSibling!==sectionHeading){
      const originalGrid=sectionHeading.nextElementSibling;
      if(originalGrid && originalGrid!==root && originalGrid.classList && originalGrid.classList.contains('grid')){
        originalGrid.classList.add('z360-monitor-base-grid');
        sectionHeading.parentElement.insertBefore(root,originalGrid);
      }
    }

    // Keep original side details below the single unified map, but hide its duplicate map.
    if(sectionHeading){
      let node=root.nextElementSibling;
      if(node && node.classList && node.classList.contains('grid'))node.classList.add('z360-monitor-base-grid');
    }

    const data=getDb()||ensureLocalShape({});
    const select=root.querySelector('#z360-mon-sales');
    const prev=select.value||'all';
    const options=['<option value="all">Semua Sales</option>'].concat((data.sales||[]).map(s=>{
      const id=String(s.id||s.uid||'').replace(/"/g,'');
      const label=String(s.name||displayUsername(s,s.email)||id).replace(/[<>]/g,'');
      return '<option value="'+id+'">'+label+'</option>';
    })).join('');
    if(select.dataset.options!==options){
      select.innerHTML=options;select.dataset.options=options;
      if([...select.options].some(o=>o.value===prev))select.value=prev;
    }
    renderAdvancedMonitoring();
  }


  let featureMigrationDone = false;
  let featureSyncAt = 0;
  const barcodeUiState = { search:'', selected:new Set(), layout:'grid' };

  function persistFeatureData(force) {
    const rawText = nativeGet.call(localStorage, DB_KEY);
    if (!rawText) return null;
    if(!force && barcodeDataCache && !barcodeDataDirty && barcodeDataCacheRaw===rawText) return barcodeDataCache;
    const raw = parseJSON(rawText, null);
    if (!raw) return null;
    const normalized = ensureLocalShape(raw);
    const after = JSON.stringify(normalized);
    if (after !== rawText) {
      nativeSet.call(localStorage, DB_KEY, after);
      barcodeDataDirty = true;
    }
    barcodeDataCache = normalized;
    barcodeDataCacheRaw = after;
    barcodeDataDirty = false;
    if (!featureMigrationDone || force) {
      featureMigrationDone = true;
      const session=getSession();
      if(session && session.role==='admin' && Date.now()-featureSyncAt>5000){
        featureSyncAt=Date.now();
        request('', {method:'PATCH', body:JSON.stringify({
          products:byId(normalized.products), stores:byId(normalized.stores),
          barcodes:byId(normalized.barcodes), barcodeSettings:normalized.barcodeSettings
        })}, 8000).catch((e)=>console.warn('Zona360 feature data sync',e));
      }
    }
    return normalized;
  }

  function ensureFeatureStyles(){
    if(document.getElementById('z360-feature-upgrade-style'))return;
    const style=document.createElement('style');style.id='z360-feature-upgrade-style';style.textContent=`
      .z360-pass-host{position:relative!important}.z360-pass-host input[data-z360-pass]{padding-right:44px!important}
      .z360-pass-eye{position:absolute;right:8px;bottom:7px;width:34px;height:34px;border:0;background:transparent;color:#657078;display:grid;place-items:center;border-radius:8px;cursor:pointer;z-index:3}
      .z360-pass-eye:hover,.z360-pass-eye:focus{background:#f0f3f1;color:#172630;outline:none}.z360-pass-eye svg{width:18px;height:18px}
      .z360-bc-manager{display:grid;gap:14px}.z360-bc-head{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;flex-wrap:wrap}
      .z360-bc-head h2{margin:0 0 5px}.z360-bc-head p{margin:0;color:var(--muted,#6b7479);font-size:12px}.z360-bc-badge{padding:7px 10px;border-radius:999px;background:#e9f8f1;color:#087a55;font-size:10px;font-weight:800;letter-spacing:.06em}
      .z360-bc-toolbar{display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:12px;background:#fff;border:1px solid #e3e6e2;border-radius:12px}
      .z360-bc-search{flex:1 1 220px;min-width:160px;border:1px solid #d9dedb;border-radius:9px;padding:10px 12px;font:inherit;background:#fff;color:#172630}
      .z360-bc-btn{border:1px solid #cfd6d2;background:#fff;color:#172630;border-radius:9px;padding:9px 11px;font:700 11px/1.1 inherit;cursor:pointer;white-space:nowrap}
      .z360-bc-btn.primary{background:#f66a3c;border-color:#f66a3c;color:#fff}.z360-bc-btn:disabled{opacity:.45;cursor:not-allowed}
      .z360-bc-select{border:1px solid #d9dedb;border-radius:9px;padding:9px;background:#fff;font:inherit;font-size:11px}
      .z360-bc-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:12px}
      .z360-bc-card{position:relative;background:#fff;border:1px solid #e2e5e2;border-radius:13px;padding:13px;display:grid;justify-items:center;gap:7px;box-shadow:0 2px 8px rgba(23,38,48,.04)}
      .z360-bc-card.selected{border-color:#f66a3c;box-shadow:0 0 0 2px rgba(246,106,60,.12)}.z360-bc-check{position:absolute;left:10px;top:10px;width:18px;height:18px;accent-color:#f66a3c}
      .z360-bc-qr{width:142px;height:142px;display:grid;place-items:center;background:#fff;padding:7px;border-radius:8px}.z360-bc-qr canvas{width:142px!important;height:142px!important;image-rendering:pixelated}
      .z360-bc-name{font-weight:800;text-align:center;color:#172630;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.z360-bc-code{font:800 11px/1.2 ui-monospace,SFMono-Regular,Menlo,monospace;color:#f66a3c;letter-spacing:.04em}
      .z360-bc-meta{font-size:10px;color:#7a858b;text-align:center}.z360-bc-empty{padding:28px;text-align:center;background:#fff;border:1px dashed #d6dcda;border-radius:12px;color:#7a858b}
      #z360-print-area{display:none}
      @media(max-width:640px){.z360-bc-toolbar{align-items:stretch}.z360-bc-search{flex-basis:100%}.z360-bc-btn,.z360-bc-select{flex:1 1 calc(50% - 8px)}.z360-bc-grid{grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}.z360-bc-card{padding:10px}.z360-bc-qr,.z360-bc-qr canvas{width:116px!important;height:116px!important}.z360-bc-name{font-size:12px}}
      @media(max-width:390px){.z360-bc-grid{grid-template-columns:1fr}.z360-bc-qr,.z360-bc-qr canvas{width:148px!important;height:148px!important}}
      @media print{body.z360-print-barcode>*:not(#z360-print-area){display:none!important}body.z360-print-barcode #z360-print-area{display:block!important;position:static!important;background:#fff!important;color:#000!important;width:100%!important}.z360-print-grid{display:grid!important;grid-template-columns:repeat(2,1fr)!important;gap:10mm!important}.z360-print-grid.single{display:block!important}.z360-print-label{border:1px solid #ddd!important;padding:8mm!important;text-align:center!important;break-inside:avoid!important;page-break-inside:avoid!important;background:#fff!important}.z360-print-grid.single .z360-print-label{min-height:240mm!important;display:flex!important;flex-direction:column!important;align-items:center!important;justify-content:center!important;page-break-after:always!important}.z360-print-label canvas{width:48mm!important;height:48mm!important}.z360-print-grid.single canvas{width:95mm!important;height:95mm!important}.z360-print-label h3{margin:4mm 0 2mm!important;font:700 15pt Arial,sans-serif!important}.z360-print-label p{margin:0 0 4mm!important;font:11pt Arial,sans-serif!important}}
      .z360-bc-manager{gap:10px}.z360-bc-head{align-items:center}.z360-bc-head p,.z360-bc-badge.title-badge{display:none}.z360-bc-toolbar{padding:9px;gap:6px;position:sticky;top:0;z-index:4;box-shadow:0 3px 12px rgba(23,38,48,.05)}
      .z360-bc-toolbar .z360-bc-btn{min-height:38px}.z360-bc-summary{display:flex;justify-content:space-between;gap:8px;align-items:center;color:#6b7479;font-size:10px;padding:0 2px}.z360-bc-list{display:grid;gap:6px}
      .z360-bc-row{display:grid;grid-template-columns:34px minmax(150px,1.6fr) minmax(105px,.8fr) 86px 82px;align-items:center;gap:8px;background:#fff;border:1px solid #e2e5e2;border-radius:10px;padding:8px 10px;min-height:82px;content-visibility:auto;contain-intrinsic-size:82px}.z360-bc-row.head{min-height:auto;background:#f7f8f6;color:#67747b;font-size:9px;font-weight:800;text-transform:uppercase;letter-spacing:.05em;position:sticky;top:57px;z-index:3}.z360-bc-row.selected{border-color:#f66a3c;background:#fffaf7}.z360-bc-row .z360-bc-qr{width:66px;height:66px;padding:3px}.z360-bc-row .z360-bc-qr canvas{width:66px!important;height:66px!important}.z360-bc-row .z360-bc-name{text-align:left;white-space:normal}.z360-bc-row .z360-bc-code{text-align:left}.z360-bc-check{position:static;width:18px;height:18px}.z360-bc-pager{display:flex;align-items:center;justify-content:center;gap:8px;padding:8px}.z360-bc-pager span{font-size:11px;color:#6b7479}.z360-original-barcode-hidden{display:none!important}
      .table-wrap{contain:layout paint;overscroll-behavior:contain}.data-table tbody tr{content-visibility:auto;contain-intrinsic-size:46px}
      @media(max-width:640px){.z360-bc-head h2{font-size:18px}.z360-bc-toolbar{display:grid;grid-template-columns:1fr 1fr}.z360-bc-search{grid-column:1/-1;min-width:0}.z360-bc-toolbar [data-act=all]{grid-column:1/2}.z360-bc-toolbar [data-act=share]{grid-column:2/3}.z360-bc-row.head{display:none}.z360-bc-row{grid-template-columns:28px 1fr 72px;grid-template-areas:'check name qr' 'check code qr' 'check action qr';min-height:96px;padding:8px}.z360-bc-row .z360-bc-check{grid-area:check}.z360-bc-row .z360-bc-name{grid-area:name}.z360-bc-row .z360-bc-code{grid-area:code}.z360-bc-row .z360-bc-qr{grid-area:qr}.z360-bc-row .z360-bc-one{grid-area:action;justify-self:start;padding:6px 9px}.z360-bc-row .z360-bc-qr,.z360-bc-row .z360-bc-qr canvas{width:68px!important;height:68px!important}}
    `;document.head.appendChild(style);
  }

  function eyeSvg(open){return open?'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 3l18 18"/><path d="M10.6 10.6a2 2 0 002.8 2.8"/><path d="M9.9 4.2A10.8 10.8 0 0112 4c5 0 9 5 9 8a10.8 10.8 0 01-2 3.5M6.6 6.6C4.4 8.1 3 10.3 3 12c0 3 4 8 9 8 1.2 0 2.3-.3 3.3-.7"/></svg>':'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>'}
  function ensurePasswordVisibilityUi(){
    ensureFeatureStyles();
    document.querySelectorAll('input[type="password"],input[data-z360-pass]').forEach((input)=>{
      if(input.dataset.z360PassReady==='1')return;
      input.dataset.z360PassReady='1';input.dataset.z360Pass='1';
      const host=input.parentElement;if(!host)return;host.classList.add('z360-pass-host');
      const btn=document.createElement('button');btn.type='button';btn.className='z360-pass-eye';btn.setAttribute('aria-label','Lihat password');btn.innerHTML=eyeSvg(false);
      btn.addEventListener('click',()=>{const show=input.type==='password';input.type=show?'text':'password';btn.innerHTML=eyeSvg(show);btn.setAttribute('aria-label',show?'Sembunyikan password':'Lihat password');input.focus({preventScroll:true})});
      host.appendChild(btn);
    });
  }

  const qrMatrixCache=new Map();
  function qrMatrix(value){
    const key=String(value||'');
    if(qrMatrixCache.has(key))return qrMatrixCache.get(key);
    if(typeof window.Zona360QRMatrix!=='function')throw new Error('QR engine belum siap. Muat ulang aplikasi.');
    const matrix=window.Zona360QRMatrix(key,0,0);
    if(qrMatrixCache.size>500)qrMatrixCache.clear();
    qrMatrixCache.set(key,matrix);
    return matrix;
  }
  function makeQrCanvas(value,size){
    size=Math.max(120,Number(size)||320);const matrix=qrMatrix(value),mw=matrix.getWidth(),mh=matrix.getHeight(),canvas=document.createElement('canvas');canvas.width=size;canvas.height=size;const ctx=canvas.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,size,size);ctx.fillStyle='#000';const sx=size/mw,sy=size/mh;for(let y=0;y<mh;y++)for(let x=0;x<mw;x++)if(matrix.get(x,y))ctx.fillRect(Math.floor(x*sx),Math.floor(y*sy),Math.ceil(sx)+.2,Math.ceil(sy)+.2);return canvas;
  }
  function renderQrInto(el,value,size){try{const code=String(value||'').trim();el.innerHTML='';if(!code){el.textContent='QR belum tersedia';el.classList.add('z360-bc-empty-qr');return}el.classList.remove('z360-bc-empty-qr');el.appendChild(makeQrCanvas(code,size||320))}catch(e){el.textContent='QR gagal';console.warn('Zona360 QR render',e)}}
  function safeFileName(v){return String(v||'toko').normalize('NFKD').replace(/[^a-zA-Z0-9._-]+/g,'-').replace(/^-+|-+$/g,'').slice(0,70)||'toko'}
  function isNativeAndroid(){return /Android/i.test(navigator.userAgent||'')||!!(window.Capacitor&&typeof window.Capacitor.isNativePlatform==='function'&&window.Capacitor.isNativePlatform())}
  async function downloadBlob(blob,name,opts={}){
    if(!blob)throw new Error('File kosong.');
    // Android WebView can expose navigator.share but occasionally never resolve it.
    // Never wait forever: race it against a timeout and then fall back to a normal download.
    if(isNativeAndroid() && !opts.skipShare && typeof File!=='undefined' && navigator.share && navigator.canShare){
      try{
        const file=new File([blob],name,{type:blob.type||'application/octet-stream'});
        if(navigator.canShare({files:[file]})){
          const shareTask=Promise.resolve().then(()=>navigator.share({files:[file],title:opts.title||name,text:opts.text||''}))
            .then(()=>({state:'shared'})).catch(e=>({state:e&&e.name==='AbortError'?'cancel':'error',error:e}));
          const timeoutTask=new Promise(r=>setTimeout(()=>r({state:'timeout'}),Math.max(2500,Number(opts.shareTimeoutMs)||5000)));
          const result=await Promise.race([shareTask,timeoutTask]);
          if(result&&result.state==='shared')return true;
          if(result&&result.state==='cancel')return false;
          if(result&&result.state==='error')console.warn('Zona360 share error',result.error);
          if(result&&result.state==='timeout')console.warn('Zona360 share timeout; using download fallback');
        }
      }catch(e){if(e&&e.name==='AbortError')return false;console.warn('Zona360 native share fallback',e)}
    }
    const a=document.createElement('a'),url=URL.createObjectURL(blob);a.href=url;a.download=name;a.rel='noopener';a.style.display='none';document.body.appendChild(a);
    try{a.click()}finally{setTimeout(()=>{a.remove();URL.revokeObjectURL(url)},30000)}
    return true;
  }
  function barcodeSelectionKey(store){return String(store&&store.id||'')+'::'+String(store&&(store.storeCode||store.code)||'')}
  function selectedBarcodeStores(db,visible){const selected=barcodeUiState.selected;return (visible||db.stores||[]).filter(s=>selected.has(barcodeSelectionKey(s)))}

  async function makeStorePngBlob(store){
    const code=String(store&&(store.storeCode||store.code)||'').trim();
    if(!code)throw new Error('Kode/QR toko belum tersedia.');
    const canvas=document.createElement('canvas');canvas.width=1400;canvas.height=1650;const ctx=canvas.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.fillStyle='#172630';ctx.textAlign='center';ctx.font='700 64px Arial';let name=String(store.name||'Toko');if(name.length>32)name=name.slice(0,31)+'…';ctx.fillText(name,700,120);ctx.font='700 40px Arial';ctx.fillStyle='#f66a3c';ctx.fillText('Kode Toko: '+code,700,190);const qr=makeQrCanvas(code,1000);ctx.drawImage(qr,200,290,1000,1000);ctx.fillStyle='#172630';ctx.font='600 34px Arial';ctx.fillText(code,700,1390);ctx.font='28px Arial';ctx.fillStyle='#6b7479';ctx.fillText('Zona360 • Scan saat kunjungan toko',700,1470);return canvasToPngBlob(canvas);
  }
  async function downloadStorePng(store){
    try{
      const blob=await makeStorePngBlob(store);
      if(isNativeAndroid()){openAndroidPrintPreview([blob]);return}
      await downloadBlob(blob,safeFileName((store.storeCode||store.code||'toko')+'-'+(store.name||'Toko'))+'.png',{skipShare:true});
    }catch(e){console.error('Zona360 store PNG',e);alert('Gagal membuat gambar QR: '+(e&&e.message?e.message:e))}
  }
  async function downloadSelectedPng(stores){if(!stores.length)return alert('Pilih minimal 1 toko.');for(let i=0;i<stores.length;i++){await downloadStorePng(stores[i]);if(i<stores.length-1)await new Promise(r=>setTimeout(r,220))}}

  function csvEscape(v){const s=String(v==null?'':v);return /[",\n\r]/.test(s)?'"'+s.replace(/"/g,'""')+'"':s}
  async function exportBarcodeCsv(stores){
    if(!stores.length)return alert('Pilih minimal 1 toko.');
    try{const rows=[['No','Store ID','Nama Toko','Kode Toko','Barcode Value']];stores.forEach((s,i)=>rows.push([i+1,s.id,s.name||'',s.storeCode,s.storeCode]));const csv='\ufeff'+rows.map(r=>r.map(csvEscape).join(',')).join('\r\n');await downloadBlob(new Blob([csv],{type:'text/csv;charset=utf-8'}),'Zona360_Barcode_Toko.csv',{title:'Export CSV Barcode Zona360'});}catch(e){console.error(e);alert('Gagal membuat CSV: '+(e.message||e))}
  }

  function pdfText(v){return String(v==null?'':v).replace(/[^\x20-\x7E]/g,'?').replace(/\\/g,'\\\\').replace(/\(/g,'\\(').replace(/\)/g,'\\)')}
  function qrPdfCommands(code,x,y,size){
    // Run-length encoding per QR row dramatically reduces PDF commands and CPU use on phones.
    const m=qrMatrix(code),w=m.getWidth(),h=m.getHeight(),cell=size/w,parts=['0 0 0 rg\n'];
    for(let row=0;row<h;row++){
      let col=0;
      while(col<w){
        while(col<w&&!m.get(col,row))col++;
        if(col>=w)break;
        const start=col;while(col<w&&m.get(col,row))col++;
        const px=(x+start*cell).toFixed(2),py=(y+(h-row-1)*cell).toFixed(2),rw=((col-start)*cell+.05).toFixed(2),rh=(cell+.05).toFixed(2);
        parts.push(px+' '+py+' '+rw+' '+rh+' re f\n');
      }
    }
    return parts.join('');
  }
  function pdfLabelContent(store,box,single){const x=box.x,y=box.y,w=box.w,h=box.h;const qrSize=single?310:112;const qx=x+(w-qrSize)/2,qy=y+(single?145:30);const name=pdfText(String(store.name||'Toko').slice(0,single?45:28));const code=pdfText(store.storeCode);let c='1 1 1 rg '+x+' '+y+' '+w+' '+h+' re f\n0.85 0.85 0.85 RG '+x+' '+y+' '+w+' '+h+' re S\n0 0 0 rg\n';c+='BT /F1 '+(single?20:11)+' Tf '+(x+18)+' '+(y+h-(single?48:25))+' Td ('+name+') Tj ET\n';c+='BT /F1 '+(single?14:9)+' Tf '+(x+18)+' '+(y+h-(single?78:42))+' Td (Kode Toko: '+code+') Tj ET\n';c+=qrPdfCommands(store.storeCode,qx,qy,qrSize);c+='BT /F1 '+(single?13:8)+' Tf '+(x+18)+' '+(y+12)+' Td (Zona360 - Barcode Kunjungan Toko) Tj ET\n';return c}
  function buildBarcodePdf(stores,layout){
    const W=595,H=842,pages=[];if(layout==='single'){stores.forEach(s=>pages.push(pdfLabelContent(s,{x:35,y:35,w:525,h:772},true)))}else{for(let i=0;i<stores.length;i+=8){let c='';const batch=stores.slice(i,i+8),margin=24,gap=10,cols=2,rows=4,cellW=(W-margin*2-gap)/2,cellH=(H-margin*2-gap*3)/4;batch.forEach((s,j)=>{const col=j%2,row=Math.floor(j/2),x=margin+col*(cellW+gap),y=H-margin-cellH-row*(cellH+gap);c+=pdfLabelContent(s,{x,y,w:cellW,h:cellH},false)});pages.push(c)}}
    const objs=[];const pageIds=pages.map((_,i)=>4+i*2),contentIds=pages.map((_,i)=>5+i*2);objs[1]='<< /Type /Catalog /Pages 2 0 R >>';objs[2]='<< /Type /Pages /Kids ['+pageIds.map(id=>id+' 0 R').join(' ')+'] /Count '+pages.length+' >>';objs[3]='<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';pages.forEach((content,i)=>{objs[pageIds[i]]='<< /Type /Page /Parent 2 0 R /MediaBox [0 0 '+W+' '+H+'] /Resources << /Font << /F1 3 0 R >> >> /Contents '+contentIds[i]+' 0 R >>';objs[contentIds[i]]='<< /Length '+content.length+' >>\nstream\n'+content+'\nendstream'});let pdf='%PDF-1.4\n%Zona360\n',offsets=[0];for(let i=1;i<objs.length;i++){offsets[i]=pdf.length;pdf+=i+' 0 obj\n'+objs[i]+'\nendobj\n'}const xref=pdf.length;pdf+='xref\n0 '+objs.length+'\n0000000000 65535 f \n';for(let i=1;i<objs.length;i++)pdf+=String(offsets[i]).padStart(10,'0')+' 00000 n \n';pdf+='trailer\n<< /Size '+objs.length+' /Root 1 0 R >>\nstartxref\n'+xref+'\n%%EOF';return new Blob([pdf],{type:'application/pdf'})
  }

  const z360Yield=()=>new Promise(r=>setTimeout(r,0));
  async function buildBarcodePdfAsync(stores,layout,onProgress){
    const W=595,H=842,pages=[];
    if(layout==='single'){
      for(let i=0;i<stores.length;i++){
        pages.push(pdfLabelContent(stores[i],{x:35,y:35,w:525,h:772},true));
        if(onProgress)onProgress(i+1,stores.length);
        if(i%3===2)await z360Yield();
      }
    }else{
      const totalPages=Math.max(1,Math.ceil(stores.length/8));
      for(let i=0,pageNo=0;i<stores.length;i+=8,pageNo++){
        const parts=[],batch=stores.slice(i,i+8),margin=24,gap=10,cellW=(W-margin*2-gap)/2,cellH=(H-margin*2-gap*3)/4;
        batch.forEach((st,j)=>{const col=j%2,row=Math.floor(j/2),x=margin+col*(cellW+gap),y=H-margin-cellH-row*(cellH+gap);parts.push(pdfLabelContent(st,{x,y,w:cellW,h:cellH},false))});
        pages.push(parts.join(''));
        if(onProgress)onProgress(Math.min(i+batch.length,stores.length),stores.length,pageNo+1,totalPages);
        await z360Yield();
      }
    }
    const objs=[],pageIds=pages.map((_,i)=>4+i*2),contentIds=pages.map((_,i)=>5+i*2);
    objs[1]='<< /Type /Catalog /Pages 2 0 R >>';objs[2]='<< /Type /Pages /Kids ['+pageIds.map(id=>id+' 0 R').join(' ')+'] /Count '+pages.length+' >>';objs[3]='<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
    pages.forEach((content,i)=>{objs[pageIds[i]]='<< /Type /Page /Parent 2 0 R /MediaBox [0 0 '+W+' '+H+'] /Resources << /Font << /F1 3 0 R >> >> /Contents '+contentIds[i]+' 0 R >>';objs[contentIds[i]]='<< /Length '+content.length+' >>\nstream\n'+content+'\nendstream'});
    const chunks=['%PDF-1.4\n%Zona360\n'],offsets=[0];let length=chunks[0].length;
    for(let i=1;i<objs.length;i++){offsets[i]=length;const part=i+' 0 obj\n'+objs[i]+'\nendobj\n';chunks.push(part);length+=part.length;if(i%24===0)await z360Yield()}
    const xref=length;let tail='xref\n0 '+objs.length+'\n0000000000 65535 f \n';for(let i=1;i<objs.length;i++)tail+=String(offsets[i]).padStart(10,'0')+' 00000 n \n';tail+='trailer\n<< /Size '+objs.length+' /Root 1 0 R >>\nstartxref\n'+xref+'\n%%EOF';chunks.push(tail);
    return new Blob(chunks,{type:'application/pdf'});
  }
  async function exportBarcodePdf(stores,layout){if(!stores.length)return alert('Pilih minimal 1 toko.');try{const pdf=buildBarcodePdf(stores,layout||'grid');await downloadBlob(pdf,'Zona360_Barcode_Toko.pdf',{title:'PDF Barcode Zona360'});}catch(e){console.error(e);alert('Gagal membuat PDF: '+(e.message||e))}}

  async function canvasToPngBlob(canvas){return new Promise((resolve,reject)=>{try{canvas.toBlob(b=>b?resolve(b):reject(new Error('Gagal membuat gambar cetak.')),'image/png',1)}catch(e){reject(e)}})}
  async function buildBarcodePrintPngPages(stores,onProgress){
    // Mobile-safe export: one column. A direct image viewer on Android shows the
    // whole sequence in order (Toko 1, Toko 2, Toko 3, ...), never only the left column.
    const pageW=1200,pageH=2200,margin=50,gapY=24,rows=4,perPage=rows;
    const cellW=pageW-margin*2,cellH=(pageH-margin*2-gapY*(rows-1))/rows,pages=[];
    for(let start=0;start<stores.length;start+=perPage){
      const canvas=document.createElement('canvas');canvas.width=pageW;canvas.height=pageH;const ctx=canvas.getContext('2d');
      ctx.fillStyle='#fff';ctx.fillRect(0,0,pageW,pageH);
      const batch=stores.slice(start,start+perPage);
      for(let j=0;j<batch.length;j++){
        const st=batch[j],code=String(st.storeCode||st.code||'').trim(),x=margin,y=margin+j*(cellH+gapY);
        ctx.fillStyle='#fff';ctx.strokeStyle='#d7d7d7';ctx.lineWidth=2;ctx.fillRect(x,y,cellW,cellH);ctx.strokeRect(x,y,cellW,cellH);
        ctx.fillStyle='#172630';ctx.textAlign='center';ctx.font='700 34px Arial';let nm=String(st.name||'Toko');if(nm.length>38)nm=nm.slice(0,37)+'…';ctx.fillText(nm,x+cellW/2,y+48);
        ctx.fillStyle='#f66a3c';ctx.font='700 24px Arial';ctx.fillText('Kode: '+(code||'Belum tersedia'),x+cellW/2,y+82);
        if(code){const qrSize=Math.min(330,cellH-150),qr=makeQrCanvas(code,420);ctx.drawImage(qr,x+(cellW-qrSize)/2,y+102,qrSize,qrSize)}else{ctx.fillStyle='#eef1ef';ctx.fillRect(x+cellW/2-165,y+102,330,330);ctx.fillStyle='#68747a';ctx.font='24px Arial';ctx.fillText('QR belum tersedia',x+cellW/2,y+275)}
        ctx.fillStyle='#5f6a70';ctx.font='20px Arial';ctx.fillText(code||'QR belum tersedia',x+cellW/2,y+cellH-24);
        if(onProgress)onProgress(Math.min(start+j+1,stores.length),stores.length);
        await z360Yield();
      }
      pages.push(await canvasToPngBlob(canvas));await z360Yield();
    }
    return pages;
  }
  function closeAndroidPrintPreview(){const n=document.getElementById('z360-android-print-preview');if(n)n.remove()}
  function openAndroidPrintPreview(blobs){
    closeAndroidPrintPreview();if(!blobs||!blobs.length)return;let page=0,urls=blobs.map(b=>URL.createObjectURL(b));
    const modal=document.createElement('div');modal.id='z360-android-print-preview';modal.style.cssText='position:fixed;inset:0;z-index:2147483647;background:rgba(8,17,22,.78);display:flex;align-items:center;justify-content:center;padding:14px';
    modal.innerHTML='<div style="width:min(96vw,520px);max-height:94vh;background:#fff;border-radius:16px;padding:12px;display:flex;flex-direction:column;gap:9px;box-shadow:0 18px 60px rgba(0,0,0,.32)"><div style="display:flex;justify-content:space-between;align-items:center"><strong style="font:700 16px Arial;color:#172630">Preview Gambar QR</strong><button data-x style="border:0;background:#eef1ef;border-radius:9px;width:36px;height:36px;font-size:20px">×</button></div><div data-help style="font:12px Arial;color:#68747a">Semua toko disusun 1 kolom agar tidak terpotong di HP. Simpan gambar lalu kirim ke WhatsApp, atau gunakan Bagikan jika tersedia.</div><div style="overflow:auto;background:#eef1ef;border-radius:10px;padding:6px;min-height:180px"><img data-img style="display:block;width:100%;max-width:100%;height:auto;background:#fff" alt="Preview QR toko"></div><div style="display:flex;gap:7px;align-items:center"><button data-prev class="z360-bc-btn" style="flex:1">‹</button><span data-page style="font:12px Arial;color:#68747a;white-space:nowrap"></span><button data-next class="z360-bc-btn" style="flex:1">›</button></div><button data-share class="z360-bc-btn primary" style="width:100%;min-height:44px">Bagikan</button><a data-save class="z360-bc-btn" style="width:100%;min-height:42px;display:flex;align-items:center;justify-content:center;text-decoration:none;box-sizing:border-box">Simpan Gambar</a></div>';
    document.body.appendChild(modal);const img=modal.querySelector('[data-img]'),pageEl=modal.querySelector('[data-page]'),save=modal.querySelector('[data-save]'),share=modal.querySelector('[data-share]'),help=modal.querySelector('[data-help]');
    const pageName=()=> 'Zona360_QR_'+String(page+1).padStart(2,'0')+'.png';
    const paint=()=>{img.src=urls[page];pageEl.textContent='Halaman '+(page+1)+' / '+blobs.length;modal.querySelector('[data-prev]').disabled=page<=0;modal.querySelector('[data-next]').disabled=page>=blobs.length-1;save.href=urls[page];save.download=pageName()};paint();
    let shareAvailable=false;
    try{if(navigator.share&&navigator.canShare&&typeof File!=='undefined'){const testFile=new File([blobs[0]],'Zona360_QR_01.png',{type:'image/png'});shareAvailable=!!navigator.canShare({files:[testFile]})}}catch(_){}
    if(!shareAvailable){share.style.display='none';help.textContent='Semua toko disusun 1 kolom agar tidak terpotong di HP. Gunakan Simpan Gambar, lalu kirim gambar tersebut lewat WhatsApp/aplikasi lain.'}
    const cleanup=()=>{urls.forEach(u=>setTimeout(()=>URL.revokeObjectURL(u),500));modal.remove()};modal.querySelector('[data-x]').onclick=cleanup;
    modal.querySelector('[data-prev]').onclick=()=>{if(page>0){page--;paint()}};modal.querySelector('[data-next]').onclick=()=>{if(page<blobs.length-1){page++;paint()}};
    share.onclick=async()=>{
      try{
        const one=new File([blobs[page]],pageName(),{type:'image/png'});
        if(navigator.share&&navigator.canShare&&navigator.canShare({files:[one]})){await navigator.share({files:[one],title:'QR Toko Zona360',text:'QR toko siap dibagikan'});return}
        share.style.display='none';help.textContent='Share bawaan tidak tersedia di perangkat ini. Gunakan Simpan Gambar, lalu kirim lewat WhatsApp/aplikasi lain.';
      }catch(e){if(!(e&&e.name==='AbortError')){console.warn('Zona360 image share',e);help.textContent='Share tidak dapat dibuka. Gunakan Simpan Gambar sebagai cara yang paling stabil.'}}
    };
  }

  let z360ExportImageBusy=false;
  async function exportBarcodeImages(stores){
    if(!stores.length)return alert('Pilih minimal 1 toko terlebih dahulu.');
    if(z360ExportImageBusy)return;
    const btn=document.querySelector('#z360-barcode-manager [data-act="share"]'),oldText=btn&&btn.textContent;
    try{
      z360ExportImageBusy=true;if(btn){btn.disabled=true;btn.textContent='Menyiapkan 0/'+stores.length}
      const pages=await buildBarcodePrintPngPages(stores,(done,total)=>{if(btn)btn.textContent='Menyiapkan '+done+'/'+total});
      if(btn)btn.textContent='Membuka…';await z360Yield();openAndroidPrintPreview(pages);
    }catch(e){console.error('Zona360 export image',e);alert('Gagal membuat gambar QR: '+(e&&e.message?e.message:e))}
    finally{z360ExportImageBusy=false;if(btn){btn.disabled=false;btn.textContent=oldText||'Download / Share'}}
  }

  let z360PrintBusy=false;
  async function printBarcodes(stores,layout){
    if(!stores.length)return alert('Pilih minimal 1 toko terlebih dahulu.');
    if(z360PrintBusy)return;
    if(isNativeAndroid()){
      z360PrintBusy=true;const btn=document.querySelector('#z360-barcode-manager [data-act="print"]'),oldText=btn&&btn.textContent;if(btn){btn.disabled=true;btn.textContent='Menyiapkan 0/'+stores.length}
      try{
        // Android WebView does not reliably save/open generated PDF files. Build A4-like PNG pages instead.
        // Image sharing is supported much more consistently and the preview remains visible if Android has no print target.
        const pages=await buildBarcodePrintPngPages(stores,(done,total)=>{if(btn)btn.textContent='Menyiapkan '+done+'/'+total});
        if(btn)btn.textContent='Membuka…';await z360Yield();
        const files=pages.map((b,i)=>new File([b],'Zona360_QR_Cetak_'+String(i+1).padStart(2,'0')+'.png',{type:'image/png'}));
        let shared=false;
        if(navigator.share&&navigator.canShare){
          try{if(navigator.canShare({files})){await navigator.share({files,title:'Cetak QR Zona360',text:'QR toko siap dicetak'});shared=true}else if(files.length===1&&navigator.canShare({files:[files[0]]})){await navigator.share({files:[files[0]],title:'Cetak QR Zona360'});shared=true}}catch(e){if(e&&e.name==='AbortError'){shared=true}else console.warn('Zona360 image share',e)}
        }
        if(!shared)openAndroidPrintPreview(pages);
      }catch(e){console.error('Zona360 print image',e);alert('Gagal menyiapkan QR cetak: '+(e&&e.message?e.message:e))}
      finally{z360PrintBusy=false;if(btn){btn.disabled=false;btn.textContent=oldText||'Print'}}
      return;
    }
    let area=document.getElementById('z360-print-area');if(area)area.remove();area=document.createElement('div');area.id='z360-print-area';area.innerHTML='<div class="z360-print-grid '+(layout==='single'?'single':'')+'"></div>';const grid=area.firstElementChild;stores.forEach(s=>{const card=document.createElement('div');card.className='z360-print-label';card.innerHTML='<h3></h3><p></p><div class="z360-print-qr"></div>';card.querySelector('h3').textContent=s.name||'Toko';card.querySelector('p').textContent='Kode Toko: '+s.storeCode;renderQrInto(card.querySelector('.z360-print-qr'),s.storeCode,520);grid.appendChild(card)});document.body.appendChild(area);document.body.classList.add('z360-print-barcode');setTimeout(()=>{window.print();setTimeout(()=>{document.body.classList.remove('z360-print-barcode');area.remove()},1000)},180)
  }

  function currentBarcodeData(){
    const rawText=nativeGet.call(localStorage,DB_KEY)||'';
    if(barcodeDataCache && !barcodeDataDirty && barcodeDataCacheRaw===rawText) return barcodeDataCache;
    const db=ensureLocalShape(parseJSON(rawText,{}));
    barcodeDataCache=db;barcodeDataCacheRaw=rawText;barcodeDataDirty=false;return db;
  }
  function barcodeFilteredStores(db){
    const q=barcodeUiState.search.trim().toLowerCase();
    return (db.stores||[]).filter(s=>!q||String(s.name||'').toLowerCase().includes(q)||String(s.storeCode||s.code||'').toLowerCase().includes(q));
  }

  function refreshBarcodeSelectionUi(root,visible){
    const selected=barcodeUiState.selected;
    root.querySelectorAll('.z360-bc-row[data-store-key]').forEach(row=>{
      const key=decodeURIComponent(row.dataset.storeKey||''),yes=selected.has(key);row.classList.toggle('selected',yes);const cb=row.querySelector('.z360-bc-check');if(cb)cb.checked=yes;
    });
    const sel=root.querySelector('[data-z360-bc-selected]');if(sel)sel.textContent=selected.size+' dipilih';
    const allBtn=root.querySelector('[data-act="all"]');if(allBtn){const all=visible.length>0&&visible.every(s=>selected.has(barcodeSelectionKey(s)));allBtn.textContent=all?'Batalkan Semua':'Pilih Semua'}
  }

  function renderBarcodeCards(root){
    const db=currentBarcodeData(),visible=barcodeFilteredStores(db),pageSize=25,totalPages=Math.max(1,Math.ceil(visible.length/pageSize));
    barcodeUiState.page=Math.max(1,Math.min(totalPages,barcodeUiState.page||1));const start=(barcodeUiState.page-1)*pageSize,page=visible.slice(start,start+pageSize);
    const list=root.querySelector('.z360-bc-list'),count=root.querySelector('[data-z360-bc-count]');if(count)count.textContent=visible.length+' toko';if(!list)return;
    if(!page.length){list.innerHTML='<div class="z360-bc-empty">Data toko tidak tersedia atau tidak cocok dengan pencarian.</div>';}
    else{
      list.innerHTML='<div class="z360-bc-row head"><span>Pilih</span><span>Nama Toko</span><span>Kode Toko</span><span>Barcode</span><span>Aksi</span></div>'+page.map((st,idx)=>{const key=barcodeSelectionKey(st);return '<div class="z360-bc-row '+(barcodeUiState.selected.has(key)?'selected':'')+'" data-row-index="'+idx+'" data-store-key="'+encodeURIComponent(key)+'"><input class="z360-bc-check" type="checkbox" '+(barcodeUiState.selected.has(key)?'checked':'')+' aria-label="Pilih toko"><div class="z360-bc-name"></div><div class="z360-bc-code"></div><div class="z360-bc-qr"></div><button class="z360-bc-btn z360-bc-one" type="button">Gambar</button></div>'}).join('');
      const rows=[...list.querySelectorAll('.z360-bc-row[data-row-index]')];let qi=0;
      const drawBatch=()=>{for(let n=0;n<5&&qi<rows.length;n++,qi++){const row=rows[qi],idx=Number(row.dataset.rowIndex),store=page[idx];if(!store)continue;const key=barcodeSelectionKey(store);row.querySelector('.z360-bc-name').textContent=store.name||'Toko tanpa nama';row.querySelector('.z360-bc-code').textContent=store.storeCode||store.code||'Kode belum tersedia';renderQrInto(row.querySelector('.z360-bc-qr'),store.storeCode||store.code||'',120);row.querySelector('.z360-bc-check').addEventListener('change',(ev)=>{if(ev.target.checked)barcodeUiState.selected.add(key);else barcodeUiState.selected.delete(key);refreshBarcodeSelectionUi(root,visible)});row.querySelector('.z360-bc-one').addEventListener('click',()=>downloadStorePng(store))}if(qi<rows.length)setTimeout(drawBatch,0)};drawBatch();
    }
    let pager=root.querySelector('.z360-bc-pager');if(pager){pager.innerHTML='<button class="z360-bc-btn" data-pg="prev" '+(barcodeUiState.page<=1?'disabled':'')+'>‹</button><span>Halaman '+barcodeUiState.page+' / '+totalPages+'</span><button class="z360-bc-btn" data-pg="next" '+(barcodeUiState.page>=totalPages?'disabled':'')+'>›</button>';pager.querySelector('[data-pg="prev"]').onclick=()=>{barcodeUiState.page--;renderBarcodeCards(root)};pager.querySelector('[data-pg="next"]').onclick=()=>{barcodeUiState.page++;renderBarcodeCards(root)}}
    refreshBarcodeSelectionUi(root,visible);
  }

  function hideOriginalBarcodeUi(root){
    [...document.querySelectorAll('h2')].filter(h=>!root.contains(h)&&String(h.textContent||'').trim().toLowerCase()==='barcode toko').forEach((heading)=>{
      const section=heading.closest('.section-heading');if(section){section.classList.add('z360-original-barcode-hidden');const card=section.nextElementSibling;if(card&&card.classList&&card.classList.contains('card'))card.classList.add('z360-original-barcode-hidden')}
    });
  }

  function cleanupBarcodeManagementUi(){
    document.querySelectorAll('#z360-barcode-manager').forEach((node)=>{try{node.remove()}catch(_){}});
    document.querySelectorAll('.z360-original-barcode-hidden').forEach((node)=>node.classList.remove('z360-original-barcode-hidden'));
    const area=document.getElementById('z360-print-area');if(area)area.remove();
    document.body&&document.body.classList.remove('z360-print-barcode');
  }

  function ensureBarcodeManagementUi(){
    ensureFeatureStyles();
    let root=document.getElementById('z360-barcode-manager');
    const originalHeading=[...document.querySelectorAll('h2')].find(h=>!root?.contains(h)&&String(h.textContent||'').trim().toLowerCase()==='barcode toko');
    // The barcode manager is injected outside React. It MUST be removed as soon as
    // another dashboard is active, otherwise React can reuse the content container
    // while this foreign node remains and the two dashboards visually stack.
    if(!originalHeading){
      if(root)cleanupBarcodeManagementUi();
      return;
    }
    const section=originalHeading.closest('.section-heading');
    const expectedParent=section?.parentElement||originalHeading.parentElement||document.body;
    if(root && root.parentElement!==expectedParent){root.remove();root=null}
    // Defensive duplicate cleanup in case an older WebView navigation left more than one instance.
    const duplicates=[...document.querySelectorAll('#z360-barcode-manager')];
    if(duplicates.length>1){duplicates.slice(1).forEach(n=>n.remove());root=duplicates[0]||null}
    if(!root){
      persistFeatureData(false);
      root=document.createElement('section');root.id='z360-barcode-manager';root.className='z360-bc-manager';
      root.innerHTML='<div class="z360-bc-head"><div><h2>Barcode Toko</h2><p>Pilih toko lalu simpan/bagikan QR sebagai gambar.</p></div></div><div class="z360-bc-toolbar"><input class="z360-bc-search" placeholder="Cari Toko / Kode Toko"><button class="z360-bc-btn" data-act="all">Pilih Semua</button><button class="z360-bc-btn primary" data-act="share">Download / Share</button></div><div class="z360-bc-summary"><span data-z360-bc-selected>0 dipilih</span><span data-z360-bc-count>0 toko</span></div><div class="z360-bc-list"></div><div class="z360-bc-pager"></div>';
      expectedParent.insertBefore(root,section||originalHeading);
      let debounce=0;root.querySelector('.z360-bc-search').value=barcodeUiState.search;root.querySelector('.z360-bc-search').addEventListener('input',e=>{barcodeUiState.search=e.target.value;barcodeUiState.page=1;clearTimeout(debounce);debounce=setTimeout(()=>renderBarcodeCards(root),160)});
      root.querySelector('[data-act="all"]').addEventListener('click',()=>{const visible=barcodeFilteredStores(currentBarcodeData()),all=visible.length>0&&visible.every(s=>barcodeUiState.selected.has(barcodeSelectionKey(s)));visible.forEach(s=>{const key=barcodeSelectionKey(s);all?barcodeUiState.selected.delete(key):barcodeUiState.selected.add(key)});refreshBarcodeSelectionUi(root,visible)});
      const pick=()=>selectedBarcodeStores(currentBarcodeData());
      root.querySelector('[data-act="share"]').addEventListener('click',()=>exportBarcodeImages(pick()));
      renderBarcodeCards(root);
    }
    hideOriginalBarcodeUi(root);
    if(barcodeDataDirty){renderBarcodeCards(root)}
  }

  function ensureDataTokoStabilityUi(){
    const heading=[...document.querySelectorAll('h2')].find(h=>String(h.textContent||'').trim().toLowerCase()==='data toko');if(!heading)return;
    const card=heading.closest('.section-heading')?.nextElementSibling;if(!card)return;
    card.classList.add('z360-store-stable');const wrap=card.querySelector('.table-wrap');if(wrap)wrap.style.webkitOverflowScrolling='touch';
  }

  function ensureProductPresentationUi(){
    const heading=[...document.querySelectorAll('h2')].find(h=>String(h.textContent||'').trim().toLowerCase()==='daftar produk');if(!heading)return;persistFeatureData(false);const p=heading.parentElement&&heading.parentElement.querySelector('p');if(p)p.textContent='12 produk AVITA & EDEL • harga Rupiah • tersimpan dan tersinkron ke Firebase.';
  }

  function observeUi() {
    // RC14/RC15 used a subtree MutationObserver whose callback mutated the same DOM.
    // That created an endless observer -> textContent -> observer feedback loop and
    // starved Android WebView's UI thread, breaking focus/keyboard/taps.
    const run = () => {
      try { ensureModernPresentation(); } catch (e) { console.warn('Zona360 presentation UI', e); }
      try { ensurePasswordVisibilityUi(); } catch (e) { console.warn('Zona360 password eye UI', e); }
      try { ensureBarcodeManagementUi(); } catch (e) { console.warn('Zona360 barcode management UI', e); }
      try { ensureDataTokoStabilityUi(); } catch (e) { console.warn('Zona360 data toko stability UI', e); }
      try { ensureProductPresentationUi(); } catch (e) { console.warn('Zona360 product catalog UI', e); }
      try { ensureTrackingUi(); } catch (e) { console.warn('Zona360 tracking UI', e); }
      try { ensureLoginStatusUi(); } catch (e) { console.warn('Zona360 auth UI', e); }
      try { ensureAdvancedMonitoringUi(); } catch (e) { console.warn('Zona360 monitor UI', e); }
      try { ensureResetPasswordUi(); } catch (e) { console.warn('Zona360 reset password UI', e); }
      try { ensureAdminCreateUi(); } catch (e) { console.warn('Zona360 add admin UI', e); }
      try { ensureWorkerConfigUi(); } catch (e) { console.warn('Zona360 worker config UI', e); }
    };
    const start = () => {
      if (!document.body) return setTimeout(start, 50);
      run();
      if(!window.__z360BarcodeNavCleanupInstalled){
        window.__z360BarcodeNavCleanupInstalled=true;
        document.addEventListener('click',(ev)=>{
          const root=document.getElementById('z360-barcode-manager');
          if(!root||root.contains(ev.target))return;
          const btn=ev.target&&ev.target.closest?ev.target.closest('button'):null;
          if(!btn)return;
          const label=String(btn.textContent||'').replace(/\s+/g,' ').trim().toLowerCase();
          const navLabels=['ringkasan','tim sales','data toko','produk','monitoring','laporan','order sales','masukan toko','akses pengguna','lapangan','riwayat kunjungan','scan toko','buat order','semua menu'];
          if(navLabels.some(x=>label===x||label.includes(x)))cleanupBarcodeManagementUi();
        },true);
      }
      if (window.__z360UiPollTimer) clearInterval(window.__z360UiPollTimer);
      window.__z360UiPollTimer = setInterval(run, 2400);
    };
    start();
  }

  function installTrackingLifecycleHooks() {
    if (window.__z360TrackingLifecycleInstalled) return;
    window.__z360TrackingLifecycleInstalled = true;
    const resume = () => {
      const session=getSession();
      if(session && session.role==='sales' && trackingIsRequested(session) && watchId===null){
        setTimeout(()=>startTracking().catch(()=>{}),250);
      }
    };
    document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')resume();},{passive:true});
    window.addEventListener('pageshow',resume,{passive:true});
    try {
      const appPlugin=window.Capacitor&&window.Capacitor.Plugins&&window.Capacitor.Plugins.App;
      if(appPlugin&&typeof appPlugin.addListener==='function'){
        appPlugin.addListener('appStateChange',(state)=>{if(state&&state.isActive)resume();});
      }
    } catch (_) {}
  }

  async function resumeTrackingIfNeeded() {
    const session = getSession();
    if (session && session.role === 'sales' && trackingIsRequested(session)) {
      await startTracking();
    }
  }

  async function startCloudAfterLogin() {
    if (cloudStarted || !getSession()) return;
    cloudStarted = true;
    const authState = parseJSON(nativeGet.call(localStorage, AUTH_KEY), null);
    if (authState && authState.uid && authState.idToken) {
      setCloudStatus('connecting', 'Firebase Auth aktif · menyambungkan realtime…');
      if (CLOUD_DATA_SYNC_ENABLED) {
        await bootstrapOperationalCloud();
        startPolling();
        startRealtimeStream();
      }
      loadLeafletAsync().catch(()=>{});
    } else {
      setCloudStatus('offline', 'Session Firebase tidak tersedia · login ulang');
    }
  }

  async function bootstrap() {
    if (bootstrapped) return;
    bootstrapped = true;
    installStorageBridge();
    setTimeout(() => { try { persistFeatureData(true); } catch (e) { console.warn('Zona360 feature migration', e); } }, 700);
    installTrackingLifecycleHooks();
    observeUi();
    setCloudStatus('offline', 'Mode lokal siap');

    // Login must be 100% local-first. Do not read/write Firebase until a user
    // has successfully logged in and the session has been persisted.
    if (getSession()) setTimeout(startCloudAfterLogin, 150);
    setTimeout(resumeTrackingIfNeeded, 1200);
  }

  window.Zona360Firebase = {
    config: CONFIG,
    bootstrap,
    flush: flushPendingPatch,
    refresh: fetchAndApplyRemote,
    authenticate,
    createSalesUser,
    setUserRole: setManagedUserRole,
    createManagedUser,
    createAdminUser,
    resetManagedUserPassword,
    sendPasswordResetEmail,
    getAdminWorkerUrl,
    setAdminWorkerUrl,
    testAdminWorker,
    startTracking,
    stopTracking,
    getStatus: () => ({ state: cloudState, message: cloudMessage, deviceId })
  };
})();
