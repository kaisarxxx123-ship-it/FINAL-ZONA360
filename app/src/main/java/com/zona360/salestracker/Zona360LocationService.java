package com.zona360.salestracker;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.location.Location;
import android.os.Build;
import android.os.IBinder;

import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;
import androidx.core.content.ContextCompat;

import com.google.android.gms.location.FusedLocationProviderClient;
import com.google.android.gms.location.LocationCallback;
import com.google.android.gms.location.LocationRequest;
import com.google.android.gms.location.LocationResult;
import com.google.android.gms.location.LocationServices;
import com.google.android.gms.location.Priority;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import java.util.TimeZone;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

public class Zona360LocationService extends Service {
    public static final String ACTION_START = "com.zona360.salestracker.START_TRACKING";
    public static final String ACTION_STOP = "com.zona360.salestracker.STOP_TRACKING";

    private static final String CHANNEL_ID = "zona360_sales_location";
    private static final int NOTIFICATION_ID = 3602;
    private static final String PREFS = "zona360_native_tracking";
    private static final AtomicBoolean RUNNING = new AtomicBoolean(false);

    private FusedLocationProviderClient fused;
    private LocationCallback locationCallback;
    private final ExecutorService network = Executors.newSingleThreadExecutor();
    private SharedPreferences prefs;

    private volatile long lastLiveUploadAt = 0L;
    private volatile long lastHistoryUploadAt = 0L;
    private volatile Location lastHistoryLocation = null;
    private volatile String salesKey = null;
    private volatile String usersKey = null;

    public static boolean isRunning() {
        return RUNNING.get();
    }

    @Override
    public void onCreate() {
        super.onCreate();
        prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        fused = LocationServices.getFusedLocationProviderClient(this);
        createNotificationChannel();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_STOP.equals(intent.getAction())) {
            stopWithInactiveSync();
            return START_NOT_STICKY;
        }

        if (intent != null && ACTION_START.equals(intent.getAction())) {
            persistSession(intent);
        }

        if (!hasStoredSession()) {
            stopSelf();
            return START_NOT_STICKY;
        }

