// winsequence : reprend le contrôleur tactile à macOS (capture, root requis), puis rejoue dans les premières
// millisecondes la séquence que Windows envoie au branchement (relevée avec USBPcap le 28/10/2026),
// et lit les rapports tactiles directement.
// Usage : sudo ./winsequence [secondes]
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <time.h>
#include <stdarg.h>
#include <pthread.h>
#include <sys/time.h>
#include <IOKit/IOKitLib.h>
#include <IOKit/IOCFPlugIn.h>
#include <IOKit/usb/IOUSBLib.h>
#include <CoreFoundation/CoreFoundation.h>

#ifndef kUSBReEnumerateCaptureDeviceMask
#define kUSBReEnumerateCaptureDeviceMask (1u << 30)
#define kUSBReEnumerateReleaseDeviceMask (1u << 29)
#endif

static FILE *LOG = NULL;
static double T0 = 0;
static double now(void) { struct timeval tv; gettimeofday(&tv, NULL); return tv.tv_sec + tv.tv_usec / 1e6; }
static void say(const char *fmt, ...) {
  char line[2048]; va_list ap; va_start(ap, fmt); vsnprintf(line, sizeof line, fmt, ap); va_end(ap);
  time_t t = time(NULL); char ts[32]; strftime(ts, sizeof ts, "%Y-%m-%d %H:%M:%S", localtime(&t));
  double ms = T0 ? (now() - T0) * 1000 : 0;
  printf("%s +%7.1f ms %s\n", ts, ms, line); fflush(stdout);
  if (LOG) { fprintf(LOG, "%s [win] +%7.1f ms %s\n", ts, ms, line); fflush(LOG); }
}

static io_service_t findDev(void) {
  CFMutableDictionaryRef m = IOServiceMatching("IOUSBHostDevice");
  int vid = 0x0712, pid = 0x0010;
  CFDictionarySetValue(m, CFSTR(kUSBVendorID), CFNumberCreate(NULL, kCFNumberIntType, &vid));
  CFDictionarySetValue(m, CFSTR(kUSBProductID), CFNumberCreate(NULL, kCFNumberIntType, &pid));
  return IOServiceGetMatchingService(kIOMainPortDefault, m);
}
static IOUSBDeviceInterface **devIf(io_service_t s) {
  IOCFPlugInInterface **plug = NULL; SInt32 score;
  IOCreatePlugInInterfaceForService(s, kIOUSBDeviceUserClientTypeID, kIOCFPlugInInterfaceID, &plug, &score);
  if (!plug) return NULL;
  IOUSBDeviceInterface **d = NULL;
  (*plug)->QueryInterface(plug, CFUUIDGetUUIDBytes(kIOUSBDeviceInterfaceID), (LPVOID *)&d);
  (*plug)->Release(plug);
  return d;
}
static io_service_t findIntf(int want) {
  io_iterator_t it; io_service_t c;
  IOServiceGetMatchingServices(kIOMainPortDefault, IOServiceMatching("IOUSBHostInterface"), &it);
  while ((c = IOIteratorNext(it))) {
    int v = 0, n = -1;
    CFNumberRef cv = IORegistryEntryCreateCFProperty(c, CFSTR("idVendor"), NULL, 0);
    CFNumberRef cn = IORegistryEntryCreateCFProperty(c, CFSTR("bInterfaceNumber"), NULL, 0);
    if (cv) { CFNumberGetValue(cv, kCFNumberIntType, &v); CFRelease(cv); }
    if (cn) { CFNumberGetValue(cn, kCFNumberIntType, &n); CFRelease(cn); }
    if (v == 0x0712 && n == want) { IOObjectRelease(it); return c; }
    IOObjectRelease(c);
  }
  IOObjectRelease(it);
  return 0;
}
static IOUSBInterfaceInterface **intfIf(io_service_t s) {
  IOCFPlugInInterface **plug = NULL; SInt32 score;
  IOCreatePlugInInterfaceForService(s, kIOUSBInterfaceUserClientTypeID, kIOCFPlugInInterfaceID, &plug, &score);
  if (!plug) return NULL;
  IOUSBInterfaceInterface **i = NULL;
  (*plug)->QueryInterface(plug, CFUUIDGetUUIDBytes(kIOUSBInterfaceInterfaceID), (LPVOID *)&i);
  (*plug)->Release(plug);
  return i;
}

