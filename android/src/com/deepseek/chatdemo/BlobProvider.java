package com.deepseek.chatdemo;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.provider.OpenableColumns;

import java.io.File;
import java.io.FileNotFoundException;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * 把页面导出的 Blob（会话 ZIP、附件原件）以 content:// 暴露给其他应用。
 *
 * 系统没有内置 FileProvider 的等价物（那属于 AndroidX），这里只实现
 * openFile / getType / query 三项查看器取文件所必需的能力。
 * 文件按 token 登记，只在本次进程内有效。
 */
public final class BlobProvider extends ContentProvider {

    public static final String AUTHORITY = "com.deepseek.chatdemo.blobprovider";

    public static final class Entry {
        final File file;
        final String mime;
        final String name;

        Entry(File file, String mime, String name) {
            this.file = file;
            this.mime = mime;
            this.name = name;
        }
    }

    private static final Map<String, Entry> ENTRIES = new ConcurrentHashMap<>();

    public static Uri uriFor(String token) {
        return new Uri.Builder().scheme("content").authority(AUTHORITY)
                .appendPath("blob").appendPath(token).build();
    }

    static void register(String token, File file, String mime, String name) {
        ENTRIES.put(token, new Entry(file, mime, name));
    }

    /** 供系统相机写入：注册一个尚未存在的临时文件，走 openFile 的写模式 */
    static void registerWritable(String token, File file, String mime, String name) {
        ENTRIES.put(token, new Entry(file, mime, name));
    }

    @Override
    public boolean onCreate() {
        return true;
    }

    private Entry entry(Uri uri) {
        if (uri.getPathSegments().size() < 2) {
            return null;
        }
        return ENTRIES.get(uri.getPathSegments().get(1));
    }

    @Override
    public ParcelFileDescriptor openFile(Uri uri, String mode) throws FileNotFoundException {
        Entry entry = entry(uri);
        if (entry == null) {
            throw new FileNotFoundException("Unknown blob: " + uri);
        }
        // 相机写入时文件尚未创建；读模式要求文件已存在
        if (!entry.file.exists() && !"w".equals(mode) && !"rw".equals(mode) && !"rwt".equals(mode)) {
            throw new FileNotFoundException("Unknown blob: " + uri);
        }
        int flags = ParcelFileDescriptor.MODE_CREATE
                | ("w".equals(mode) || "rw".equals(mode) || "rwt".equals(mode)
                    ? ParcelFileDescriptor.MODE_WRITE_ONLY | ParcelFileDescriptor.MODE_TRUNCATE
                    : ParcelFileDescriptor.MODE_READ_ONLY);
        return ParcelFileDescriptor.open(entry.file, flags);
    }

    @Override
    public String getType(Uri uri) {
        Entry entry = entry(uri);
        return entry == null ? null : entry.mime;
    }

    @Override
    public Cursor query(Uri uri, String[] projection, String selection, String[] selectionArgs,
                        String sortOrder) {
        Entry entry = entry(uri);
        if (entry == null) {
            return null;
        }
        String[] columns = {OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE};
        MatrixCursor cursor = new MatrixCursor(columns, 1);
        cursor.addRow(new Object[]{entry.name, entry.file.length()});
        return cursor;
    }

    @Override
    public Uri insert(Uri uri, ContentValues values) {
        throw new UnsupportedOperationException();
    }

    @Override
    public int delete(Uri uri, String selection, String[] selectionArgs) {
        throw new UnsupportedOperationException();
    }

    @Override
    public int update(Uri uri, ContentValues values, String selection, String[] selectionArgs) {
        throw new UnsupportedOperationException();
    }
}
