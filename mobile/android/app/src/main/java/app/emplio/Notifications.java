package app.emplio;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.app.RemoteInput;
import androidx.core.content.ContextCompat;
import com.capacitorjs.plugins.pushnotifications.PushNotificationsPlugin;
import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;
import java.util.Map;

// Takes the place of the push plugin's own receiver (AndroidManifest.xml) so a chat's notification can carry a Reply
// field, like on the iPhone (mobile/ios/App/App/AppDelegate.swift). The server sends data only (backend/src/push.ts):
// title, body, path, and for a chat a token for replying to it and where to send the reply.
public class Notifications extends FirebaseMessagingService {

    static final String CHANNEL = "messages";
    static final String TEXT = "text";

    @Override
    public void onNewToken(String token) {
        super.onNewToken(token);
        PushNotificationsPlugin.onNewToken(token);
    }

    @Override
    public void onMessageReceived(RemoteMessage message) {
        super.onMessageReceived(message);
        Map<String, String> data = message.getData();
        String path = data.get("path");
        if (data.get("body") == null || path == null) return;
        String id = message.getMessageId() == null ? String.valueOf(System.currentTimeMillis()) : message.getMessageId();
        show(this, path, data.get("title"), data.get("body"), data.get("reply"), data.get("replyUrl"), id);
    }

    static void show(Context context, String path, String title, String body, String reply, String replyUrl, String id) {
        channel(context);
        // a tap opens the app on that chat: the push plugin reads these extras ("google.message_id" marks a tap) and
        // the page opens data.path (frontend/src/app/(app)/layout.tsx)
        Intent open = new Intent(context, MainActivity.class)
            .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP)
            .putExtra("google.message_id", id)
            .putExtra("path", path);
        int tag = path.hashCode();
        NotificationCompat.Builder note = new NotificationCompat.Builder(context, CHANNEL)
            .setSmallIcon(R.drawable.ic_notification)
            .setColor(ContextCompat.getColor(context, R.color.brand))
            .setContentTitle(title == null ? "Emplio" : title)
            .setContentText(body)
            .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
            .setAutoCancel(true)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setContentIntent(PendingIntent.getActivity(context, tag, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE));
        if (reply != null && replyUrl != null) {
            Intent send = new Intent(context, ReplyReceiver.class).putExtra("path", path).putExtra("reply", reply).putExtra("replyUrl", replyUrl);
            // mutable: Android writes what was typed into it
            PendingIntent sending = PendingIntent.getBroadcast(context, tag, send, PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S ? PendingIntent.FLAG_MUTABLE : 0));
            RemoteInput field = new RemoteInput.Builder(TEXT).setLabel("Reply to Emplio").build();
            note.addAction(new NotificationCompat.Action.Builder(R.drawable.ic_notification, "Reply", sending).addRemoteInput(field).setAllowGeneratedReplies(false).build());
        }
        // one notification per chat: a newer message replaces the last
        try {
            NotificationManagerCompat.from(context).notify(tag, note.build());
        } catch (SecurityException ignored) {
            // notifications turned off for the app
        }
    }

    static void channel(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationChannel channel = new NotificationChannel(CHANNEL, "Messages", NotificationManager.IMPORTANCE_HIGH);
        channel.setDescription("Replies and updates from Emplio");
        context.getSystemService(NotificationManager.class).createNotificationChannel(channel);
    }
}
