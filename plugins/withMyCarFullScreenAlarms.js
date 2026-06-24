const fs = require("fs");
const path = require("path");
const {
  AndroidConfig,
  createRunOncePlugin,
  withAndroidManifest,
  withDangerousMod,
  withMainApplication
} = require("@expo/config-plugins");

const ALARM_PACKAGE = "com.smoti.mycar.alarm";

function ensureArray(value) {
  if (!value) {
    return [];
  }

  return Array.isArray(value) ? value : [value];
}

function addManifestItem(items, item) {
  const name = item.$["android:name"];
  if (!items.some((existing) => existing.$?.["android:name"] === name)) {
    items.push(item);
  }
}

function withAlarmManifest(config) {
  return withAndroidManifest(config, (config) => {
    const manifest = config.modResults;
    manifest.manifest["uses-permission"] = ensureArray(
      manifest.manifest["uses-permission"]
    );

    [
      "android.permission.USE_FULL_SCREEN_INTENT",
      "android.permission.WAKE_LOCK",
      "android.permission.VIBRATE",
      "android.permission.SCHEDULE_EXACT_ALARM"
    ].forEach((permission) => {
      if (!AndroidConfig.Permissions.getPermissions(manifest).includes(permission)) {
        AndroidConfig.Permissions.addPermission(manifest, permission);
      }
    });

    const application = AndroidConfig.Manifest.getMainApplicationOrThrow(
      config.modResults
    );

    application.receiver = ensureArray(application.receiver);
    addManifestItem(application.receiver, {
      $: {
        "android:name": `${ALARM_PACKAGE}.MyCarAlarmReceiver`,
        "android:exported": "false"
      }
    });

    application.activity = ensureArray(application.activity);
    addManifestItem(application.activity, {
      $: {
        "android:name": `${ALARM_PACKAGE}.MyCarAlarmActivity`,
        "android:excludeFromRecents": "true",
        "android:exported": "false",
        "android:launchMode": "singleTask",
        "android:showWhenLocked": "true",
        "android:turnScreenOn": "true",
        "android:theme": "@android:style/Theme.Material.Light.NoActionBar"
      }
    });

    return config;
  });
}

function addAlarmPackage(source) {
  if (source.includes("MyCarAlarmPackage")) {
    return source;
  }

  if (source.includes("fun getPackages(): List<ReactPackage>")) {
    const withImport = source.replace(
      /^package ([^\n]+)\n/m,
      `package $1\n\nimport ${ALARM_PACKAGE}.MyCarAlarmPackage\n`
    );

    if (withImport.includes("PackageList(this).packages.apply {")) {
      return withImport.replace(
        /PackageList\(this\)\.packages\.apply \{/m,
        "PackageList(this).packages.apply {\n              add(MyCarAlarmPackage())"
      );
    }

    return withImport.replace(
      /(\s*)return packages/m,
      "$1packages.add(MyCarAlarmPackage())\n$1return packages"
    );
  }

  if (source.includes("List<ReactPackage> getPackages()")) {
    const withImport = source.replace(
      /^package ([^;]+);/m,
      `package $1;\n\nimport ${ALARM_PACKAGE}.MyCarAlarmPackage;`
    );

    return withImport.replace(
      /(\s*)return packages;/m,
      "$1packages.add(new MyCarAlarmPackage());\n$1return packages;"
    );
  }

  throw new Error("Could not find MainApplication getPackages() to add alarms.");
}

function withAlarmPackage(config) {
  return withMainApplication(config, (config) => {
    config.modResults.contents = addAlarmPackage(config.modResults.contents);
    return config;
  });
}

function writeFileOnce(filePath, contents) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents);
}

function withAlarmSources(config) {
  return withDangerousMod(config, [
    "android",
    async (config) => {
      const srcDir = path.join(
        config.modRequest.platformProjectRoot,
        "app",
        "src",
        "main",
        "java",
        ...ALARM_PACKAGE.split(".")
      );

      writeFileOnce(path.join(srcDir, "MyCarAlarmModule.java"), alarmModule);
      writeFileOnce(path.join(srcDir, "MyCarAlarmPackage.java"), alarmPackage);
      writeFileOnce(path.join(srcDir, "MyCarAlarmReceiver.java"), alarmReceiver);
      writeFileOnce(path.join(srcDir, "MyCarAlarmActivity.java"), alarmActivity);

      return config;
    }
  ]);
}