static IOReturn req(IOUSBDeviceInterface **d, UInt8 t, UInt8 r, UInt16 v, UInt16 i, UInt16 l, const char *what) {
  static UInt8 buf[1024];
  IOUSBDevRequest q = { .bmRequestType = t, .bRequest = r, .wValue = v, .wIndex = i, .wLength = l, .pData = buf, .wLenDone = 0 };
  IOReturn e = (*d)->DeviceRequest(d, &q);
  say("%-26s -> 0x%08x, %u o", what, e, (unsigned)q.wLenDone);
  return e;
}

static IOUSBInterfaceInterface **G_intf = NULL;
static UInt8 G_pipe = 0;
static volatile int G_done = 0;
static int G_got = 0, G_zero = 0, G_err = 0;
static void *reader(void *a) {
  (void)a;
  while (!G_done) {
    UInt8 buf[64]; UInt32 size = sizeof buf;
    IOReturn e = (*G_intf)->ReadPipe(G_intf, G_pipe, buf, &size);
    if (G_done) break;
    if (e == kIOReturnSuccess && size > 0) {
      int allz = 1; for (UInt32 i = 1; i < size; i++) if (buf[i]) { allz = 0; break; }
      if (allz) { if (++G_zero <= 3) say("reçu %u o vide (n°%02x)", size, buf[0]); continue; }
      if (++G_got <= 60) {
        char hex[256] = ""; for (UInt32 i = 0; i < size && i < 12; i++) sprintf(hex + strlen(hex), " %02x", buf[i]);
        if (buf[0] == 4 && size >= 6)
          say("TACTILE n°%d doigt %d %s X=%d Y=%d |%s", buf[0], buf[1] & 0x3f, (buf[1] & 0x40) ? "posé" : "levé",
              buf[2] | buf[3] << 8, buf[4] | buf[5] << 8, hex);
        else say("reçu %u o :%s", size, hex);
      }
    } else if (e != kIOReturnAborted) {
      if (++G_err <= 5) say("lecture -> 0x%08x", e);
      (*G_intf)->ClearPipeStallBothEnds(G_intf, G_pipe);
      usleep(2000);
    }
  }
  return NULL;
}

