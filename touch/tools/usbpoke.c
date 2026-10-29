// usbpoke : envoie à la barre les requêtes USB que Windows fait au branchement
// (descripteur « MS OS » 0xEE, identifiant compatible WCID, descripteur BOS).
// Usage : ./usbpoke
#include <stdio.h>
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
  if (!svc) { printf("barre introuvable\n"); return NULL; }
  IOCFPlugInInterface **plug = NULL; SInt32 score;
  kern_return_t kr = IOCreatePlugInInterfaceForService(svc, kIOUSBDeviceUserClientTypeID, kIOCFPlugInInterfaceID, &plug, &score);
  IOObjectRelease(svc);
  if (kr || !plug) { printf("plugin 0x%x\n", kr); return NULL; }
  IOUSBDeviceInterface **dev = NULL;
  (*plug)->QueryInterface(plug, CFUUIDGetUUIDBytes(kIOUSBDeviceInterfaceID), (LPVOID *)&dev);
  (*plug)->Release(plug);
  return dev;
}

static int req(IOUSBDeviceInterface **dev, const char *what, UInt8 type, UInt8 r, UInt16 val, UInt16 idx, UInt8 *buf, UInt16 len) {
  IOUSBDevRequest q = { .bmRequestType = type, .bRequest = r, .wValue = val, .wIndex = idx, .wLength = len, .pData = buf, .wLenDone = 0 };
  IOReturn kr = (*dev)->DeviceRequest(dev, &q);
  printf("%-22s -> 0x%08x, %2u o :", what, kr, (unsigned)q.wLenDone);
  for (unsigned i = 0; i < q.wLenDone && i < 48; i++) printf(" %02x", buf[i]);
  printf("\n");
  return kr == 0 ? (int)q.wLenDone : -1;
}

int main(void) {
  IOUSBDeviceInterface **dev = getdev();
  if (!dev) return 1;
  IOReturn o = (*dev)->USBDeviceOpen(dev);
  printf("ouverture USB          -> 0x%08x\n", o);
  UInt8 buf[512];
  req(dev, "descripteur appareil", 0x80, 6, 0x0100, 0, buf, 18);
  req(dev, "BOS (MS OS 2.0)", 0x80, 6, 0x0F00, 0, buf, 5);
  int n = req(dev, "chaîne MS OS 0xEE", 0x80, 6, 0x03EE, 0, buf, 0x12);
  if (n >= 17) {
    UInt8 vc = buf[16];
    printf("code fournisseur : 0x%02x\n", vc);
    req(dev, "compat ID (en-tête)", 0xC0, vc, 0, 4, buf, 0x10);
    req(dev, "compat ID", 0xC0, vc, 0, 4, buf, 0x28);
    req(dev, "propriétés (en-tête)", 0xC1, vc, 0, 5, buf, 0x0A);
  }
  if (o == 0) (*dev)->USBDeviceClose(dev);
  (*dev)->Release(dev);
  return 0;
}
