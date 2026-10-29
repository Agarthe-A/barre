// usbhid : prend la main sur l'interface tactile (n°1) de la barre et lit son point d'accès
// d'interruption directement, sans passer par la couche HID de macOS.
// Usage : ./usbhid [secondes] [lire-config: 0/1]
#include <stdio.h>
#include <stdlib.h>
#include <time.h>
#include <IOKit/IOKitLib.h>
#include <IOKit/IOCFPlugIn.h>
#include <IOKit/usb/IOUSBLib.h>
#include <CoreFoundation/CoreFoundation.h>

static io_service_t findIntf(int want) {
  io_iterator_t it; io_service_t c;
  IOServiceGetMatchingServices(kIOMainPortDefault, IOServiceMatching("IOUSBHostInterface"), &it);
  while ((c = IOIteratorNext(it))) {
    int v = 0, n = -1;
    CFNumberRef cv = IORegistryEntryCreateCFProperty(c, CFSTR("idVendor"), NULL, 0);
    CFNumberRef cn = IORegistryEntryCreateCFProperty(c, CFSTR("bInterfaceNumber"), NULL, 0);
    if (cv) { CFNumberGetValue(cv, kCFNumberIntType, &v); CFRelease(cv); }
    if (cn) { CFNumberGetValue(cn, kCFNumberIntType, &n); CFRelease(cn); }
    if (v == 0x0712 && n == want) return c;
    IOObjectRelease(c);
  }
  return 0;
}

int main(int argc, char **argv) {
  int secs = argc > 1 ? atoi(argv[1]) : 30;
  int doFeat = argc > 2 ? atoi(argv[2]) : 1;
  io_service_t svc = findIntf(1);
  if (!svc) { printf("interface 1 introuvable\n"); return 1; }
  IOCFPlugInInterface **plug = NULL; SInt32 score;
  IOCreatePlugInInterfaceForService(svc, kIOUSBInterfaceUserClientTypeID, kIOCFPlugInInterfaceID, &plug, &score);
  if (!plug) { printf("plugin KO\n"); return 1; }
  IOUSBInterfaceInterface650 **intf = NULL;
  (*plug)->QueryInterface(plug, CFUUIDGetUUIDBytes(kIOUSBInterfaceInterfaceID650), (LPVOID *)&intf);
  (*plug)->Release(plug);
  if (!intf) { printf("interface KO\n"); return 1; }
  IOReturn o = (*intf)->USBInterfaceOpenSeize(intf);
  printf("prise en main de l'interface tactile -> 0x%08x\n", o); fflush(stdout);
  if (o) return 2;
  UInt8 n = 0, inPipe = 0; UInt16 inMps = 64;
  (*intf)->GetNumEndpoints(intf, &n);
  for (UInt8 i = 1; i <= n; i++) {
    UInt8 dir, num, type, interval; UInt16 mps;
    (*intf)->GetPipeProperties(intf, i, &dir, &num, &type, &mps, &interval);
    printf("tuyau %d : %s ep%d type=%d max=%d intervalle=%d\n", i, dir == kUSBIn ? "IN " : "OUT", num, type, mps, interval);
    if (dir == kUSBIn) { inPipe = i; inMps = mps; }
  }
  if (doFeat) {
    UInt8 fb[300];
    for (int id = 2; id <= 3; id++) {
      IOUSBDevRequest q = { .bmRequestType = 0xA1, .bRequest = 0x01, .wValue = (UInt16)(0x0300 | id), .wIndex = 1,
                            .wLength = (UInt16)(id == 2 ? 2 : 257), .pData = fb, .wLenDone = 0 };
      IOReturn r = (*intf)->ControlRequest(intf, 0, &q);
      printf("GET_REPORT config %d -> 0x%08x, %u o\n", id, r, (unsigned)q.wLenDone);
    }
  }
  fflush(stdout);
  time_t end = time(NULL) + secs; int got = 0, zeros = 0;
  while (time(NULL) < end && inPipe) {
    UInt8 buf[512]; UInt32 size = sizeof buf;
    IOReturn r = (*intf)->ReadPipeTO(intf, inPipe, buf, &size, 500, 1000);
    if (r == kIOReturnSuccess && size > 0) {
      int allz = 1; for (UInt32 i = 1; i < size; i++) if (buf[i]) { allz = 0; break; }
      if (allz) { zeros++; continue; }
      got++;
      if (got <= 80) { printf("%ld %u o :", (long)time(NULL), size); for (UInt32 i = 0; i < size && i < 60; i++) printf(" %02x", buf[i]); printf("\n"); fflush(stdout); }
    } else if (r != kIOUSBTransactionTimeout && r != kIOReturnTimeout && r != kIOReturnAborted) {
      printf("lecture -> 0x%08x\n", r); fflush(stdout);
      (*intf)->ClearPipeStallBothEnds(intf, inPipe);
    }
  }
  printf("fin : %d rapports avec données, %d rapports vides\n", got, zeros);
  (*intf)->USBInterfaceClose(intf);
  (*intf)->Release(intf);
  return 0;
}
