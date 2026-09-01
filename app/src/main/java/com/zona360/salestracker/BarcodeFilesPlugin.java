package com.zona360.salestracker;

import android.Manifest;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Intent;
import android.media.MediaScannerConnection;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;

import androidx.core.content.FileProvider;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;
import java.util.Locale;

@CapacitorPlugin(
    name = "BarcodeFiles",
    permissions = {
        @Permission(alias = "legacyStorage", strings = { Manifest.permission.WRITE_EXTERNAL_STORAGE })
    }
)
public class BarcodeFilesPlugin extends Plugin {

    private byte[] decodePng(PluginCall call) {
        String raw = call.getString("base64", "");
        if (raw.startsWith("data:")) {
            int comma = raw.indexOf(',');
            if (comma >= 0) raw = raw.substring(comma + 1);
        }
        if (raw.trim().isEmpty()) throw new IllegalArgumentException("Data PNG kosong.");
        return Base64.decode(raw, Base64.DEFAULT);
    }

    private String safeName(String value) {
        String name = value == null ? "Barcode_Zona360.png" : value.trim();
        name = name.replaceAll("[^a-zA-Z0-9._-]+", "_");
        if (name.isEmpty()) name = "Barcode_Zona360.png";
        if (!name.toLowerCase(Locale.US).endsWith(".png")) name += ".png";
        return name.length() > 100 ? name.substring(0, 96) + ".png" : name;
    }

    @PluginMethod
    public void savePng(PluginCall call) {
        final byte[] bytes;
        try {
            bytes = decodePng(call);
        } catch (Exception error) {
            call.reject("PNG tidak valid: " + error.getMessage(), error);
            return;
        }
        final String fileName = safeName(call.getString("fileName", "Barcode_Zona360.png"));

        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                ContentValues values = new ContentValues();
                values.put(MediaStore.Images.Media.DISPLAY_NAME, fileName);
                values.put(MediaStore.Images.Media.MIME_TYPE, "image/png");
                values.put(MediaStore.Images.Media.RELATIVE_PATH, Environment.DIRECTORY_PICTURES + "/Zona360");
                values.put(MediaStore.Images.Media.IS_PENDING, 1);

                ContentResolver resolver = getContext().getContentResolver();
                Uri uri = resolver.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values);
                if (uri == null) throw new IllegalStateException("MediaStore tidak dapat membuat file.");
                try (OutputStream out = resolver.openOutputStream(uri, "w")) {
                    if (out == null) throw new IllegalStateException("Tidak dapat membuka file Gallery.");
                    out.write(bytes);
                    out.flush();
                } catch (Exception error) {
                    resolver.delete(uri, null, null);
                    throw error;
                }
                values.clear();
                values.put(MediaStore.Images.Media.IS_PENDING, 0);
                resolver.update(uri, values, null, null);

                JSObject ret = new JSObject();
                ret.put("saved", true);
                ret.put("fileName", fileName);
                ret.put("uri", uri.toString());
                ret.put("album", "Pictures/Zona360");
                call.resolve(ret);
                return;
            }

            if (getPermissionState("legacyStorage") != PermissionState.GRANTED) {
                requestPermissionForAlias("legacyStorage", call, "legacyStoragePermissionCallback");
                return;
            }
            File pictures = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_PICTURES);
            File folder = new File(pictures, "Zona360");
            if (!folder.exists() && !folder.mkdirs()) throw new IllegalStateException("Folder Pictures/Zona360 tidak dapat dibuat.");
            File outFile = new File(folder, fileName);
            try (FileOutputStream out = new FileOutputStream(outFile)) {
                out.write(bytes);
                out.flush();
            }
            MediaScannerConnection.scanFile(getContext(), new String[]{outFile.getAbsolutePath()}, new String[]{"image/png"}, null);
            JSObject ret = new JSObject();
            ret.put("saved", true);
            ret.put("fileName", fileName);
            ret.put("uri", Uri.fromFile(outFile).toString());
            ret.put("album", "Pictures/Zona360");
            call.resolve(ret);
        } catch (Exception error) {
            call.reject("Gagal menyimpan barcode: " + error.getMessage(), error);
        }
    }

    @PluginMethod
    public void sharePng(PluginCall call) {
        final byte[] bytes;
        try {
            bytes = decodePng(call);
        } catch (Exception error) {
            call.reject("PNG tidak valid: " + error.getMessage(), error);
            return;
        }
        String fileName = safeName(call.getString("fileName", "Barcode_Zona360.png"));
        String title = call.getString("title", "Bagikan Barcode Zona360");
        String text = call.getString("text", "");

        try {
            File dir = new File(getContext().getCacheDir(), "zona360-share");
            if (!dir.exists() && !dir.mkdirs()) throw new IllegalStateException("Cache share tidak dapat dibuat.");
            File file = new File(dir, fileName);
            try (FileOutputStream out = new FileOutputStream(file)) {
                out.write(bytes);
                out.flush();
            }

            Uri uri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", file);
            Intent share = new Intent(Intent.ACTION_SEND);
            share.setType("image/png");
            share.putExtra(Intent.EXTRA_STREAM, uri);
            if (text != null && !text.trim().isEmpty()) share.putExtra(Intent.EXTRA_TEXT, text);
            share.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            Intent chooser = Intent.createChooser(share, title);
            chooser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(chooser);

            JSObject ret = new JSObject();
            ret.put("shared", true);
            ret.put("uri", uri.toString());
            ret.put("mimeType", "image/png");
            call.resolve(ret);
        } catch (Exception error) {
            call.reject("Gagal membuka Share Sheet: " + error.getMessage(), error);
        }
    }
    @PermissionCallback
    private void legacyStoragePermissionCallback(PluginCall call) {
        if (getPermissionState("legacyStorage") != PermissionState.GRANTED) {
            call.reject("Izin penyimpanan ditolak. Barcode belum disimpan.");
            return;
        }
        savePng(call);
    }

}