const alarmPackage = `package ${ALARM_PACKAGE};

import com.facebook.react.ReactPackage;
import com.facebook.react.bridge.NativeModule;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.uimanager.ViewManager;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

public class MyCarAlarmPackage implements ReactPackage {
  @Override
  public List<NativeModule> createNativeModules(ReactApplicationContext reactContext) {
    List<NativeModule> modules = new ArrayList<>();
    modules.add(new MyCarAlarmModule(reactContext));
    return modules;
  }

  @Override
  public List<ViewManager> createViewManagers(ReactApplicationContext reactContext) {
    return Collections.emptyList();
  }
}
`;

const alarmModule = `package ${ALARM_PACKAGE};

import android.app.AlarmManager;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.util.Log;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.ReactContextBaseJavaModule;
import com.facebook.react.bridge.ReactMethod;
import com.facebook.react.bridge.Promise;
import com.facebook.react.bridge.ReadableMap;
import com.facebook.react.bridge.WritableNativeMap;

public class MyCarAlarmModule extends ReactContextBaseJavaModule {
  private final ReactApplicationContext reactContext;
  private static final String[] KINDS = {"mot", "roadTax", "insurance"};
  private static final String TAG = "MyCarAlarmModule";

  public MyCarAlarmModule(ReactApplicationContext reactContext) {
    super(reactContext);
    this.reactContext = reactContext;
  }

  @Override
  public String getName() {
    return "MyCarAlarmModule";
  }

  @ReactMethod
  public void getAlarmPermissions(Promise promise) {
    try {
      WritableNativeMap result = new WritableNativeMap();
      AlarmManager alarmManager =
        (AlarmManager) reactContext.getSystemService(Context.ALARM_SERVICE);
      NotificationManager notificationManager =
        (NotificationManager) reactContext.getSystemService(Context.NOTIFICATION_SERVICE);

      boolean canScheduleExactAlarms = true;
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && alarmManager != null) {
        canScheduleExactAlarms = alarmManager.canScheduleExactAlarms();
      }

      boolean canUseFullScreenIntent = true;
      if (
        Build.VERSION.SDK_INT >= 34 &&
        notificationManager != null
      ) {
        canUseFullScreenIntent = notificationManager.canUseFullScreenIntent();
      }

      result.putBoolean("nativeModuleAvailable", true);
      result.putBoolean("canScheduleExactAlarms", canScheduleExactAlarms);
      result.putBoolean("canUseFullScreenIntent", canUseFullScreenIntent);
      promise.resolve(result);
    } catch (Exception exception) {
      promise.reject("alarm_permissions_error", "Unable to read alarm permissions", exception);
    }
  }

  @ReactMethod
  public void openExactAlarmSettings() {
    try {
      Intent intent;
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
        intent = new Intent(android.provider.Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM);
        intent.setData(Uri.parse("package:" + reactContext.getPackageName()));
      } else {
        intent = new Intent(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
        intent.setData(Uri.parse("package:" + reactContext.getPackageName()));
      }
      intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
      reactContext.startActivity(intent);
    } catch (Exception exception) {
      openAppSettings();
    }
  }

  @ReactMethod
  public void openFullScreenAlarmSettings() {
    try {
      Intent intent;
      if (Build.VERSION.SDK_INT >= 34) {
        intent = new Intent("android.settings.MANAGE_APP_USE_FULL_SCREEN_INTENT");
        intent.setData(Uri.parse("package:" + reactContext.getPackageName()));
      } else {
        intent = new Intent(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
        intent.setData(Uri.parse("package:" + reactContext.getPackageName()));
      }
      intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
      reactContext.startActivity(intent);
    } catch (Exception exception) {
      openAppSettings();
    }
  }

  private void openAppSettings() {
    try {
      Intent intent = new Intent(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
      intent.setData(Uri.parse("package:" + reactContext.getPackageName()));
      intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
      reactContext.startActivity(intent);
    } catch (Exception exception) {
      Log.w(TAG, "Unable to open app settings", exception);
    }
  }

  @ReactMethod
  public void scheduleAlarm(ReadableMap alarm) {
    try {
      String carId = getRequiredString(alarm, "carId");
      String kind = getRequiredString(alarm, "kind");
      int requestCode = getRequestCode(carId, kind);
      long triggerAtMillis = Math.max(
        (long) alarm.getDouble("triggerAtMillis"),
        System.currentTimeMillis() + 1000
      );

      Intent intent = new Intent(reactContext, MyCarAlarmReceiver.class);
      intent.putExtra("requestCode", requestCode);
      intent.putExtra("carId", carId);
      intent.putExtra("registrationNumber", getRequiredString(alarm, "registrationNumber"));
      intent.putExtra("kind", kind);
      intent.putExtra("title", getRequiredString(alarm, "title"));
      intent.putExtra("body", getRequiredString(alarm, "body"));
      intent.putExtra("dueDate", getRequiredString(alarm, "dueDate"));

      PendingIntent pendingIntent = PendingIntent.getBroadcast(
        reactContext,
        requestCode,
        intent,
        PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
      );

      AlarmManager alarmManager =
        (AlarmManager) reactContext.getSystemService(Context.ALARM_SERVICE);
      if (alarmManager == null) {
        return;
      }

      Intent showIntent = new Intent(reactContext, MyCarAlarmActivity.class);
      showIntent.putExtras(intent);
      PendingIntent showPendingIntent = PendingIntent.getActivity(
        reactContext,
        requestCode,
        showIntent,
        PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
      );

      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
        alarmManager.setAlarmClock(
          new AlarmManager.AlarmClockInfo(triggerAtMillis, showPendingIntent),
          pendingIntent
        );
      } else {
        alarmManager.setExact(AlarmManager.RTC_WAKEUP, triggerAtMillis, pendingIntent);
      }
    } catch (Exception exception) {
      Log.w(TAG, "Unable to schedule full-screen alarm", exception);
    }
  }

  @ReactMethod
  public void cancelCarAlarms(String carId) {
    try {
      for (String kind : KINDS) {
        int requestCode = getRequestCode(carId, kind);
        Intent intent = new Intent(reactContext, MyCarAlarmReceiver.class);
        PendingIntent pendingIntent = PendingIntent.getBroadcast(
          reactContext,
          requestCode,
          intent,
          PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );

        AlarmManager alarmManager =
          (AlarmManager) reactContext.getSystemService(Context.ALARM_SERVICE);
        if (alarmManager != null) {
          alarmManager.cancel(pendingIntent);
        }
        pendingIntent.cancel();
      }
    } catch (Exception exception) {
      Log.w(TAG, "Unable to cancel full-screen alarms", exception);
    }
  }

  static String getRequiredString(ReadableMap map, String key) {
    if (!map.hasKey(key) || map.isNull(key)) {
      return "";
    }

    return map.getString(key);
  }

  static int getRequestCode(String carId, String kind) {
    return Math.abs((carId + ":" + kind).hashCode());
  }
}
`;