int main(int argc, char **argv) {
  int secs = argc > 1 ? atoi(argv[1]) : 40;
  LOG = fopen("/tmp/barre-capture.log", "a");
  say("winsequence : début (root : %s)", geteuid() == 0 ? "oui" : "NON");
  io_service_t s = findDev();
  if (!s) { say("barre introuvable"); return 1; }
  uint64_t oldID = 0; IORegistryEntryGetRegistryEntryID(s, &oldID);
  IOUSBDeviceInterface **dev = devIf(s); IOObjectRelease(s);
  if (!dev) { say("accès appareil impossible"); return 1; }
  IOReturn o = (*dev)->USBDeviceOpenSeize(dev);
  T0 = now();
  IOReturn r = (*dev)->USBDeviceReEnumerate(dev, kUSBReEnumerateCaptureDeviceMask);
  say("capture -> 0x%08x (ouverture 0x%08x)", r, o);
  if (o == 0) (*dev)->USBDeviceClose(dev);
  (*dev)->Release(dev);
  if (r) { say("capture refusée : lancer avec sudo"); return 2; }

  // 1) Retrouver l'appareil réénuméré le plus vite possible
  IOUSBDeviceInterface **d2 = NULL;
  for (int k = 0; k < 3000 && !d2; k++) {
    io_service_t s2 = findDev();
    uint64_t id2 = 0;
    if (s2) IORegistryEntryGetRegistryEntryID(s2, &id2);
    if (s2 && id2 == oldID) { IOObjectRelease(s2); s2 = 0; }   // encore l'ancienne connexion
    if (s2) {
      IOUSBDeviceInterface **c = devIf(s2); IOObjectRelease(s2);
      if (c) {
        UInt8 b[18]; IOUSBDevRequest q = { .bmRequestType = 0x80, .bRequest = 6, .wValue = 0x0100, .wIndex = 0, .wLength = 18, .pData = b };
        if ((*c)->DeviceRequest(c, &q) == kIOReturnSuccess) d2 = c; else (*c)->Release(c);
      }
    }
    if (!d2) usleep(2000);
  }
  if (!d2) { say("appareil jamais revenu (toujours l'ancienne connexion)"); return 3; }
  say("appareil revenu (nouvelle connexion)");

  // 2) Séquence Windows (ordre et longueurs relevés dans la capture)
  req(d2, 0xC0, 0x60, 0x0000, 0x0004, 16,  "compat ID (en-tête)");
  req(d2, 0xC0, 0x60, 0x0000, 0x0004, 40,  "compat ID");
  req(d2, 0x80, 0x06, 0x0302, 0x0409, 4,   "chaîne produit (début)");
  req(d2, 0x80, 0x06, 0x0302, 0x0409, 18,  "chaîne produit");
  req(d2, 0x80, 0x00, 0x0000, 0x0000, 2,   "GET_STATUS");
  req(d2, 0x21, 0x0A, 0x0000, 0x0001, 0,   "SET_IDLE");
  req(d2, 0x81, 0x06, 0x2200, 0x0001, 904, "descripteur HID");

  // 3) Ouvrir l'interface tactile et lancer la lecture AVANT les rapports de config (comme Windows)
  for (int k = 0; k < 400 && !G_intf; k++) {
    io_service_t is = findIntf(1);
    if (is) {
      IOUSBInterfaceInterface **i = intfIf(is); IOObjectRelease(is);
      if (i) { if ((*i)->USBInterfaceOpen(i) == 0) G_intf = i; else (*i)->Release(i); }
    }
    if (!G_intf) usleep(5000);
  }
  if (!G_intf) { say("interface tactile jamais libre"); goto release; }
  {
    UInt8 n = 0; (*G_intf)->GetNumEndpoints(G_intf, &n);
    for (UInt8 i = 1; i <= n; i++) {
      UInt8 dir, num, type, interval; UInt16 mps;
      (*G_intf)->GetPipeProperties(G_intf, i, &dir, &num, &type, &mps, &interval);
      if (dir == kUSBIn) G_pipe = i;
    }
  }
  say("interface tactile ouverte, lecture lancée");
  pthread_t th; pthread_create(&th, NULL, reader, NULL);

  req(d2, 0x80, 0x06, 0x0302, 0x0409, 514, "chaîne produit (514)");
  req(d2, 0xA1, 0x01, 0x0302, 0x0001, 257, "config n°2 (l=257)");
  req(d2, 0xA1, 0x01, 0x0303, 0x0001, 257, "config n°3 (l=257)");
  say(">>> TAPOTE LA BARRE MAINTENANT (%d s) <<<", secs);

  sleep(secs);
  G_done = 1;
  (*G_intf)->AbortPipe(G_intf, G_pipe);
  pthread_join(th, NULL);
  say("fin : %d rapports avec données, %d vides, %d erreurs", G_got, G_zero, G_err);
  (*G_intf)->USBInterfaceClose(G_intf);
  (*G_intf)->Release(G_intf);

release:
  (*d2)->USBDeviceOpen(d2);
  say("rendu à macOS -> 0x%08x", (*d2)->USBDeviceReEnumerate(d2, kUSBReEnumerateReleaseDeviceMask));
  (*d2)->USBDeviceClose(d2);
  (*d2)->Release(d2);
  if (LOG) fclose(LOG);
  return 0;
}
