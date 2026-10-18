package app.fintrack.personal;

import android.content.ContentValues;
import android.content.Context;
import android.content.SharedPreferences;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteOpenHelper;
import org.json.JSONArray;
import org.json.JSONObject;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Instant;
import java.util.UUID;

final class BankQueue extends SQLiteOpenHelper {
    static final String BANK_PACKAGE = "ru.wildberries.bank";
    private static BankQueue instance;

    static synchronized BankQueue get(Context context) {
        if (instance == null) instance = new BankQueue(context.getApplicationContext());
        return instance;
    }

    static SharedPreferences settings(Context context) {
        return context.getSharedPreferences("wb_autoimport", Context.MODE_PRIVATE);
    }

    private BankQueue(Context context) { super(context, "wb_notifications.db", null, 1); }

    @Override public void onCreate(SQLiteDatabase db) {
        db.execSQL("CREATE TABLE events(id TEXT PRIMARY KEY, identity TEXT NOT NULL UNIQUE, profile_id TEXT NOT NULL, wallet_id TEXT NOT NULL, server TEXT NOT NULL, text TEXT NOT NULL, posted_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', error TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL)");
        db.execSQL("CREATE TABLE active(notification_key TEXT PRIMARY KEY, body_hash TEXT NOT NULL, identity TEXT NOT NULL)");
    }

    @Override public void onUpgrade(SQLiteDatabase db, int oldVersion, int newVersion) { }

    static String hash(String value) throws Exception {
        byte[] digest = MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8));
        StringBuilder result = new StringBuilder(64);
        for (byte b : digest) result.append(String.format(java.util.Locale.ROOT, "%02x", b & 255));
        return result.toString();
    }

    synchronized void capture(Context context, String key, long when, long posted, String text) throws Exception {
        SharedPreferences config = settings(context);
        if (!config.getBoolean("enabled", false)) return;
        long time = when > 0 ? when : posted;
        if (time < config.getLong("started_at", Long.MAX_VALUE)) return;
        SQLiteDatabase db = getWritableDatabase();
        String bodyHash = hash(text);
        String identity = hash(key + "|" + (when > 0 ? when : posted));
        db.beginTransaction();
        try {
            if (when <= 0) {
                try (Cursor active = db.rawQuery("SELECT body_hash,identity FROM active WHERE notification_key=?", new String[]{key})) {
                    if (active.moveToFirst() && bodyHash.equals(active.getString(0))) identity = active.getString(1);
                }
            }
            ContentValues row = new ContentValues();
            row.put("id", UUID.randomUUID().toString()); row.put("identity", identity);
            row.put("profile_id", config.getString("profile_id", "")); row.put("wallet_id", config.getString("wallet_id", ""));
            row.put("server", config.getString("server", "")); row.put("text", text);
            row.put("posted_at", Instant.ofEpochMilli(time).toString()); row.put("created_at", System.currentTimeMillis());
            db.insertWithOnConflict("events", null, row, SQLiteDatabase.CONFLICT_IGNORE);
            ContentValues active = new ContentValues(); active.put("notification_key", key); active.put("body_hash", bodyHash); active.put("identity", identity);
            db.insertWithOnConflict("active", null, active, SQLiteDatabase.CONFLICT_REPLACE);
            db.setTransactionSuccessful();
        } finally { db.endTransaction(); }
    }

    synchronized void removed(String key) { getWritableDatabase().delete("active", "notification_key=?", new String[]{key}); }

    synchronized JSONObject next() throws Exception {
        try (Cursor cursor = getReadableDatabase().rawQuery("SELECT * FROM events WHERE status='pending' ORDER BY created_at,id LIMIT 1", null)) {
            return cursor.moveToFirst() ? object(cursor) : null;
        }
    }

    synchronized void update(String id, String status, String error) {
        ContentValues row = new ContentValues(); row.put("status", status); row.put("error", error);
        getWritableDatabase().update("events", row, "id=?", new String[]{id});
    }

    synchronized JSONObject snapshot() throws Exception {
        JSONObject result = new JSONObject();
        try (Cursor count = getReadableDatabase().rawQuery("SELECT status,count(*) FROM events GROUP BY status", null)) {
            while (count.moveToNext()) result.put(count.getString(0), count.getInt(1));
        }
        JSONArray events = new JSONArray();
        try (Cursor cursor = getReadableDatabase().rawQuery("SELECT * FROM events ORDER BY created_at DESC,id DESC LIMIT 30", null)) {
            while (cursor.moveToNext()) {
                JSONObject row = object(cursor); row.remove("identity"); events.put(row);
            }
        }
        result.put("items", events);
        return result;
    }

    private static JSONObject object(Cursor cursor) throws Exception {
        JSONObject row = new JSONObject();
        for (String name : cursor.getColumnNames()) row.put(name, cursor.getString(cursor.getColumnIndexOrThrow(name)));
        return row;
    }
}