const alarmReceiver = `package ${ALARM_PACKAGE};

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.graphics.Color;
import android.media.AudioAttributes;
import android.net.Uri;
import android.os.Build;
import android.os.PowerManager;
import android.provider.Settings;
import android.util.Log;

public class MyCarAlarmReceiver extends BroadcastReceiver {
  static final String CHANNEL_ID = "mycar_full_screen_alarms";
  private static final String TAG = "MyCarAlarmReceiver";

  @Override
  public void onReceive(Context context, Intent intent) {
    try {
      createChannel(context);

      int requestCode = intent.getIntExtra("requestCode", 0);
      Intent alarmIntent = new Intent(context, MyCarAlarmActivity.class);
      alarmIntent.putExtras(intent);
      alarmIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);

      PendingIntent fullScreenIntent = PendingIntent.getActivity(
        context,
        requestCode,
        alarmIntent,
        PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
      );

      Notification.Builder builder =
        Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
          ? new Notification.Builder(context, CHANNEL_ID)
          : new Notification.Builder(context);

      builder
        .setSmallIcon(context.getApplicationInfo().icon)
        .setContentTitle(intent.getStringExtra("title"))
        .setContentText(intent.getStringExtra("body"))
        .setCategory(Notification.CATEGORY_ALARM)
        .setPriority(Notification.PRIORITY_MAX)
        .setVisibility(Notification.VISIBILITY_PUBLIC)
        .setFullScreenIntent(fullScreenIntent, true)
        .setContentIntent(fullScreenIntent)
        .setAutoCancel(true)
        .setOngoing(false);

      NotificationManager notificationManager =
        (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
      if (notificationManager != null) {
        notificationManager.notify(requestCode, builder.build());
      }

      PowerManager powerManager = (PowerManager) context.getSystemService(Context.POWER_SERVICE);
      if (powerManager != null) {
        PowerManager.WakeLock wakeLock = powerManager.newWakeLock(
          PowerManager.PARTIAL_WAKE_LOCK | PowerManager.ACQUIRE_CAUSES_WAKEUP,
          "MyCar:ReminderAlarm"
        );
        wakeLock.acquire(10000);
      }

      try {
        context.startActivity(alarmIntent);
      } catch (Exception exception) {
        Log.w(TAG, "Unable to open full-screen alarm activity", exception);
      }
    } catch (Exception exception) {
      Log.w(TAG, "Unable to show full-screen alarm", exception);
    }
  }

  private void createChannel(Context context) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
      return;
    }

    NotificationManager notificationManager =
      (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
    NotificationChannel existing = notificationManager.getNotificationChannel(CHANNEL_ID);
    if (existing != null) {
      return;
    }

    Uri soundUri = Settings.System.DEFAULT_ALARM_ALERT_URI;
    AudioAttributes audioAttributes = new AudioAttributes.Builder()
      .setUsage(AudioAttributes.USAGE_ALARM)
      .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
      .build();

    NotificationChannel channel = new NotificationChannel(
      CHANNEL_ID,
      "MyCar alarm reminders",
      NotificationManager.IMPORTANCE_HIGH
    );
    channel.setDescription("Full-screen MyCar reminder alarms");
    channel.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
    channel.enableVibration(true);
    channel.setVibrationPattern(new long[] {0, 900, 350, 900});
    channel.enableLights(true);
    channel.setLightColor(Color.YELLOW);
    channel.setSound(soundUri, audioAttributes);
    notificationManager.createNotificationChannel(channel);
  }
}
`;

