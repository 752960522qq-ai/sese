package studio.sese.pose;

import android.app.Activity;
import android.os.Bundle;
import android.net.Uri;
import android.view.View;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.Collections;

public final class StudioActivity extends Activity {
    private static final String HOST = "studio.sese.invalid";
    private WebView studio;

    private void immersive() {
        getWindow().getDecorView().setSystemUiVisibility(
            View.SYSTEM_UI_FLAG_FULLSCREEN | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION |
            View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY | View.SYSTEM_UI_FLAG_LAYOUT_STABLE |
            View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN);
    }

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        immersive();
        studio = new WebView(this);
        studio.setBackgroundColor(0xff172327);
        WebSettings settings = studio.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setLoadWithOverviewMode(true);
        settings.setUseWideViewPort(true);
        settings.setTextZoom(100);
        studio.setWebViewClient(new PackagedAssets());
        setContentView(studio);
        studio.loadUrl("https://" + HOST + "/index.html");
    }

    @Override public void onWindowFocusChanged(boolean focused) {
        super.onWindowFocusChanged(focused);
        if (focused) immersive();
    }

    @Override public void onPause() {
        if (studio != null) studio.onPause();
        super.onPause();
    }
    @Override public void onResume() {
        super.onResume();
        if (studio != null) studio.onResume();
    }
    @Override public void onBackPressed() {
        if (studio == null) { super.onBackPressed(); return; }
        studio.evaluateJavascript("window.studioBack ? window.studioBack() : false",
            new android.webkit.ValueCallback<String>() {
                @Override public void onReceiveValue(String handled) {
                    if (!"true".equals(handled)) finish();
                }
            });
    }
    @Override public void onDestroy() {
        if (studio != null) studio.destroy();
        super.onDestroy();
    }

    private static String type(String path) {
        if (path.endsWith(".html")) return "text/html";
        if (path.endsWith(".js")) return "application/javascript";
        if (path.endsWith(".css")) return "text/css";
        if (path.endsWith(".json") || path.endsWith(".gltf")) return "application/json";
        if (path.endsWith(".png")) return "image/png";
        if (path.endsWith(".jpg")) return "image/jpeg";
        if (path.endsWith(".svg")) return "image/svg+xml";
        return "application/octet-stream";
    }
    private static WebResourceResponse missing() {
        return new WebResourceResponse("text/plain", "UTF-8", 404, "Not Found",
            Collections.emptyMap(), new ByteArrayInputStream(new byte[0]));
    }

    private final class PackagedAssets extends WebViewClient {
        @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            Uri uri = request.getUrl();
            return !("https".equals(uri.getScheme()) && HOST.equals(uri.getHost()));
        }
        @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
            Uri uri = request.getUrl();
            if (!"https".equals(uri.getScheme()) || !HOST.equals(uri.getHost()) ||
                !"GET".equals(request.getMethod())) return missing();
            String path = uri.getPath();
            if (path == null || !path.startsWith("/") || path.contains("..") || path.contains("\\")) return missing();
            if (path.equals("/")) path = "/index.html";
            try {
                InputStream stream = getAssets().open(path.substring(1));
                String mime = type(path);
                String encoding = (mime.startsWith("text/") || mime.equals("application/javascript") ||
                                   mime.equals("application/json")) ? "UTF-8" : null;
                return new WebResourceResponse(mime, encoding, stream);
            } catch (IOException unavailable) {
                return missing();
            }
        }
    }
}