        startForeground(NOTIFICATION_ID, buildNotification("GPS Sales aktif • posisi dikirim realtime"));
        RUNNING.set(true);
        startLocationUpdates();
        return START_STICKY;
    }

    private void persistSession(Intent intent) {
        prefs.edit()
            .putString("uid", intent.getStringExtra("uid"))
            .putString("userName", intent.getStringExtra("userName"))
            .putString("idToken", intent.getStringExtra("idToken"))
            .putString("refreshToken", intent.getStringExtra("refreshToken"))
            .putString("apiKey", intent.getStringExtra("apiKey"))
            .putString("databaseUrl", trimSlash(intent.getStringExtra("databaseUrl")))
            .putString("root", cleanRoot(intent.getStringExtra("root")))
            .putLong("issuedAt", intent.getLongExtra("issuedAt", System.currentTimeMillis()))
            .putLong("expiresIn", intent.getLongExtra("expiresIn", 3600L))
            .apply();
        salesKey = null;
        usersKey = null;
    }

    private boolean hasStoredSession() {
        return !prefs.getString("uid", "").trim().isEmpty()
            && !prefs.getString("idToken", "").trim().isEmpty()
            && !prefs.getString("databaseUrl", "").trim().isEmpty();
    }

    private boolean hasLocationPermission() {
        return ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
            || ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED;
    }

    private void startLocationUpdates() {
        if (!hasLocationPermission()) {
            updateNotification("Izin lokasi belum aktif • buka Zona360");
            return;
        }
        if (locationCallback != null) return;

        LocationRequest request = new LocationRequest.Builder(Priority.PRIORITY_HIGH_ACCURACY, 3000L)
            .setMinUpdateIntervalMillis(1500L)
            .setMinUpdateDistanceMeters(1.5f)
            .setWaitForAccurateLocation(false)
            .build();

        locationCallback = new LocationCallback() {
            @Override
            public void onLocationResult(LocationResult result) {
                Location location = result.getLastLocation();
                if (location == null) return;
                if (location.hasAccuracy() && location.getAccuracy() > 300f && lastHistoryLocation != null) return;
                handleLocation(location);
            }
        };

        try {
            fused.requestLocationUpdates(request, locationCallback, getMainLooper());
        } catch (SecurityException error) {
            updateNotification("GPS tidak dapat dimulai • periksa izin lokasi");
        }
    }

    private void handleLocation(Location location) {
        long now = System.currentTimeMillis();
        if (now - lastLiveUploadAt < 2500L) return;
        lastLiveUploadAt = now;

        boolean historyDue = lastHistoryLocation == null
            || now - lastHistoryUploadAt >= 10000L
            || location.distanceTo(lastHistoryLocation) >= 10f;

        Location snapshot = new Location(location);
        network.execute(() -> uploadLocation(snapshot, historyDue));
        updateNotification(String.format(Locale.US, "GPS Sales aktif • akurasi ±%dm", Math.round(location.getAccuracy())));
    }

    private void uploadLocation(Location location, boolean historyDue) {
        try {
            String token = ensureFreshToken();
            if (token.isEmpty()) return;
            String uid = prefs.getString("uid", "");
            String userName = prefs.getString("userName", "Sales");
            String timestamp = isoNow();

            if (salesKey == null) {
                salesKey = findUserKey("sales", uid, token);
                if (salesKey == null) salesKey = uid;
            }
            if (usersKey == null) {
                usersKey = findUserKey("users", uid, token);
                if (usersKey == null) usersKey = uid;
            }

            JSONObject lastLocation = new JSONObject();
            lastLocation.put("lat", location.getLatitude());
            lastLocation.put("lng", location.getLongitude());
            lastLocation.put("accuracy", location.hasAccuracy() ? location.getAccuracy() : 0f);
            lastLocation.put("timestamp", timestamp);

            JSONObject livePatch = new JSONObject();
            // Keep the existing Firebase collection names, but make a missing Sales
            // record self-identifying so Admin Monitoring can render it immediately.
            livePatch.put("id", uid);
            livePatch.put("uid", uid);
            livePatch.put("name", userName);
            livePatch.put("role", "sales");
            livePatch.put("active", true);
            livePatch.put("status", "active");
            livePatch.put("trackingStatus", "active");
            livePatch.put("lastSeen", timestamp);
            livePatch.put("lastLocation", lastLocation);

            if (salesKey != null) request("PATCH", collectionChildUrl("sales", salesKey, token), livePatch.toString(), "application/json");
            if (usersKey != null) request("PATCH", collectionChildUrl("users", usersKey, token), livePatch.toString(), "application/json");

            if (historyDue) {
                long now = System.currentTimeMillis();
                JSONObject point = new JSONObject();
                point.put("id", "gps-" + uid + "-" + now);
                point.put("userId", uid);
                point.put("userName", userName);
                point.put("lat", location.getLatitude());
                point.put("lng", location.getLongitude());
                point.put("accuracy", location.hasAccuracy() ? location.getAccuracy() : 0f);
                point.put("timestamp", timestamp);
                point.put("deviceId", "android-native-" + Build.MANUFACTURER + "-" + Build.MODEL);
                request("POST", collectionUrl("gpsHistory", token), point.toString(), "application/json");

                // Route points belong only in gpsHistory. Do NOT create an
                // "activity" every few seconds: that polluted Riwayat/Laporan,
                // inflated daily activity counts and made long-running accounts slow.
                lastHistoryUploadAt = now;
                lastHistoryLocation = new Location(location);
            }
        } catch (Exception ignored) {
            // Location service must never crash because the network is temporarily unavailable.
            // The next GPS fix retries the upload automatically.
        }
    }

    private String findUserKey(String collection, String uid, String token) throws Exception {
        String raw = request("GET", collectionUrl(collection, token), null, null);
        if (raw == null || raw.trim().isEmpty() || "null".equals(raw.trim())) return null;
        String trimmed = raw.trim();
        if (trimmed.startsWith("[")) {
            JSONArray array = new JSONArray(trimmed);
            for (int i = 0; i < array.length(); i++) {
                Object value = array.opt(i);
                if (!(value instanceof JSONObject)) continue;
                JSONObject item = (JSONObject) value;
                if (uid.equals(item.optString("id")) || uid.equals(item.optString("uid"))) return String.valueOf(i);
            }
            return null;
        }
        JSONObject object = new JSONObject(trimmed);
        java.util.Iterator<String> keys = object.keys();
        while (keys.hasNext()) {
            String key = keys.next();
            JSONObject item = object.optJSONObject(key);
            if (item == null) continue;
            if (uid.equals(item.optString("id")) || uid.equals(item.optString("uid"))) return key;
        }
        return null;
    }

    private String ensureFreshToken() throws Exception {
        String token = prefs.getString("idToken", "");
        long issuedAt = prefs.getLong("issuedAt", 0L);
        long expiresIn = prefs.getLong("expiresIn", 3600L);
        long refreshAt = issuedAt + Math.max(60L, expiresIn) * 1000L - 300000L;
        if (System.currentTimeMillis() < refreshAt) return token;

        String refreshToken = prefs.getString("refreshToken", "");
        String apiKey = prefs.getString("apiKey", "");
        if (refreshToken.isEmpty() || apiKey.isEmpty()) return token;

        String body = "grant_type=refresh_token&refresh_token=" + URLEncoder.encode(refreshToken, "UTF-8");
        String raw = request("POST", "https://securetoken.googleapis.com/v1/token?key=" + URLEncoder.encode(apiKey, "UTF-8"), body, "application/x-www-form-urlencoded");
        JSONObject data = new JSONObject(raw);
        String newToken = data.optString("id_token", token);
        String newRefresh = data.optString("refresh_token", refreshToken);
        long newExpires = data.optLong("expires_in", expiresIn);
        prefs.edit()
            .putString("idToken", newToken)
            .putString("refreshToken", newRefresh)
            .putLong("expiresIn", newExpires)
            .putLong("issuedAt", System.currentTimeMillis())
            .apply();
        return newToken;
    }

    private String collectionUrl(String collection, String token) throws Exception {
        return rootUrl() + "/" + collection + ".json?auth=" + URLEncoder.encode(token, "UTF-8");
    }

    private String collectionChildUrl(String collection, String key, String token) throws Exception {
        return rootUrl() + "/" + collection + "/" + URLEncoder.encode(key, "UTF-8") + ".json?auth=" + URLEncoder.encode(token, "UTF-8");
    }

    private String rootUrl() {
        return trimSlash(prefs.getString("databaseUrl", "")) + "/" + cleanRoot(prefs.getString("root", "zona360_v1"));
    }

    private String request(String method, String urlString, @Nullable String body, @Nullable String contentType) throws Exception {
        HttpURLConnection conn = (HttpURLConnection) new URL(urlString).openConnection();
        conn.setRequestMethod(method);
        conn.setConnectTimeout(9000);
        conn.setReadTimeout(9000);
        conn.setUseCaches(false);
        conn.setRequestProperty("Accept", "application/json");
        if (body != null) {
            conn.setDoOutput(true);
            conn.setRequestProperty("Content-Type", contentType == null ? "application/json" : contentType);
            byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
            try (OutputStream out = conn.getOutputStream()) {
                out.write(bytes);
            }
        }
        int code = conn.getResponseCode();
        InputStream stream = code >= 200 && code < 300 ? conn.getInputStream() : conn.getErrorStream();
        StringBuilder response = new StringBuilder();
        if (stream != null) {
            try (BufferedReader reader = new BufferedReader(new InputStreamReader(stream, StandardCharsets.UTF_8))) {
                String line;
                while ((line = reader.readLine()) != null) response.append(line);
            }
        }
        conn.disconnect();
        if (code < 200 || code >= 300) throw new IllegalStateException("HTTP " + code + " " + response);
        return response.toString();
    }

    private void stopWithInactiveSync() {
        // Stop new GPS callbacks immediately, but keep Firebase credentials alive until
        // the explicit NONAKTIF patch has had one chance to finish. The previous code
        // cleared prefs/stopped the service first, which could cancel this network write.
        RUNNING.set(false);
        if (locationCallback != null) {
            fused.removeLocationUpdates(locationCallback);
            locationCallback = null;
        }
        updateNotification("GPS Sales dihentikan • memperbarui status");
        network.execute(() -> {
            try {
                String token = ensureFreshToken();
                String uid = prefs.getString("uid", "");
                if (!uid.isEmpty() && !token.isEmpty()) {
                    if (salesKey == null) salesKey = findUserKey("sales", uid, token);
                    if (usersKey == null) usersKey = findUserKey("users", uid, token);
                    if (salesKey == null) salesKey = uid;
                    if (usersKey == null) usersKey = uid;
                    JSONObject patch = new JSONObject();
                    patch.put("trackingStatus", "inactive");
                    patch.put("lastSeen", isoNow());
                    request("PATCH", collectionChildUrl("sales", salesKey, token), patch.toString(), "application/json");
                    request("PATCH", collectionChildUrl("users", usersKey, token), patch.toString(), "application/json");
                }
            } catch (Exception ignored) {
                // Logout must still finish even if internet is unavailable.
            } finally {
                prefs.edit().clear().apply();
                stopForeground(STOP_FOREGROUND_REMOVE);
                stopSelf();
            }
        });
    }

    private void stopTrackingAndSelf() {
        RUNNING.set(false);
        if (locationCallback != null) {
            fused.removeLocationUpdates(locationCallback);
            locationCallback = null;
        }
        prefs.edit().clear().apply();
        stopForeground(STOP_FOREGROUND_REMOVE);
        stopSelf();
    }

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationChannel channel = new NotificationChannel(
            CHANNEL_ID,
            getString(R.string.location_channel_name),
            NotificationManager.IMPORTANCE_LOW
        );
        channel.setDescription(getString(R.string.location_channel_description));
        channel.setShowBadge(false);
        NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        manager.createNotificationChannel(channel);
    }

    private Notification buildNotification(String text) {
        Intent launch = new Intent(this, MainActivity.class);
        launch.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent pending = PendingIntent.getActivity(
            this,
            360,
            launch,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
        return new NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_menu_mylocation)
            .setContentTitle("Zona360 • Tracking Sales")
            .setContentText(text)
            .setContentIntent(pending)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .build();
    }

    private void updateNotification(String text) {
        NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        manager.notify(NOTIFICATION_ID, buildNotification(text));
    }

    private String isoNow() {
        SimpleDateFormat fmt = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US);
        fmt.setTimeZone(TimeZone.getTimeZone("UTC"));
        return fmt.format(new Date());
    }

    private static String trimSlash(String value) {
        if (value == null) return "";
        String out = value.trim();
        while (out.endsWith("/")) out = out.substring(0, out.length() - 1);
        return out;
    }

    private static String cleanRoot(String value) {
        String out = value == null ? "zona360_v1" : value.trim();
        while (out.startsWith("/")) out = out.substring(1);
        while (out.endsWith("/")) out = out.substring(0, out.length() - 1);
        return out.isEmpty() ? "zona360_v1" : out;
    }

    @Override
    public void onDestroy() {
        RUNNING.set(false);
        if (locationCallback != null) {
            fused.removeLocationUpdates(locationCallback);
            locationCallback = null;
        }
        network.shutdownNow();
        super.onDestroy();
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
