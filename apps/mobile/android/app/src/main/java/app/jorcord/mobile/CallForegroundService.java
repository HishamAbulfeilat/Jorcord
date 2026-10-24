package app.jorcord.mobile;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.Manifest;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import androidx.core.app.NotificationCompat;
import androidx.core.content.ContextCompat;

/** Ongoing-call foreground service: prevents Android from freezing the mic/camera/WebRTC while backgrounded. */
public class CallForegroundService extends Service {
    static final String CHANNEL = "jorcord_call";
    static final int ID = 4201;

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && "stop".equals(intent.getAction())) {
            stopForeground(true);
            stopSelf();
            return START_NOT_STICKY;
        }
        // Android 14+ throws SecurityException when a camera foreground-service type is requested without the runtime permission.
        // (CallServicePlugin.start refuses to start the service at all without RECORD_AUDIO.)
        boolean cam = ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED;
        String title = intent != null && intent.getStringExtra("title") != null ? intent.getStringExtra("title") : "Jorcord call";
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (Build.VERSION.SDK_INT >= 26) {
            nm.createNotificationChannel(new NotificationChannel(CHANNEL, "Ongoing call", NotificationManager.IMPORTANCE_LOW));
        }
        Intent open = new Intent(this, MainActivity.class).setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent pi = PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Notification n = new NotificationCompat.Builder(this, CHANNEL)
            .setContentTitle(title)
            .setContentText("Tap to return to the call")
            .setSmallIcon(R.drawable.ic_stat_jorcord)
            .setOngoing(true)
            .setContentIntent(pi)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .build();
        if (Build.VERSION.SDK_INT >= 29) {
            int types = ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE;
            if (cam && intent != null && intent.getBooleanExtra("camera", false)) types |= ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA;
            startForeground(ID, n, types);
        } else {
            startForeground(ID, n);
        }
        return START_NOT_STICKY;
    }

    @Override
    public IBinder onBind(Intent intent) { return null; }
}
