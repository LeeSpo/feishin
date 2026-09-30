import { isIPv4 } from 'net';
import { networkInterfaces } from 'os';

const toIpv4Number = (address: string) =>
    address.split('.').reduce((value, octet) => (value << 8) | Number(octet), 0) >>> 0;

export const isLocalServerOnSubnet = (interfaces = networkInterfaces()): boolean => {
    const serverAddress = toIpv4Number('10.0.0.10');
    return Object.values(interfaces).some((addresses) =>
        addresses?.some((iface) => {
            if (
                iface.internal ||
                iface.family !== 'IPv4' ||
                !isIPv4(iface.address) ||
                !isIPv4(iface.netmask)
            ) {
                return false;
            }
            const mask = toIpv4Number(iface.netmask);
            const inverse = ~mask >>> 0;
            // Ignore zero/non-contiguous masks rather than treating every network as local.
            if (mask === 0 || (inverse & (inverse + 1)) !== 0) {
                return false;
            }
            return (toIpv4Number(iface.address) & mask) === (serverAddress & mask);
        }),
    );
};
