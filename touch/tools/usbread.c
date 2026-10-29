// usbread : écoute l'interface USB « fournisseur » (n°0) de la barre pendant N secondes.
#include <stdio.h>
#include <time.h>
#include <IOKit/IOKitLib.h>
#include <IOKit/IOCFPlugIn.h>
#include <IOKit/usb/IOUSBLib.h>
#include <CoreFoundation/CoreFoundation.h>
int main(int argc, char **argv) {
  int secs = argc > 1 ? atoi(argv[1]) : 30;
  io_iterator_t it; io_service_t svc = 0, cand;
  IOServiceGetMatchingServices(kIOMainPortDefault, IOServiceMatching("IOUSBHostInterface"), &it);
  while ((cand = IOIteratorNext(it))) {
    int v = 0, n = -1;
    CFNumberRef cv = IORegistryEntryCreateCFProperty(cand, CFSTR("idVendor"), NULL, 0);
    CFNumberRef cn = IORegistryEntryCreateCFProperty(cand, CFSTR("bInterfaceNumber"), NULL, 0);
    if (cv) { CFNumberGetValue(cv, kCFNumberIntType, &v); CFRelease(cv); }
    if (cn) { CFNumberGetValue(cn, kCFNumberIntType, &n); CFRelease(cn); }
    if (v == 0x0712 && n == 0) { svc = cand; break; }
    IOObjectRelease(cand);
  }
  if (!svc) { printf("interface 0 introuvable\n"); return 1; }
  IOCFPlugInInterface **plug = NULL; SInt32 score;
  IOCreatePlugInInterfaceForService(svc, kIOUSBInterfaceUserClientTypeID, kIOCFPlugInInterfaceID, &plug, &score);
  if (!plug) { printf("plugin KO\n"); return 1; }
  IOUSBInterfaceInterface **intf = NULL;
  (*plug)->QueryInterface(plug, CFUUIDGetUUIDBytes(kIOUSBInterfaceInterfaceID), (LPVOID *)&intf);
  (*plug)->Release(plug);
  IOReturn o = (*intf)->USBInterfaceOpen(intf);
  printf("ouverture interface 0 -> 0x%08x\n", o);
  if (o) return 1;
  UInt8 n = 0; (*intf)->GetNumEndpoints(intf, &n);
  UInt8 inPipe = 0;
  for (UInt8 i = 1; i <= n; i++) {
    UInt8 dir, num, type, interval; UInt16 mps;
    (*intf)->GetPipeProperties(intf, i, &dir, &num, &type, &mps, &interval);
    printf("tuyau %d : %s ep%d type=%d max=%d intervalle=%d\n", i, dir == kUSBIn ? "IN " : "OUT", num, type, mps, interval);
    if (dir == kUSBIn) inPipe = i;
  }
  fflush(stdout);
  time_t end = time(NULL) + secs; int got = 0;
  while (time(NULL) < end && inPipe) {
    UInt8 buf[512]; UInt32 size = sizeof buf;
    IOReturn r = (*intf)->ReadPipeTO(intf, inPipe, buf, &size, 500, 1000);
    if (r == kIOReturnSuccess && size > 0) {
      got++;
      if (got <= 60) { printf("%ld reçu %u o :", (long)time(NULL), size); for (UInt32 i = 0; i < size && i < 64; i++) printf(" %02x", buf[i]); printf("\n"); fflush(stdout); }
    } else if (r != kIOUSBTransactionTimeout && r != kIOReturnTimeout && r != kIOReturnAborted) {
      printf("lecture -> 0x%08x\n", r); fflush(stdout);
      (*intf)->ClearPipeStallBothEnds(intf, inPipe);
    }
  }
  printf("fin : %d paquets reçus\n", got);
  (*intf)->USBInterfaceClose(intf);
  (*intf)->Release(intf);
  return 0;
}
