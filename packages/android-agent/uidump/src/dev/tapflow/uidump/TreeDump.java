package dev.tapflow.uidump;

import android.app.UiAutomation;
import android.graphics.Point;
import android.view.Display;
import android.view.accessibility.AccessibilityNodeInfo;
import java.io.File;
import java.lang.reflect.InvocationTargetException;
import java.util.concurrent.TimeoutException;

/**
 * The UI tree as `uiautomator dump` writes it, without failing on a screen that never goes idle.
 *
 * `uiautomator dump` waits for one second of quiet, up to ten, and gives up with "could not get idle state" on a
 * screen that redraws continuously (a running stopwatch, a live counter), so every selector step there failed. This
 * runs the same classes from the device's own `/system/framework/uiautomator.jar`, so the XML is the same, and only
 * changes the wait: a short quiet window, bounded, and not fatal when it runs out. Run with app_process:
 *
 *   CLASSPATH=<this jar>:/system/framework/uiautomator.jar app_process /system/bin dev.tapflow.uidump.TreeDump <out> <idle ms>
 *
 * Those classes are not public API, so they are reached by reflection. When one is missing or has another shape, it
 * prints UNSUPPORTED and exits 3, and the agent goes back to `uiautomator dump` for that device. A failure inside
 * them (another UiAutomation already connected, a node changing under the dump) is not that: it prints ERROR and
 * exits 2, and only this one read falls back.
 */
public final class TreeDump {
  private static final String UNSUPPORTED = "TAPFLOW_UIDUMP_UNSUPPORTED";
  // Three times the 100 ms the framework spaces content-change events by, so the gaps inside an animation do not read
  // as quiet and a read does not land mid-transition; a screen that never goes quiet is still read once idle ms have
  // passed. uiautomator dump asks for 1000 (measured on a still screen: 2.05 s, against 1.1 s at 100 and ~2 s at 500).
  private static final long QUIET_MS = 300;

  public static void main(String[] args) throws Exception {
    String out = args.length > 0 ? args[0] : "/dev/tty";
    long idleMs = args.length > 1 ? Long.parseLong(args[1]) : 1000;
    Class<?> wrapperClass;
    Object wrapper;
    try {
      wrapperClass = Class.forName("com.android.uiautomator.core.UiAutomationShellWrapper");
      wrapper = wrapperClass.getConstructor().newInstance();
      wrapperClass.getMethod("connect").invoke(wrapper);
    } catch (InvocationTargetException e) {
      failed(e.getCause());
      return;
    } catch (ReflectiveOperationException e) {
      unsupported(e);
      return;
    }
    try {
      UiAutomation automation = (UiAutomation) wrapperClass.getMethod("getUiAutomation").invoke(wrapper);
      try {
        automation.waitForIdle(QUIET_MS, idleMs);
      } catch (TimeoutException e) {
        // The point of this class: a screen that never settles is read as it is.
      }
      AccessibilityNodeInfo root = null;
      for (int i = 0; i < 10 && root == null; i++) {
        root = automation.getRootInActiveWindow();
        if (root == null) Thread.sleep(100);
      }
      if (root == null) {
        System.out.println("ERROR: no active window to read");
        System.exit(2);
      }
      Class<?> displays = Class.forName("android.hardware.display.DisplayManagerGlobal");
      Object global = displays.getMethod("getInstance").invoke(null);
      Display display = (Display) displays.getMethod("getRealDisplay", int.class).invoke(global, Display.DEFAULT_DISPLAY);
      Point size = new Point();
      display.getRealSize(size);
      Class.forName("com.android.uiautomator.core.AccessibilityNodeInfoDumper")
          .getMethod("dumpWindowToFile", AccessibilityNodeInfo.class, File.class, int.class, int.class, int.class)
          .invoke(null, root, new File(out), display.getRotation(), size.x, size.y);
    } catch (InvocationTargetException e) {
      failed(e.getCause());
    } catch (ReflectiveOperationException e) {
      unsupported(e);
    } catch (ClassCastException e) {
      // A hidden method that answers with another type than this was written against: the image is the problem.
      unsupported(e);
    } catch (RuntimeException e) {
      // Anything else escaping main would end the process with a stack trace and no line the agent recognises, so it
      // would retry the jar on every read without ever deciding. Said as ERROR: this read falls back.
      failed(e);
    } finally {
      try {
        wrapperClass.getMethod("disconnect").invoke(wrapper);
      } catch (ReflectiveOperationException e) {
        // Nothing to undo: the process ends here.
      }
    }
  }

  private static void failed(Throwable cause) {
    System.out.println("ERROR " + cause);
    System.exit(2);
  }

  private static void unsupported(Exception e) {
    System.out.println(UNSUPPORTED + " " + e);
    System.exit(3);
  }
}
