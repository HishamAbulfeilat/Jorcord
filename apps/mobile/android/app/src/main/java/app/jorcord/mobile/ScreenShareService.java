package app.jorcord.mobile;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.graphics.Bitmap;
import android.graphics.PixelFormat;
import android.hardware.display.DisplayManager;
import android.hardware.display.VirtualDisplay;
import android.media.Image;
import android.media.ImageReader;
import android.media.projection.MediaProjection;
import android.media.projection.MediaProjectionManager;
import android.os.Build;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.IBinder;
import android.os.SystemClock;
import android.util.Base64;
import android.util.DisplayMetrics;
import android.view.WindowManager;
import androidx.core.app.NotificationCompat;
import java.io.ByteArrayOutputStream;
import java.nio.ByteBuffer;

/**
 * Screen capture for sharing. A MediaProjection may only be obtained AFTER this service is in the foreground with
 * foregroundServiceType=mediaProjection (Android 10+; enforced strictly on 14+), so ScreenSharePlugin gets the user's
 * consent, starts this service with the consent result, and the service calls getMediaProjection() itself.
 * Frames are scaled down, throttled and JPEG-encoded, then handed to the plugin through {@link Callbacks}; the web layer
 * turns them into a LiveKit video track (Android WebView has no getDisplayMedia).
 */
public class ScreenShareService extends Service {
    public interface Callbacks {
        void onStarted();
        void onFrame(String jpegBase64, int width, int height);
        /** Capture ended (user stopped it in the system UI, notification Stop, locked screen, or an error). */
        void onStopped(String reason);
    }

    static final String CHANNEL = "jorcord_screenshare";
    static final int ID = 4202;
    static final String ACTION_STOP = "app.jorcord.mobile.SCREENSHARE_STOP";

    static volatile Callbacks callbacks;
    static volatile ScreenShareService instance;

    private MediaProjection projection;
    private VirtualDisplay display;
    private ImageReader reader;
    private HandlerThread thread;
    private Handler handler;
    private boolean drainScheduled;
    private boolean stopping;
    private long lastFrameAt;
    private long minIntervalMs = 125;
    private int jpegQuality = 60;
    private int outW, outH;