const alarmActivity = `package ${ALARM_PACKAGE};

import android.app.Activity;
import android.app.NotificationManager;
import android.content.Context;
import android.graphics.Color;
import android.os.Build;
import android.os.Bundle;
import android.view.Gravity;
import android.view.Window;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;

public class MyCarAlarmActivity extends Activity {
  @Override
  protected void onCreate(Bundle savedInstanceState) {
    super.onCreate(savedInstanceState);

    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
      setShowWhenLocked(true);
      setTurnScreenOn(true);
    }

    Window window = getWindow();
    window.addFlags(
      WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON |
      WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED |
      WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON |
      WindowManager.LayoutParams.FLAG_DISMISS_KEYGUARD
    );

    int requestCode = getIntent().getIntExtra("requestCode", 0);
    String registrationNumber = getIntent().getStringExtra("registrationNumber");
    String title = getIntent().getStringExtra("title");
    String body = getIntent().getStringExtra("body");
    String dueDate = getIntent().getStringExtra("dueDate");

    LinearLayout root = new LinearLayout(this);
    root.setOrientation(LinearLayout.VERTICAL);
    root.setGravity(Gravity.CENTER);
    root.setPadding(48, 48, 48, 48);
    root.setBackgroundColor(Color.rgb(248, 250, 252));

    TextView heading = new TextView(this);
    heading.setText("MyCar Reminder Alarm");
    heading.setTextColor(Color.rgb(180, 83, 9));
    heading.setTextSize(14);
    heading.setGravity(Gravity.CENTER);
    heading.setTypeface(null, 1);
    root.addView(heading);

    TextView reg = new TextView(this);
    reg.setText(registrationNumber != null ? registrationNumber : "MyCar");
    reg.setTextColor(Color.rgb(17, 24, 39));
    reg.setTextSize(34);
    reg.setGravity(Gravity.CENTER);
    reg.setTypeface(null, 1);
    reg.setPadding(0, 28, 0, 18);
    root.addView(reg);

    TextView message = new TextView(this);
    message.setText(body != null ? body : title);
    message.setTextColor(Color.rgb(17, 24, 39));
    message.setTextSize(22);
    message.setGravity(Gravity.CENTER);
    message.setTypeface(null, 1);
    message.setPadding(0, 0, 0, 12);
    root.addView(message);

    TextView date = new TextView(this);
    date.setText(dueDate != null ? dueDate : "");
    date.setTextColor(Color.rgb(71, 85, 105));
    date.setTextSize(14);
    date.setGravity(Gravity.CENTER);
    date.setPadding(0, 0, 0, 32);
    root.addView(date);

    Button dismiss = new Button(this);
    dismiss.setText("Dismiss");
    dismiss.setOnClickListener((view) -> {
      NotificationManager notificationManager =
        (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
      notificationManager.cancel(requestCode);
      finishAndRemoveTask();
    });
    root.addView(dismiss);

    setContentView(root);
  }
}
`;

const withMyCarFullScreenAlarms = (config) => {
  config = withAlarmManifest(config);
  config = withAlarmPackage(config);
  config = withAlarmSources(config);
  return config;
};

module.exports = createRunOncePlugin(
  withMyCarFullScreenAlarms,
  "with-mycar-full-screen-alarms",
  "1.0.0"
);
