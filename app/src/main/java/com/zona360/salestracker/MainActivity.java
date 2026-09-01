package com.zona360.salestracker;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Register local/custom Capacitor plugins before BridgeActivity creates the bridge.
        registerPlugin(Zona360GeolocationPlugin.class);
        registerPlugin(Zona360BarcodeScannerPlugin.class);
        registerPlugin(BarcodeFilesPlugin.class);
        registerPlugin(Zona360BackgroundGpsPlugin.class);

        // Let Android place the WebView below system bars. This is more stable on
        // real devices than manual WebView padding and prevents the mobile header
        // and page title from being clipped under the status bar.
        androidx.core.view.WindowCompat.setDecorFitsSystemWindows(getWindow(), true);

        super.onCreate(savedInstanceState);
    }
}
