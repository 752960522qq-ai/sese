package studio.sese.pose;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;
import android.net.Uri;
import android.view.View;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicReference;
import org.json.JSONObject;

public final class StudioActivity extends Activity {
    private static final String HOST = "studio.sese.invalid";
    private static final int SAVE_DOCUMENT = 402, OPEN_DOCUMENT = 403;
    private static final int MAX_DOCUMENT = 24 * 1024 * 1024;
    private static final String IMPORT_PATH = "/__imported_scene/";
    private WebView studio;
    private final ExecutorService fileIO = Executors.newSingleThreadExecutor();
    private final AtomicReference<ImportedFile> imported = new AtomicReference<>();
    private volatile boolean pickingFile;
    private byte[] outgoing;

    private static final class ImportedFile {
        final String path = IMPORT_PATH + UUID.randomUUID();
        final byte[] bytes;
        ImportedFile(byte[] bytes) { this.bytes = bytes; }
    }

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
        studio.addJavascriptInterface(new SceneFiles(), "SeseSceneFiles");
        setContentView(studio);
        studio.loadUrl("https://" + HOST + "/index.html");
    }

    @Override public void onWindowFocusChanged(boolean focused) {
        super.onWindowFocusChanged(focused);
        if (focused) immersive();
    }

    @Override public void onPause() {
        if (studio != null) {
            studio.evaluateJavascript("if (window.studioPauseAudio) window.studioPauseAudio()", null);
            studio.onPause();
        }
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
        imported.set(null);
        fileIO.shutdown();
        if (studio != null) {
            studio.destroy();
            studio = null;
        }
        super.onDestroy();
    }

    public final class SceneFiles {
        private StringBuilder parts;
        private String name;

        @JavascriptInterface public synchronized boolean beginExport(String fileName) {
            if (pickingFile || fileName == null || fileName.length() > 100) return false;
            name = fileName;
            parts = new StringBuilder();
            return true;
        }
        @JavascriptInterface public synchronized boolean appendExport(String text) {
            if (parts == null || text == null || text.length() > 32768 ||
                parts.length() + text.length() > MAX_DOCUMENT) {
                parts = null;
                return false;
            }
            parts.append(text);
            return true;
        }
        @JavascriptInterface public synchronized void commitExport() {
            if (parts == null) return;
            byte[] data = parts.toString().getBytes(StandardCharsets.UTF_8);
            String title = name;
            parts = null;
            if (data.length > MAX_DOCUMENT) {
                announce("搭配文件超过 24 MB");
                return;
            }
            runOnUiThread(new Runnable() {
                @Override public void run() { chooseDocument(true, title, data); }
            });
        }
        @JavascriptInterface public void requestImport() {
            runOnUiThread(new Runnable() {
                @Override public void run() { chooseDocument(false, null, null); }
            });
        }
    }

    private void chooseDocument(boolean save, String name, byte[] data) {
        if (pickingFile || isFinishing() || isDestroyed()) return;
        pickingFile = true;
        outgoing = data;
        Intent intent = new Intent(save ? Intent.ACTION_CREATE_DOCUMENT : Intent.ACTION_OPEN_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType(save ? "application/json" : "*/*");
        if (save) intent.putExtra(Intent.EXTRA_TITLE, name);
        try {
            startActivityForResult(intent, save ? SAVE_DOCUMENT : OPEN_DOCUMENT);
        } catch (RuntimeException unavailable) {
            pickingFile = false;
            outgoing = null;
            announce("找不到系统文件选择器");
        }
    }

    @Override public void onActivityResult(int request, int result, Intent response) {
        super.onActivityResult(request, result, response);
        if (request != SAVE_DOCUMENT && request != OPEN_DOCUMENT) return;
        final byte[] payload = outgoing;
        outgoing = null;
        final Uri uri = result == RESULT_OK && response != null ? response.getData() : null;
        if (uri == null) { pickingFile = false; return; }
        fileIO.execute(new Runnable() {
            @Override public void run() {
                try {
                    if (request == SAVE_DOCUMENT) {
                        if (payload == null) throw new IOException("No staged data");
                        try (OutputStream out = getContentResolver().openOutputStream(uri, "w")) {
                            if (out == null) throw new IOException("No output stream");
                            out.write(payload);
                        }
                        announce("已导出搭配文件");
                    } else {
                        ImportedFile file = new ImportedFile(readDocument(uri));
                        imported.set(file);
                        evaluate("if (window.studioReadScene) window.studioReadScene(" + JSONObject.quote(file.path) + ")");
                    }
                } catch (IOException | RuntimeException badFile) {
                    announce(request == SAVE_DOCUMENT ? "无法写入搭配文件" : "无法读取搭配文件，大小上限为 24 MB");
                } finally {
                    pickingFile = false;
                }
            }
        });
    }

    private byte[] readDocument(Uri uri) throws IOException {
        try (InputStream in = getContentResolver().openInputStream(uri);
             ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            if (in == null) throw new IOException("No input stream");
            byte[] block = new byte[32768];
            int count;
            while ((count = in.read(block)) != -1) {
                if (out.size() + count > MAX_DOCUMENT) throw new IOException("Document too large");
                out.write(block, 0, count);
            }
            return out.toByteArray();
        }
    }

    private void announce(String message) {
        evaluate("if (window.studioFileNotice) window.studioFileNotice(" + JSONObject.quote(message) + ")");
    }
    private void evaluate(String javascript) {
        runOnUiThread(new Runnable() {
            @Override public void run() {
                if (studio != null && !isDestroyed()) studio.evaluateJavascript(javascript, null);
            }
        });
    }

    private static String type(String path) {
        if (path.endsWith(".html")) return "text/html";
        if (path.endsWith(".js")) return "application/javascript";
        if (path.endsWith(".css")) return "text/css";
        if (path.endsWith(".json") || path.endsWith(".gltf")) return "application/json";
        if (path.endsWith(".png")) return "image/png";
        if (path.endsWith(".jpg")) return "image/jpeg";
        if (path.endsWith(".svg")) return "image/svg+xml";
        if (path.endsWith(".wav")) return "audio/wav";
        if (path.endsWith(".glb")) return "model/gltf-binary";
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
            if (path.startsWith(IMPORT_PATH)) {
                ImportedFile file = imported.get();
                if (file == null || !file.path.equals(path) || !imported.compareAndSet(file, null)) return missing();
                return new WebResourceResponse("application/json", "UTF-8", 200, "OK",
                    Collections.singletonMap("Cache-Control", "no-store"), new ByteArrayInputStream(file.bytes));
            }
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
