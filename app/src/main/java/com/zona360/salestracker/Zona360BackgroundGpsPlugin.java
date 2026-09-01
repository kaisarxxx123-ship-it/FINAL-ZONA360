package com.zona360.salestracker;

import android.Manifest;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;

import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

@CapacitorPlugin(
    name = "Zona360BackgroundGPS",
    permissions = {
        @Permission(
            alias = "location",
            strings = { Manifest.permission.ACCESS_COARSE_LOCATION, Manifest.permission.ACCESS_FINE_LOCATION }
        ),
        @Permission(
            alias = "backgroundLocation",
            strings = { Manifest.permission.ACCESS_BACKGROUND_LOCATION }
        ),
        @Permission(
            alias = "notifications",
            strings = { Manifest.permission.POST_NOTIFICATIONS }
        )
    }
)
public class Zona360BackgroundGpsPlugin extends Plugin {

    @PluginMethod
    public void start(PluginCall call) {
        if (!hasForegroundLocationPermission()) {
            requestPermissionForAlias("location", call, "foregroundLocationPermissionCallback");
            return;
        }

        requestOptionalPermissionsOrStart(call);
    }

    @PermissionCallback
    private void foregroundLocationPermissionCallback(PluginCall call) {
        if (!hasForegroundLocationPermission()) {
            call.reject("Izin lokasi ditolak. Tracking GPS belum dapat dimulai.");
            return;
        }
        requestOptionalPermissionsOrStart(call);
    }

    private void requestOptionalPermissionsOrStart(PluginCall call) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q
            && getPermissionState("backgroundLocation") != PermissionState.GRANTED) {
            requestPermissionForAlias("backgroundLocation", call, "backgroundLocationPermissionCallback");
            return;
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
            && getPermissionState("notifications") != PermissionState.GRANTED) {
            requestPermissionForAlias("notifications", call, "notificationPermissionCallback");
            return;
        }
        startService(call);
    }

    @PermissionCallback
    private void backgroundLocationPermissionCallback(PluginCall call) {
        if (getPermissionState("backgroundLocation") != PermissionState.GRANTED) {
            call.reject("Izin lokasi latar belakang diperlukan agar tracking tetap aktif saat aplikasi ditutup.");
            return;
        }
        requestOptionalPermissionsOrStart(call);
    }

    @PermissionCallback
    private void notificationPermissionCallback(PluginCall call) {
        // Android tetap dapat menjalankan foreground service tanpa izin notifikasi,
        // tetapi pengguna harus diberi tahu bahwa notifikasinya mungkin tersembunyi.
        startService(call);
    }

    private boolean hasForegroundLocationPermission() {
        return ContextCompat.checkSelfPermission(getContext(), Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
            || ContextCompat.checkSelfPermission(getContext(), Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED;
    }

    private void startService(PluginCall call) {

        String uid = call.getString("uid", "").trim();
        String idToken = call.getString("idToken", "").trim();
        String refreshToken = call.getString("refreshToken", "").trim();
        String apiKey = call.getString("apiKey", "").trim();
        String databaseUrl = call.getString("databaseUrl", "").trim();
        String root = call.getString("root", "zona360_v1").trim();
        String userName = call.getString("userName", "Sales").trim();
        long issuedAt = call.getLong("issuedAt", System.currentTimeMillis());
        long expiresIn = call.getLong("expiresIn", 3600L);

        if (uid.isEmpty() || idToken.isEmpty() || databaseUrl.isEmpty()) {
            call.reject("Session Firebase Sales belum lengkap. Login ulang.");
            return;
        }

        Intent intent = new Intent(getContext(), Zona360LocationService.class);
        intent.setAction(Zona360LocationService.ACTION_START);
        intent.putExtra("uid", uid);
        intent.putExtra("userName", userName);
        intent.putExtra("idToken", idToken);
        intent.putExtra("refreshToken", refreshToken);
        intent.putExtra("apiKey", apiKey);
        intent.putExtra("databaseUrl", databaseUrl);
        intent.putExtra("root", root);
        intent.putExtra("issuedAt", issuedAt);
        intent.putExtra("expiresIn", expiresIn);

        ContextCompat.startForegroundService(getContext(), intent);
        JSObject ret = new JSObject();
        ret.put("started", true);
        ret.put("mode", "foreground-location-service");
        ret.put("android", Build.VERSION.SDK_INT);
        call.resolve(ret);
    }

    @PluginMethod
    public void stop(PluginCall call) {
        Intent intent = new Intent(getContext(), Zona360LocationService.class);
        intent.setAction(Zona360LocationService.ACTION_STOP);
        getContext().startService(intent);
        JSObject ret = new JSObject();
        ret.put("stopped", true);
        call.resolve(ret);
    }

    @PluginMethod
    public void status(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("running", Zona360LocationService.isRunning());
        ret.put("mode", "foreground-location-service");
        call.resolve(ret);
    }
}
