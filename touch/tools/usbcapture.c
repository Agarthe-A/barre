// usbcapture : retire le contrôleur tactile de la barre au pilote HID de macOS (« capture », root requis),
// puis lit directement son point d'accès d'interruption avec un tampon large, pour voir ce qu'il envoie vraiment.
// Usage : sudo ./usbcapture <secondes> <init 0/1> <fichier journal>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <time.h>
#include <stdarg.h>
#include <IOKit/IOKitLib.h>
#include <IOKit/IOCFPlugIn.h>
#include <IOKit/usb/IOUSBLib.h>
#include <CoreFoundation/CoreFoundation.h>

#ifndef kUSBReEnumerateCaptureDeviceMask
#define kUSBReEnumerateCaptureDeviceMask (1u << 30)
#define kUSBReEnumerateReleaseDeviceMask (1u << 29)
#endif

#include <pthread.h>

static IOUSBInterfaceInterface **G_intf = NULL;
static UInt8 G_pipe = 0;
static int G_secs = 40;
static volatile int G_done = 0;
static void *stopper(void *arg) {
  (void)arg;
  sleep(G_secs);
  G_done = 1;
  if (G_intf) (*G_intf)->AbortPipe(G_intf, G_pipe);
  return NULL;
}

static FILE *LOG = NULL;
static void say(const char *fmt, ...) {
  char line[2048]; va_list ap; va_start(ap, fmt); vsnprintf(line, sizeof line, fmt, ap); va_end(ap);
  time_t t = time(NULL); char ts[32]; strftime(ts, sizeof ts, "%Y-%m-%d %H:%M:%S", localtime(&t));
  printf("%s %s\n", ts, line); fflush(stdout);
  if (LOG) { fprintf(LOG, "%s [capture] %s\n", ts, line); fflush(LOG); }
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

int main(int argc, char **argv) {
  int secs = argc > 1 ? atoi(argv[1]) : 40;
  int init = argc > 2 ? atoi(argv[2]) : 0;  /* 0 par défaut : ne rien envoyer */
  LOG = fopen(argc > 3 ? argv[3] : "/tmp/barre-capture.log", "a");
  say("début (root : %s), écoute %d s, init %d", geteuid() == 0 ? "oui" : "NON", secs, init);

  io_service_t s = findDev();
  if (!s) { say("barre introuvable"); return 1; }
  IOUSBDeviceInterface **dev = devIf(s);
  IOObjectRelease(s);
  if (!dev) { say("accès appareil impossible"); return 1; }
  IOReturn o = (*dev)->USBDeviceOpenSeize(dev);
  say("ouverture exclusive de l'appareil -> 0x%08x", o);
  IOReturn r = (*dev)->USBDeviceReEnumerate(dev, kUSBReEnumerateCaptureDeviceMask);
  say("capture (macOS lâche le tactile) -> 0x%08x", r);
  if (o == 0) (*dev)->USBDeviceClose(dev);
  (*dev)->Release(dev);
  if (r) { say("capture refusée : il faut lancer l'outil avec sudo"); return 2; }

  // Attendre le retour de l'appareil, sans pilote HID cette fois
  IOUSBInterfaceInterface **intf = NULL;
  for (int k = 0; k < 40 && !intf; k++) {
    usleep(250000);
    io_service_t is = findIntf(1);
    if (!is) continue;
    IOUSBInterfaceInterface **i = intfIf(is);
    IOObjectRelease(is);
    if (!i) continue;
    IOReturn e = (*i)->USBInterfaceOpen(i);
    if (e == 0) intf = i;
    else { if (k % 8 == 0) say("interface tactile pas encore libre (0x%08x)", e); (*i)->Release(i); }
  }
  if (!intf) { say("interface tactile jamais libérée"); goto release; }
  say("interface tactile ouverte en direct");

  UInt8 n = 0, inPipe = 0; (*intf)->GetNumEndpoints(intf, &n);
  for (UInt8 i = 1; i <= n; i++) {
    UInt8 dir, num, type, interval; UInt16 mps;
    (*intf)->GetPipeProperties(intf, i, &dir, &num, &type, &mps, &interval);
    say("point d'accès %d : %s ep%d type %d max %d", i, dir == kUSBIn ? "IN" : "OUT", num, type, mps);
    if (dir == kUSBIn) inPipe = i;
  }
  if (init) {
    UInt8 fb[300];
    UInt16 lens[2] = {2, 257};
    for (int id = 2; id <= 3; id++) {
      IOUSBDevRequest q = { .bmRequestType = 0xA1, .bRequest = 0x01, .wValue = (UInt16)(0x0300 | id), .wIndex = 1,
                            .wLength = lens[id - 2], .pData = fb, .wLenDone = 0 };
      IOReturn e = (*intf)->ControlRequest(intf, 0, &q);
      say("lecture config %d -> 0x%08x, %u o", id, e, (unsigned)q.wLenDone);
    }
  }

  {
    // Les canaux d'interruption n'acceptent pas de délai (ReadPipeTO) : lecture bloquante,
    // et un fil séparé interrompt la lecture au bout de « secs » secondes.
    G_intf = intf; G_pipe = inPipe; G_secs = secs;
    pthread_t th; pthread_create(&th, NULL, stopper, NULL);
    int got = 0, zeros = 0, errs = 0;
    while (!G_done && inPipe) {
      UInt8 buf[64]; UInt32 size = sizeof buf;
      IOReturn e = (*intf)->ReadPipe(intf, inPipe, buf, &size);
      if (G_done) break;
      if (e == kIOReturnSuccess && size > 0) {
        int allz = 1; for (UInt32 i = 1; i < size; i++) if (buf[i]) { allz = 0; break; }
        if (allz) { if (++zeros <= 3) say("reçu %u o, vide (id %02x)", size, buf[0]); continue; }
        if (++got <= 120) {
          char hex[512] = ""; for (UInt32 i = 0; i < size && i < 64; i++) sprintf(hex + strlen(hex), " %02x", buf[i]);
          say("reçu %u o :%s", size, hex);
        }
      } else if (e != kIOUSBTransactionTimeout && e != kIOReturnTimeout && e != kIOReturnAborted && e != kIOReturnSuccess) {
        if (++errs <= 10) say("lecture -> 0x%08x", e);
        (*intf)->ClearPipeStallBothEnds(intf, inPipe);
      }
    }
    say("fin : %d paquets avec données, %d vides, %d erreurs", got, zeros, errs);
  }
  (*intf)->USBInterfaceClose(intf);
  (*intf)->Release(intf);

release:
  s = findDev();
  if (s) {
    dev = devIf(s); IOObjectRelease(s);
    if (dev) {
      (*dev)->USBDeviceOpen(dev);
      say("rendu à macOS -> 0x%08x", (*dev)->USBDeviceReEnumerate(dev, kUSBReEnumerateReleaseDeviceMask));
      (*dev)->USBDeviceClose(dev); (*dev)->Release(dev);
    }
  }
  if (LOG) fclose(LOG);
  return 0;
}
