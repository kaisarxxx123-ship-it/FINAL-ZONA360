package com.zona360.salestracker;

import android.Manifest;
import android.location.Location;
import android.os.Looper;

import androidx.core.content.ContextCompat;
import android.content.pm.PackageManager;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.google.android.gms.location.FusedLocationProviderClient;
import com.google.android.gms.location.LocationCallback;
import com.google.android.gms.location.LocationRequest;
import com.google.android.gms.location.LocationResult;
import com.google.android.gms.location.LocationServices;
import com.google.android.gms.location.Priority;

import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

@CapacitorPlugin(
    name = "Geolocation",
    permissions = {
        @Permission(
            alias = "location",
            strings = { Manifest.permission.ACCESS_COARSE_LOCATION, Manifest.permission.ACCESS_FINE_LOCATION }
        )
    }
)
public class Zona360GeolocationPlugin extends Plugin {
    private FusedLocationProviderClient fused;
    private final Map<String, LocationCallback> watchers = new ConcurrentHashMap<>();

    @Override
    public void load() {
        fused = LocationServices.getFusedLocationProviderClient(getContext());
    }

    private boolean hasLocationPermission() {
        // Coarse location is sufficient for a position. Checking the Android grants
        // directly avoids treating a partially granted coarse/fine group as denied.
        return ContextCompat.checkSelfPermission(getContext(), Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
            || ContextCompat.checkSelfPermission(getContext(), Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED;
    }

    private JSObject toPosition(Location location) {
        JSObject coords = new JSObject();
        coords.put("latitude", location.getLatitude());
        coords.put("longitude", location.getLongitude());
        coords.put("accuracy", location.hasAccuracy() ? location.getAccuracy() : 0d);
        coords.put("altitude", location.hasAltitude() ? location.getAltitude() : null);
        coords.put("altitudeAccuracy", null);
        coords.put("speed", location.hasSpeed() ? location.getSpeed() : null);
        coords.put("heading", location.hasBearing() ? location.getBearing() : null);

        JSObject result = new JSObject();
        result.put("coords", coords);
        result.put("timestamp", location.getTime() > 0 ? location.getTime() : System.currentTimeMillis());
        return result;
    }

    @PluginMethod
    public void getCurrentPosition(PluginCall call) {
        if (!hasLocationPermission()) {
            call.reject("Permission lokasi belum diberikan.");
            return;
        }
        try {
            fused.getCurrentLocation(Priority.PRIORITY_HIGH_ACCURACY, null)
                .addOnSuccessListener(location -> {
                    if (location == null) call.reject("GPS belum memberikan posisi. Pastikan lokasi HP aktif.");
                    else call.resolve(toPosition(location));
                })
                .addOnFailureListener(error -> call.reject("Gagal membaca GPS: " + error.getMessage(), error));
        } catch (SecurityException error) {
            call.reject("Permission lokasi tidak tersedia.", error);
        }
    }

    @PluginMethod(returnType = PluginMethod.RETURN_CALLBACK)
    public void watchPosition(PluginCall call) {
        if (!hasLocationPermission()) {
            call.reject("Permission lokasi belum diberikan.");
            return;
        }

        long interval = Math.max(1500L, call.getLong("minimumUpdateInterval", 2500L));
        LocationRequest request = new LocationRequest.Builder(Priority.PRIORITY_HIGH_ACCURACY, interval)
            .setMinUpdateIntervalMillis(Math.min(interval, 1500L))
            .setWaitForAccurateLocation(false)
            .build();

        call.setKeepAlive(true);
        final String callbackId = call.getCallbackId();
        LocationCallback callback = new LocationCallback() {
            @Override
            public void onLocationResult(LocationResult locationResult) {
                Location location = locationResult.getLastLocation();
                if (location != null) call.resolve(toPosition(location));
            }
        };
        watchers.put(callbackId, callback);

        try {
            fused.requestLocationUpdates(request, callback, Looper.getMainLooper())
                .addOnFailureListener(error -> {
                    watchers.remove(callbackId);
                    call.reject("Tracking GPS gagal: " + error.getMessage(), error);
                });
        } catch (SecurityException error) {
            watchers.remove(callbackId);
            call.reject("Permission lokasi tidak tersedia.", error);
        }
    }

    @PluginMethod
    public void clearWatch(PluginCall call) {
        String id = call.getString("id", "");
        LocationCallback callback = watchers.remove(id);
        if (callback != null) fused.removeLocationUpdates(callback);
        PluginCall saved = bridge.getSavedCall(id);
        if (saved != null) bridge.releaseCall(saved);
        call.resolve();
    }

    @Override
    protected void handleOnDestroy() {
        for (LocationCallback callback : watchers.values()) fused.removeLocationUpdates(callback);
        watchers.clear();
        super.handleOnDestroy();
    }
}
