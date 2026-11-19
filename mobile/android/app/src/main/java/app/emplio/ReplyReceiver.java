package app.emplio;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Bundle;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.app.RemoteInput;
import androidx.core.content.ContextCompat;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import org.json.JSONObject;

// A reply typed into a notification, sent straight to the server without opening the app (the token in the notification
// is the sign-in: backend/src/push.ts /push/reply). What was typed isn't lost if it fails: it's in the notification saying so.
public class ReplyReceiver extends BroadcastReceiver {

    @Override
    public void onReceive(Context context, Intent intent) {
        Bundle input = RemoteInput.getResultsFromIntent(intent);
        CharSequence typed = input == null ? null : input.getCharSequence(Notifications.TEXT);
        String path = intent.getStringExtra("path");
        String token = intent.getStringExtra("reply");
        String url = intent.getStringExtra("replyUrl");
        if (path == null || token == null || url == null) return;
        int tag = path.hashCode();
        String text = typed == null ? "" : typed.toString().trim();
        if (text.isEmpty()) {
            NotificationManagerCompat.from(context).cancel(tag);
            return;
        }
        PendingResult pending = goAsync();
        new Thread(() -> {
            boolean sent = post(url, token, text);
            try {
                if (sent) NotificationManagerCompat.from(context).cancel(tag);
                else failed(context, tag, text);
            } finally {
                pending.finish();
            }
        }).start();
    }

    private static boolean post(String url, String token, String text) {
        HttpURLConnection http = null;
        try {
            http = (HttpURLConnection) new URL(url).openConnection();
            http.setConnectTimeout(20_000);
            http.setReadTimeout(20_000);
            http.setRequestMethod("POST");
            http.setRequestProperty("content-type", "application/json");
            http.setDoOutput(true);
            byte[] body = new JSONObject().put("token", token).put("text", text).toString().getBytes(StandardCharsets.UTF_8);
            try (OutputStream out = http.getOutputStream()) {
                out.write(body);
            }
            return http.getResponseCode() == 200;
        } catch (Exception e) {
            return false;
        } finally {
            if (http != null) http.disconnect();
        }
    }

    private static void failed(Context context, int tag, String text) {
        Notifications.channel(context);
        try {
            NotificationManagerCompat.from(context).notify(tag, new NotificationCompat.Builder(context, Notifications.CHANNEL)
                .setSmallIcon(R.drawable.ic_notification)
                .setColor(ContextCompat.getColor(context, R.color.brand))
                .setContentTitle("Your reply didn't send")
                .setContentText("Open Emplio and send it again: " + text)
                .setStyle(new NotificationCompat.BigTextStyle().bigText("Open Emplio and send it again: " + text))
                .setAutoCancel(true)
                .build());
        } catch (SecurityException ignored) {
        }
    }
}