    private final MediaProjection.Callback projectionCallback = new MediaProjection.Callback() {
        @Override public void onStop() { shutdown("system"); }
    };

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_STOP.equals(intent.getAction())) {
            shutdown("stopped");
            return START_NOT_STICKY;
        }
        if (intent == null || projection != null) return START_NOT_STICKY;
        try {
            instance = this;
            // 1) Foreground first (the system rejects getMediaProjection otherwise).
            startInForeground();
            // 2) Then the projection from the consent result.
            int resultCode = intent.getIntExtra("resultCode", 0);
            Intent data = intent.getParcelableExtra("data");
            if (data == null) throw new IllegalStateException("missing consent data");
            int maxDim = Math.max(240, intent.getIntExtra("maxDim", 1280));
            int fps = Math.max(1, Math.min(15, intent.getIntExtra("fps", 8)));
            jpegQuality = Math.max(20, Math.min(90, intent.getIntExtra("quality", 60)));
            minIntervalMs = 1000L / fps;

            MediaProjectionManager mpm = (MediaProjectionManager) getSystemService(Context.MEDIA_PROJECTION_SERVICE);
            projection = mpm.getMediaProjection(resultCode, data);
            if (projection == null) throw new IllegalStateException("no projection");

            thread = new HandlerThread("jorcord-screenshare");
            thread.start();
            handler = new Handler(thread.getLooper());
            // Required before createVirtualDisplay (Android 14+: IllegalStateException otherwise).
            projection.registerCallback(projectionCallback, handler);

            DisplayMetrics dm = new DisplayMetrics();
            WindowManager wm = (WindowManager) getSystemService(Context.WINDOW_SERVICE);
            //noinspection deprecation
            wm.getDefaultDisplay().getRealMetrics(dm);
            float scale = Math.min(1f, (float) maxDim / Math.max(dm.widthPixels, dm.heightPixels));
            outW = even(Math.round(dm.widthPixels * scale));
            outH = even(Math.round(dm.heightPixels * scale));

            reader = ImageReader.newInstance(outW, outH, PixelFormat.RGBA_8888, 2);
            reader.setOnImageAvailableListener(r -> pump(), handler);
            display = projection.createVirtualDisplay("jorcord-screenshare", outW, outH, dm.densityDpi,
                DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR, reader.getSurface(), null, handler);
            Callbacks cb = callbacks;
            if (cb != null) cb.onStarted();
        } catch (Throwable t) {
            shutdown("error: " + t.getClass().getSimpleName());
        }
        return START_NOT_STICKY;
    }

    private static int even(int v) { return Math.max(2, v & ~1); }

    private void startInForeground() {
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (Build.VERSION.SDK_INT >= 26) {
            nm.createNotificationChannel(new NotificationChannel(CHANNEL, "Screen sharing", NotificationManager.IMPORTANCE_LOW));
        }
        PendingIntent open = PendingIntent.getActivity(this, 0,
            new Intent(this, MainActivity.class).setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        PendingIntent stop = PendingIntent.getService(this, 1,
            new Intent(this, ScreenShareService.class).setAction(ACTION_STOP),
            PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Notification n = new NotificationCompat.Builder(this, CHANNEL)
            .setContentTitle("Sharing your screen")
            .setContentText("Everyone in the call can see your screen")
            .setSmallIcon(R.drawable.ic_stat_jorcord)
            .setOngoing(true)
            .setContentIntent(open)
            .addAction(0, "Stop", stop)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .build();
        if (Build.VERSION.SDK_INT >= 29) startForeground(ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION);
        else startForeground(ID, n);
    }

    /** Runs on the capture thread. Frames inside the throttle window are not dropped: the newest one is sent when it elapses. */
    private void pump() {
        if (stopping || reader == null) return;
        long wait = lastFrameAt + minIntervalMs - SystemClock.elapsedRealtime();
        if (wait > 0) {
            if (!drainScheduled) {
                drainScheduled = true;
                handler.postDelayed(() -> { drainScheduled = false; pump(); }, wait);
            }
            return;
        }
        Image image = null;
        try {
            image = reader.acquireLatestImage();
            if (image == null) return;
            lastFrameAt = SystemClock.elapsedRealtime();
            Image.Plane plane = image.getPlanes()[0];
            ByteBuffer buf = plane.getBuffer();
            int pixelStride = plane.getPixelStride();
            int rowPadding = plane.getRowStride() - pixelStride * outW;
            Bitmap padded = Bitmap.createBitmap(outW + rowPadding / pixelStride, outH, Bitmap.Config.ARGB_8888);
            padded.copyPixelsFromBuffer(buf);
            image.close(); image = null;
            Bitmap frame = rowPadding == 0 ? padded : Bitmap.createBitmap(padded, 0, 0, outW, outH);
            ByteArrayOutputStream out = new ByteArrayOutputStream(64 * 1024);
            frame.compress(Bitmap.CompressFormat.JPEG, jpegQuality, out);
            if (frame != padded) frame.recycle();
            padded.recycle();
            Callbacks cb = callbacks;
            if (cb != null) cb.onFrame(Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP), outW, outH);
        } catch (Throwable t) {
            // A single bad frame is not fatal; the projection callback ends the session if capture really died.
        } finally {
            if (image != null) image.close();
        }
    }

    /** Idempotent. May be called from any thread. */
    void shutdown(String reason) {
        synchronized (this) {
            if (stopping) return;
            stopping = true;
        }
        try { if (display != null) display.release(); } catch (Throwable ignored) { }
        try { if (reader != null) { reader.setOnImageAvailableListener(null, null); reader.close(); } } catch (Throwable ignored) { }
        try { if (projection != null) { projection.unregisterCallback(projectionCallback); projection.stop(); } } catch (Throwable ignored) { }
        if (thread != null) thread.quitSafely();
        display = null; reader = null; projection = null;
        if (instance == this) instance = null;
        stopForeground(true);
        stopSelf();
        Callbacks cb = callbacks;
        if (cb != null) cb.onStopped(reason);
    }

    @Override public void onDestroy() {
        if (!stopping) shutdown("destroyed");
        super.onDestroy();
    }

    @Override public IBinder onBind(Intent intent) { return null; }
}
