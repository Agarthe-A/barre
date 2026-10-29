#include <stdio.h>
#include <IOKit/IOKitLib.h>
#include <IOKit/IOCFPlugIn.h>
#include <IOKit/usb/IOUSBLib.h>
#include <CoreFoundation/CoreFoundation.h>
int main(void) {
  CFMutableDictionaryRef m = IOServiceMatching("IOUSBHostDevice");
  int vid = 0x0712, pid = 0x0010;
  CFDictionarySetValue(m, CFSTR(kUSBVendorID), CFNumberCreate(NULL, kCFNumberIntType, &vid));
  CFDictionarySetValue(m, CFSTR(kUSBProductID), CFNumberCreate(NULL, kCFNumberIntType, &pid));
  io_service_t svc = IOServiceGetMatchingService(kIOMainPortDefault, m);
  IOCFPlugInInterface **plug = NULL; SInt32 score;
  IOCreatePlugInInterfaceForService(svc, kIOUSBDeviceUserClientTypeID, kIOCFPlugInInterfaceID, &plug, &score);
  IOUSBDeviceInterface **dev = NULL;
  (*plug)->QueryInterface(plug, CFUUIDGetUUIDBytes(kIOUSBDeviceInterfaceID), (LPVOID *)&dev);
  UInt8 buf[512];
  IOUSBDevRequest q = { .bmRequestType = 0x80, .bRequest = 6, .wValue = 0x0200, .wIndex = 0, .wLength = 255, .pData = buf };
  IOReturn kr = (*dev)->DeviceRequest(dev, &q);
  printf("config -> 0x%x, %u o\n", kr, (unsigned)q.wLenDone);
  for (unsigned i = 0; i < q.wLenDone; ) {
    unsigned L = buf[i], T = buf[i+1];
    printf("type %02x :", T); for (unsigned j = 0; j < L; j++) printf(" %02x", buf[i+j]); printf("\n");
    if (!L) break; i += L;
  }
  return 0;
}
