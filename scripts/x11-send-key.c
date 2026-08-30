// Deployment-smoke helper: activate one X11 window, click a terminal point, and
// send one REAL XTest key event. DevTools Input.dispatchKeyEvent is deliberately
// not used because it bypasses IBus and failed to catch the 2026-08-30 outage.
#include <X11/Xlib.h>
#include <X11/keysym.h>
#include <X11/extensions/XTest.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

int main(int argc, char **argv) {
    if (argc != 6) {
        fprintf(stderr, "usage: %s DISPLAY WINDOW X Y KEY\n", argv[0]);
        return 2;
    }
    Display *display = XOpenDisplay(argv[1]);
    if (display == NULL) {
        fprintf(stderr, "could not open X display %s\n", argv[1]);
        return 1;
    }

    Window window = strtoul(argv[2], NULL, 0);
    Window root = DefaultRootWindow(display);
    Atom active = XInternAtom(display, "_NET_ACTIVE_WINDOW", False);
    XEvent event;
    memset(&event, 0, sizeof(event));
    event.xclient.type = ClientMessage;
    event.xclient.send_event = True;
    event.xclient.display = display;
    event.xclient.window = window;
    event.xclient.message_type = active;
    event.xclient.format = 32;
    event.xclient.data.l[0] = 2; // pager/tool activation request
    XSendEvent(display, root, False,
               SubstructureRedirectMask | SubstructureNotifyMask, &event);
    XFlush(display);
    usleep(150000);

    XTestFakeMotionEvent(display, DefaultScreen(display), atoi(argv[3]), atoi(argv[4]), CurrentTime);
    XTestFakeButtonEvent(display, 1, True, CurrentTime);
    XTestFakeButtonEvent(display, 1, False, CurrentTime);
    XFlush(display);
    usleep(150000);

    const char *key_name = argv[5];
    int control = strncmp(key_name, "Ctrl+", 5) == 0;
    if (control) key_name += 5;
    KeySym symbol = XStringToKeysym(key_name);
    KeyCode code = XKeysymToKeycode(display, symbol);
    KeyCode control_code = XKeysymToKeycode(display, XK_Control_L);
    if (code == 0 || (control && control_code == 0)) {
        fprintf(stderr, "unknown key: %s\n", argv[5]);
        XCloseDisplay(display);
        return 2;
    }
    if (control) XTestFakeKeyEvent(display, control_code, True, CurrentTime);
    XTestFakeKeyEvent(display, code, True, CurrentTime);
    XTestFakeKeyEvent(display, code, False, CurrentTime);
    if (control) XTestFakeKeyEvent(display, control_code, False, CurrentTime);
    XFlush(display);
    usleep(300000);
    XCloseDisplay(display);
    return 0;
}
