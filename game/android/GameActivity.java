package studio.sese.citygame;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.view.View;
import android.webkit.*;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.Collections;

public final class GameActivity extends Activity {
    private static final String HOST = "city.sese.invalid";
    private static final int OPEN_FILES = 17;
    private WebView game;
    private ValueCallback<Uri[]> pending;
    private boolean isLocal(Uri u) {
        return "https".equals(u.getScheme()) && HOST.equals(u.getHost()) && u.getPort() == -1;
    }
    private void immersive() {
        getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY |
            View.SYSTEM_UI_FLAG_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_FULLSCREEN |
            View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_LAYOUT_STABLE);
    }
    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        immersive();
        game = new WebView(this);
        game.setBackgroundColor(0xff18282c);
        WebSettings settings = game.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(true);
        settings.setUseWideViewPort(true);
        settings.setLoadWithOverviewMode(true);
        settings.setTextZoom(100);
        game.setWebViewClient(new LocalContent());
        game.setWebChromeClient(new WebChromeClient() {
            @Override public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (pending != null) pending.onReceiveValue(null);
                pending = callback;
                Intent open = new Intent(Intent.ACTION_OPEN_DOCUMENT);
                open.addCategory(Intent.CATEGORY_OPENABLE);
                open.setType("*/*");
                open.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
                try { startActivityForResult(open, OPEN_FILES); }
                catch (android.content.ActivityNotFoundException e) {
                    pending.onReceiveValue(null); pending = null;
                    game.evaluateJavascript("window.cityNotice?.('系统文件选择器不可用')", null);
                }
                return true;
            }
        });
        setContentView(game);
        game.loadUrl("https://" + HOST + "/index.html");
    }
    @Override protected void onActivityResult(int request, int result, Intent data) {
        super.onActivityResult(request, result, data);
        if (request != OPEN_FILES || pending == null) return;
        ArrayList<Uri> items = new ArrayList<>();
        if (result == RESULT_OK && data != null) {
            if (data.getClipData() != null) {
                for (int i = 0; i < data.getClipData().getItemCount(); i++) {
                    Uri uri = data.getClipData().getItemAt(i).getUri();
                    if (uri != null && "content".equals(uri.getScheme())) items.add(uri);
                }
            } else if (data.getData() != null && "content".equals(data.getData().getScheme())) items.add(data.getData());
        }
        pending.onReceiveValue(items.isEmpty() ? null : items.toArray(new Uri[0]));
        pending = null;
    }
    @Override public void onWindowFocusChanged(boolean focused){super.onWindowFocusChanged(focused);if(focused)immersive();}
    @Override public void onPause(){if(game!=null){game.evaluateJavascript("window.citySuspend?.()",null);game.onPause();}super.onPause();}
    @Override public void onResume(){super.onResume();if(game!=null)game.onResume();}
    @Override public void onBackPressed(){
        if(game==null){super.onBackPressed();return;}
        game.evaluateJavascript("Boolean(window.cityBack && window.cityBack())", new ValueCallback<String>() { @Override public void onReceiveValue(String value) { if(!"true".equals(value))finish(); } });
    }
    @Override protected void onDestroy(){
        if(pending!=null)pending.onReceiveValue(null);
        pending=null;if(game!=null){game.destroy();game=null;}super.onDestroy();
    }
    private static String mime(String path) {
        if(path.endsWith(".js"))return "application/javascript";
        if(path.endsWith(".html"))return "text/html";
        if(path.endsWith(".css"))return "text/css";
        if(path.endsWith(".json")||path.endsWith(".gltf"))return "application/json";
        if(path.endsWith(".png"))return "image/png";
        if(path.endsWith(".jpg"))return "image/jpeg";
        if(path.endsWith(".glb"))return "model/gltf-binary";
        if(path.endsWith(".wav"))return "audio/wav";
        return "application/octet-stream";
    }
    private WebResourceResponse missing(){
        return new WebResourceResponse("text/plain","UTF-8",404,"Not Found",Collections.emptyMap(),new ByteArrayInputStream(new byte[0]));
    }
    private final class LocalContent extends WebViewClient {
        @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest r){return !isLocal(r.getUrl());}
        @Override public WebResourceResponse shouldInterceptRequest(WebView view,WebResourceRequest r){
            Uri uri=r.getUrl();
            if(!isLocal(uri)||!"GET".equals(r.getMethod()))return missing();
            String path=uri.getPath();
            if(path==null||!path.startsWith("/")||path.contains("..")||path.contains("\\"))return missing();
            if(path.equals("/"))path="/index.html";
            try{
                InputStream stream=getAssets().open(path.substring(1));
                String type=mime(path);
                return new WebResourceResponse(type,type.startsWith("text/")||type.contains("json")||type.contains("javascript")?"UTF-8":null,stream);
            }catch(IOException e){return missing();}
        }
    }
}
