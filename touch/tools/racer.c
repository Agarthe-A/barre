// racer : guette le branchement de la barre et lui envoie aussitôt (comme Windows) les requêtes
// « Microsoft » (compat ID), puis SET_IDLE, le descripteur HID et les rapports de configuration.
// La barre choisit son mode (souris vide / vrai tactile) dans les premiers instants après le branchement.
// Usage : ./racer   (tourne jusqu'à Ctrl+C ; journal dans ~/Library/Logs/barre/capture.log)
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <time.h>
#include <stdarg.h>
#include <sys/time.h>
#include <IOKit/IOKitLib.h>
#include <IOKit/IOCFPlugIn.h>
#include <IOKit/usb/IOUSBLib.h>
#include <CoreFoundation/CoreFoundation.h>

static FILE *LOG = NULL;
static double T0 = 0;
static double now(void) { struct timeval tv; gettimeofday(&tv, NULL); return tv.tv_sec + tv.tv_usec / 1e6; }
static void say(const char *fmt, ...) {
  char line[1024]; va_list ap; va_start(ap, fmt); vsnprintf(line, sizeof line, fmt, ap); va_end(ap);
  time_t t = time(NULL); char ts[32]; strftime(ts, sizeof ts, "%Y-%m-%d %H:%M:%S", localtime(&t));
  double ms = T0 ? (now() - T0) * 1000 : 0;
  printf("%s +%7.1f ms %s\n", ts, ms, line); fflush(stdout);
  if (LOG) { fprintf(LOG, "%s [racer] +%7.1f ms %s\n", ts, ms, line); fflush(LOG); }
}

static IOReturn req(IOUSBDeviceInterface **d, UInt8 t, UInt8 r, UInt16 v, UInt16 i, UInt16 l, const char *what) {
  static UInt8 buf[1024];
  IOUSBDevRequest q = { .bmRequestType = t, .bRequest = r, .wValue = v, .wIndex = i, .wLength = l, .pData = buf, .wLenDone = 0 };
  IOReturn e = (*d)->DeviceRequest(d, &q);
  say("%-24s -> 0x%08x, %u o", what, e, (unsigned)q.wLenDone);
  return e;
}

static void arrived(void *refcon, io_iterator_t it) {
  (void)refcon;
  io_service_t s;
  while ((s = IOIteratorNext(it))) {
    T0 = now();
    say("barre branchée : on parle avant macOS");
    IOCFPlugInInterface **plug = NULL; SInt32 score;
    IOCreatePlugInInterfaceForService(s, kIOUSBDeviceUserClientTypeID, kIOCFPlugInInterfaceID, &plug, &score);
    IOObjectRelease(s);
    if (!plug) { say("accès impossible"); continue; }
    IOUSBDeviceInterface **d = NULL;
    (*plug)->QueryInterface(plug, CFUUIDGetUUIDBytes(kIOUSBDeviceInterfaceID), (LPVOID *)&d);
    (*plug)->Release(plug);
    if (!d) continue;
    // 1) Ce que Windows envoie juste après SET_CONFIGURATION
    req(d, 0xC0, 0x60, 0x0000, 0x0004, 16, "compat ID (en-tête)");
    req(d, 0xC0, 0x60, 0x0000, 0x0004, 40, "compat ID");
    req(d, 0x80, 0x06, 0x0302, 0x0409, 4, "chaîne produit (début)");
    req(d, 0x80, 0x06, 0x0302, 0x0409, 18, "chaîne produit");
    req(d, 0x80, 0x00, 0x0000, 0x0000, 2, "GET_STATUS");
    // 2) Requêtes vers l'interface tactile : réessayer tant que la configuration n'est pas posée
    for (int k = 0; k < 200; k++) {
      if (req(d, 0x21, 0x0A, 0x0000, 0x0001, 0, "SET_IDLE") == kIOReturnSuccess) break;
      usleep(2000);
    }
    req(d, 0x81, 0x06, 0x2200, 0x0001, 904, "descripteur HID");
    req(d, 0x80, 0x06, 0x0302, 0x0409, 514, "chaîne produit (514)");
    req(d, 0xA1, 0x01, 0x0302, 0x0001, 257, "config n°2 (l=257)");
    req(d, 0xA1, 0x01, 0x0303, 0x0001, 257, "config n°3 (l=257)");
    say("séquence Windows terminée");
    (*d)->Release(d);
  }
}

int main(void) {
  LOG = fopen("/tmp/barre-racer.log", "a");
  CFMutableDictionaryRef m = IOServiceMatching("IOUSBHostDevice");
  int vid = 0x0712, pid = 0x0010;
  CFDictionarySetValue(m, CFSTR(kUSBVendorID), CFNumberCreate(NULL, kCFNumberIntType, &vid));
  CFDictionarySetValue(m, CFSTR(kUSBProductID), CFNumberCreate(NULL, kCFNumberIntType, &pid));
  IONotificationPortRef port = IONotificationPortCreate(kIOMainPortDefault);
  CFRunLoopAddSource(CFRunLoopGetCurrent(), IONotificationPortGetRunLoopSource(port), kCFRunLoopDefaultMode);
  io_iterator_t it;
  IOServiceAddMatchingNotification(port, kIOFirstPublishNotification, m, arrived, NULL, &it);
  // Vider les appareils déjà présents sans rien leur envoyer (la course ne vaut qu'au branchement)
  io_service_t s; int already = 0;
  while ((s = IOIteratorNext(it))) { already++; IOObjectRelease(s); }
  say("en attente du branchement de la barre (%s)", already ? "barre déjà branchée : débranche-la puis rebranche-la" : "branche-la");
  CFRunLoopRun();
  return 0;
}
