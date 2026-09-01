package com.zona360.salestracker;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;

import androidx.activity.result.ActivityResult;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import com.journeyapps.barcodescanner.ScanContract;
import com.journeyapps.barcodescanner.ScanIntentResult;
import com.journeyapps.barcodescanner.ScanOptions;

@CapacitorPlugin(
    name = "CapacitorBarcodeScanner",
    permissions = {
        @Permission(alias = "camera", strings = { Manifest.permission.CAMERA })
    }
)
public class Zona360BarcodeScannerPlugin extends Plugin {

    @PluginMethod
    public void scanBarcode(PluginCall call) {
        if (getPermissionState("camera") != PermissionState.GRANTED) {
            requestPermissionForAlias("camera", call, "cameraPermissionCallback");
            return;
        }
        openScanner(call);
    }

    @PermissionCallback
    private void cameraPermissionCallback(PluginCall call) {
        if (getPermissionState("camera") != PermissionState.GRANTED) {
            call.reject("Permission kamera ditolak. Izinkan Kamera untuk scan barcode toko.");
            return;
        }
        openScanner(call);
    }

    private void openScanner(PluginCall call) {
        ScanOptions options = new ScanOptions();
        options.setDesiredBarcodeFormats(ScanOptions.QR_CODE);
        options.setPrompt(call.getString("scanInstructions", "Arahkan kamera ke QR toko Zona360"));
        options.setBeepEnabled(false);
        options.setOrientationLocked(true);
        options.setCaptureActivity(PortraitCaptureActivity.class);
        options.setBarcodeImageEnabled(false);
        Intent intent = options.createScanIntent(getContext());
        startActivityForResult(call, intent, "scanFinished");
    }

    @ActivityCallback
    private void scanFinished(PluginCall call, ActivityResult activityResult) {
        if (call == null) return;
        Intent data = activityResult.getData();
        ScanIntentResult result = new ScanContract().parseResult(activityResult.getResultCode(), data);
        JSObject ret = new JSObject();
        if (activityResult.getResultCode() == Activity.RESULT_OK && result != null && result.getContents() != null) {
            ret.put("ScanResult", result.getContents());
        } else {
            ret.put("ScanResult", "");
        }
        call.resolve(ret);
    }
}
