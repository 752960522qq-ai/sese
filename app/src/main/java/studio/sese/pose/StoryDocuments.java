package studio.sese.pose;

import android.app.Activity;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.provider.DocumentsContract;
import android.provider.OpenableColumns;
import android.util.Base64;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebView;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import org.json.JSONObject;

public final class StoryDocuments extends WebChromeClient {
    private static final int OPEN = 451, DIRECTORY = 452, DOCUMENT = 453;
    private final StudioActivity host;
    private final ExecutorService io;
    private ValueCallback<Uri[]> picker;
    private File temp;
    private FileOutputStream stream;
    private long remaining;
    private final List<File> files = new ArrayList<>();
    private String title, mode;
    private boolean choosing, writing;
    StoryDocuments(StudioActivity host, ExecutorService io) {
        this.host = host;
        this.io = io;
    }
    @Override public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
        if (picker != null) picker.onReceiveValue(null);
        picker = callback;
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("*/*");
        intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
        try { host.startActivityForResult(intent, OPEN); }
        catch (RuntimeException unavailable) { picker.onReceiveValue(null); picker = null; }
        return true;
    }
    private static boolean safe(String name) {
        return name != null && name.length() > 0 && name.length() <= 180 &&
            !name.equals(".") && !name.equals("..") && !name.matches(".*[\\x00-\\x1f/\\\\<>:\"|?*#].*");
    }
    @JavascriptInterface public synchronized boolean begin(String choice, String name) {
        if (choosing || temp != null || !safe(name) || !("folder".equals(choice) || "single".equals(choice))) return false;
        File root = new File(host.getCacheDir(), "story-out");
        File dir = new File(root, UUID.randomUUID().toString());
        if (!dir.mkdirs()) return false;
        temp = dir; mode = choice; title = name;
        return true;
    }
    @JavascriptInterface public synchronized boolean openFile(String name, long size) {
        if (temp == null || choosing || stream != null || !safe(name) || size < 0 || size > 384L * 1024 * 1024) return false;
        try {
            File f = new File(temp, name);
            if (!f.createNewFile()) return false;
            files.add(f); stream = new FileOutputStream(f); remaining = size;
            return true;
        } catch (IOException e) { return false; }
    }
    @JavascriptInterface public synchronized boolean append(String encoded) {
        if (stream == null || encoded == null || encoded.length() > 65536) return false;
        try {
            byte[] block = Base64.decode(encoded, Base64.NO_WRAP);
            if (block.length > remaining) return false;
            stream.write(block); remaining -= block.length;
            return true;
        } catch (IOException | IllegalArgumentException e) { return false; }
    }
    @JavascriptInterface public synchronized boolean closeFile() {
        if (stream == null) return false;
        try { stream.close(); return remaining == 0; }
        catch (IOException e) { return false; }
        finally { stream = null; }
    }
    private static String mime(String name) {
        if (name.endsWith(".zip")) return "application/zip";
        if (name.endsWith(".glb")) return "model/gltf-binary";
        return "application/json";
    }
    @JavascriptInterface public synchronized boolean choose() {
        if (choosing || files.isEmpty() || stream != null || ("single".equals(mode) && files.size() != 1)) return false;
        choosing = true;
        final boolean folder = "folder".equals(mode);
        final String filename = title;
        host.runOnUiThread(new Runnable() { @Override public void run() {
            Intent i = new Intent(folder ? Intent.ACTION_OPEN_DOCUMENT_TREE : Intent.ACTION_CREATE_DOCUMENT);
            if (!folder) i.addCategory(Intent.CATEGORY_OPENABLE).setType(mime(filename)).putExtra(Intent.EXTRA_TITLE, filename);
            try { host.startActivityForResult(i, folder ? DIRECTORY : DOCUMENT); }
            catch (RuntimeException e) { complete(false, "无法打开系统文件选择器"); }
        }});
        return true;
    }
    @JavascriptInterface public synchronized void cancel() { if (!choosing) clear(); }
    @JavascriptInterface public boolean launchGame() {
        final Intent game = host.getPackageManager().getLaunchIntentForPackage("studio.sese.citygame");
        if (game == null) return false;
        host.runOnUiThread(new Runnable() { @Override public void run() { host.startActivity(game); } });
        return true;
    }
    boolean result(int request, int result, Intent data) {
        if (request == OPEN) {
            if (picker == null) return true;
            ArrayList<Uri> uris = new ArrayList<>();
            if (result == Activity.RESULT_OK && data != null) {
                if (data.getClipData() != null) {
                    for (int i = 0; i < data.getClipData().getItemCount(); i++) add(uris, data.getClipData().getItemAt(i).getUri());
                } else add(uris, data.getData());
            }
            picker.onReceiveValue(uris.isEmpty() ? null : uris.toArray(new Uri[0]));
            picker = null; return true;
        }
        if (request != DIRECTORY && request != DOCUMENT) return false;
        final Uri dest = result == Activity.RESULT_OK && data != null ? data.getData() : null;
        final List<File> staged;
        final String folder;
        synchronized (this) {
            if (!choosing) return true;
            staged = new ArrayList<>(files); folder = title;
        }
        if (dest == null) { complete(false, "已取消导出"); return true; }
        synchronized (this) { writing = true; }
        io.execute(new Runnable() { @Override public void run() {
            Uri dir = null;
            try {
                if (request == DOCUMENT) {
                    write(staged.get(0), dest);
                    complete(true, "已导出 " + name(dest));
                } else {
                    Uri parent = DocumentsContract.buildDocumentUriUsingTree(dest, DocumentsContract.getTreeDocumentId(dest));
                    dir = DocumentsContract.createDocument(host.getContentResolver(), parent, DocumentsContract.Document.MIME_TYPE_DIR, folder);
                    if (dir == null) throw new IOException("无法创建目录");
                    for (File f : staged) {
                        Uri target = DocumentsContract.createDocument(host.getContentResolver(), dir, mime(f.getName()), f.getName());
                        if (target == null || !f.getName().equals(name(target))) throw new IOException("此目录无法保留动作文件名");
                        write(f, target);
                    }
                    complete(true, "已写入「" + name(dir) + "」共 " + staged.size() + " 个文件。在主游戏的「关卡与动作」一起导入。");
                }
            } catch (IOException | RuntimeException e) {
                if (dir != null) try { DocumentsContract.deleteDocument(host.getContentResolver(), dir); } catch (Exception ignored) {}
                complete(false, "导出失败，请检查目录权限和可用空间。" + (e.getMessage() == null ? "" : e.getMessage()));
            }
        }});
        return true;
    }
    private static void add(List<Uri> uris, Uri u) { if (u != null && "content".equals(u.getScheme())) uris.add(u); }
    private String name(Uri uri) throws IOException {
        try (Cursor c = host.getContentResolver().query(uri, new String[]{OpenableColumns.DISPLAY_NAME}, null, null, null)) {
            if (c != null && c.moveToFirst()) return c.getString(0);
        }
        throw new IOException("无法读取导出名称");
    }
    private void write(File f, Uri target) throws IOException {
        try (FileInputStream input = new FileInputStream(f);
             OutputStream output = host.getContentResolver().openOutputStream(target, "wt")) {
            if (output == null) throw new IOException("无法写入文件");
            byte[] block = new byte[65536]; int count;
            while ((count = input.read(block)) != -1) output.write(block, 0, count);
        }
    }
    private synchronized void clear() {
        if (stream != null) try { stream.close(); } catch (IOException ignored) {}
        stream = null;
        for (File f : files) f.delete();
        files.clear(); if (temp != null) temp.delete(); temp = null;
        choosing = false; writing = false;
    }
    private synchronized void complete(boolean success, String message) {
        clear();
        host.evaluate("window.storyExportResult?.(" + success + "," + JSONObject.quote(message) + ")");
    }
    void release() {
        if (picker != null) { picker.onReceiveValue(null); picker = null; }
        synchronized (this) { if (!writing) clear(); }
    }
}
