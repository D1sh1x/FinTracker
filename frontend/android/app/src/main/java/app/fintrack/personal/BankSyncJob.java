package app.fintrack.personal;

import android.app.job.JobInfo;
import android.app.job.JobParameters;
import android.app.job.JobScheduler;
import android.app.job.JobService;
import android.content.ComponentName;
import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import android.util.Base64;
import org.json.JSONObject;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public final class BankSyncJob extends JobService {
    private static final int IMMEDIATE = 70551;
    private static final int PERIODIC = 70552;
    private Run active;

    static void schedule(Context context, boolean periodic) {
        if (!BankQueue.settings(context).getBoolean("enabled", false)) return;
        JobScheduler scheduler = context.getSystemService(JobScheduler.class);
        JobInfo.Builder job = new JobInfo.Builder(periodic ? PERIODIC : IMMEDIATE, new ComponentName(context, BankSyncJob.class))
            .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY).setPersisted(true)
            .setBackoffCriteria(30_000, JobInfo.BACKOFF_POLICY_EXPONENTIAL);
        if (periodic) job.setPeriodic(15 * 60_000); else job.setMinimumLatency(0);
        if (scheduler.schedule(job.build()) != JobScheduler.RESULT_SUCCESS) {
            BankQueue.settings(context).edit().putString("listener_error", "Android не разрешил фоновую отправку. Откройте приложение и повторите.").apply();
        }
    }

    static void pause(Context context) {
        JobScheduler scheduler = context.getSystemService(JobScheduler.class);
        scheduler.cancel(IMMEDIATE); scheduler.cancel(PERIODIC);
    }

    @Override public boolean onStartJob(JobParameters parameters) {
        if (active != null) return false;
        active = new Run(parameters);
        active.start();
        return true;
    }

    private final class Run {
        private final JobParameters parameters;
        private final ExecutorService executor = Executors.newSingleThreadExecutor();
        private volatile boolean stopped;
        private volatile HttpURLConnection connection;

        Run(JobParameters parameters) { this.parameters = parameters; }

        void start() { executor.execute(() -> {
            boolean retry = false;
            try { retry = !sync(); }
            catch (Exception failure) { retry = true; }
            boolean needsRetry = retry;
            new Handler(Looper.getMainLooper()).post(() -> {
                if (active == this) active = null;
                if (!stopped) jobFinished(parameters, needsRetry);
            });
            executor.shutdown();
        });
        }

        void cancel() {
            stopped = true;
            HttpURLConnection current = connection; if (current != null) current.disconnect();
            executor.shutdownNow();
        }

        private boolean sync() throws Exception {
            BankQueue queue = BankQueue.get(BankSyncJob.this);
            for (int i = 0; i < 50 && !stopped && BankQueue.settings(BankSyncJob.this).getBoolean("enabled", false); i++) {
                JSONObject event = queue.next();
                if (event == null) return true;
                JSONObject config = FintrackDevicePlugin.loadConnection(BankSyncJob.this);
                if (!event.getString("server").equals(config.optString("url"))) {
                    queue.update(event.getString("id"), "review", "Адрес сервера изменён. Пуш оставлен на этом телефоне; внесите покупку вручную в нужную базу.");
                    continue;
                }
                JSONObject body = new JSONObject();
                for (String key : new String[]{"id","wallet_id","text","posted_at"}) body.put(key,event.getString(key));
                body.put("package_name", BankQueue.BANK_PACKAGE);
                try {
                    connection = (HttpURLConnection) new URL(config.getString("url") + "/api/v1/profiles/" + event.getString("profile_id") + "/notification-imports").openConnection();
                    connection.setConnectTimeout(10_000); connection.setReadTimeout(15_000);
                    connection.setInstanceFollowRedirects(false); connection.setRequestMethod("POST"); connection.setDoOutput(true);
                    String login = config.optString("username") + ":" + config.optString("password");
                    if (!login.equals(":")) connection.setRequestProperty("Authorization", "Basic " + Base64.encodeToString(login.getBytes(StandardCharsets.UTF_8),Base64.NO_WRAP));
                    connection.setRequestProperty("Content-Type", "application/json");
                    try (java.io.OutputStream stream = connection.getOutputStream()) { stream.write(body.toString().getBytes(StandardCharsets.UTF_8)); }
                    int status = connection.getResponseCode();
                    if (status == 200 || status == 201) {
                        String response;
                        try (InputStream stream = connection.getInputStream()) { response = readBounded(stream); }
                        JSONObject receipt = new JSONObject(response);
                        if (!event.getString("id").equals(receipt.optString("id")) || !"imported".equals(receipt.optString("status")) || receipt.optString("transaction_id").isEmpty()) throw new IllegalStateException("Invalid receipt");
                        queue.update(event.getString("id"), "sent", "");
                    } else if (status == 401 || status == 403 || status >= 500 || status == 408 || status == 429) {
                        queue.update(event.getString("id"), "pending", status == 401 || status == 403 ? "Проверьте логин и пароль подключения" : "Сервер недоступен. Повторим позже");
                        return false;
                    } else {
                        String message = "Не удалось добавить автоматически (HTTP " + status + "). Проверьте покупку вручную.";
                        InputStream error = connection.getErrorStream();
                        if (error != null) try (InputStream stream = error) { message = new JSONObject(readBounded(stream)).getJSONObject("error").optString("message", message); } catch (Exception ignored) { }
                        queue.update(event.getString("id"), "review", message);
                    }
                } catch (Exception failure) {
                    queue.update(event.getString("id"), "pending", "Нет связи с сервером. Пуш сохранён на телефоне");
                    return false;
                } finally { HttpURLConnection current = connection; connection = null; if (current != null) current.disconnect(); }
            }
            return queue.next() == null;
        }

        private static String readBounded(InputStream stream) throws Exception {
            java.io.ByteArrayOutputStream bytes = new java.io.ByteArrayOutputStream();
            byte[] buffer = new byte[2048]; int count;
            while ((count = stream.read(buffer)) != -1) { if (bytes.size() + count > 16384) throw new IllegalStateException("Response too large"); bytes.write(buffer,0,count); }
            return bytes.toString(StandardCharsets.UTF_8.name());
        }
    }

    @Override public boolean onStopJob(JobParameters parameters) {
        if (active != null && active.parameters.getJobId() == parameters.getJobId()) { active.cancel(); active = null; }
        return true;
    }

    @Override public void onDestroy() {
        if (active != null) { active.cancel(); active = null; }
        super.onDestroy();
    }
}
