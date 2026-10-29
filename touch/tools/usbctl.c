// usbctl : envoie une ou plusieurs requêtes de contrôle USB au contrôleur tactile de la barre
// (canal de contrôle de l'appareil, indépendant du pilote HID de macOS).
//
// Usage : ./usbctl "type req valeur index longueur [octets...]" ["requête 2" ...]
//   valeurs en hexadécimal, ex. :
//   ./usbctl "21 0a 0000 0001 0"            SET_IDLE(0) sur l'interface 1
//   ./usbctl "a1 01 0302 0001 2"            GET_REPORT config n°2
//   ./usbctl "21 09 0209 0001 4 80 07 d0 02" SET_REPORT sortie n°9
//   ./usbctl reset                          réinitialisation USB
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <IOKit/IOKitLib.h>
#include <IOKit/IOCFPlugIn.h>
#include <IOKit/usb/IOUSBLib.h>
#include <CoreFoundation/CoreFoundation.h>

static IOUSBDeviceInterface **getdev(void) {
  CFMutableDictionaryRef m = IOServiceMatching("IOUSBHostDevice");
  int vid = 0x0712, pid = 0x0010;
  CFDictionarySetValue(m, CFSTR(kUSBVendorID), CFNumberCreate(NULL, kCFNumberIntType, &vid));
  CFDictionarySetValue(m, CFSTR(kUSBProductID), CFNumberCreate(NULL, kCFNumberIntType, &pid));
  io_service_t svc = IOServiceGetMatchingService(kIOMainPortDefault, m);
  if (!svc) return NULL;
  IOCFPlugInInterface **plug = NULL; SInt32 score;
  IOCreatePlugInInterfaceForService(svc, kIOUSBDeviceUserClientTypeID, kIOCFPlugInInterfaceID, &plug, &score);
  IOObjectRelease(svc);
  if (!plug) return NULL;
  IOUSBDeviceInterface **dev = NULL;
  (*plug)->QueryInterface(plug, CFUUIDGetUUIDBytes(kIOUSBDeviceInterfaceID), (LPVOID *)&dev);
  (*plug)->Release(plug);
  return dev;
}

int main(int argc, char **argv) {
  IOUSBDeviceInterface **dev = getdev();
  if (!dev) { printf("barre introuvable\n"); return 1; }
  IOReturn o = (*dev)->USBDeviceOpen(dev);
  for (int a = 1; a < argc; a++) {
    if (!strcmp(argv[a], "reset")) {
      printf("réinitialisation -> 0x%08x\n", (*dev)->USBDeviceReEnumerate(dev, 0));
      continue;
    }
    if (!strncmp(argv[a], "sleep", 5)) { usleep(atoi(argv[a] + 5) * 1000); continue; }
    unsigned v[300]; int n = 0; char *s = argv[a], *e;
    while (n < 300) { unsigned long x = strtoul(s, &e, 16); if (e == s) break; v[n++] = (unsigned)x; s = e; }
    if (n < 5) { printf("requête mal formée : %s\n", argv[a]); continue; }
    UInt8 buf[600] = {0};
    for (int i = 5; i < n && i - 5 < 600; i++) buf[i - 5] = (UInt8)v[i];
    IOUSBDevRequest q = { .bmRequestType = (UInt8)v[0], .bRequest = (UInt8)v[1], .wValue = (UInt16)v[2],
                          .wIndex = (UInt16)v[3], .wLength = (UInt16)v[4], .pData = buf, .wLenDone = 0 };
    IOReturn r = (*dev)->DeviceRequest(dev, &q);
    printf("[%s] -> 0x%08x, %u o :", argv[a], r, (unsigned)q.wLenDone);
    if (v[0] & 0x80) for (unsigned i = 0; i < q.wLenDone && i < 24; i++) printf(" %02x", buf[i]);
    printf("\n");
  }
  if (o == 0) (*dev)->USBDeviceClose(dev);
  (*dev)->Release(dev);
  return 0;
}
