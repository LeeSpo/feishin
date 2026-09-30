import type { NetworkInterfaceInfo } from 'os';

import { expect, test } from 'bun:test';

import { isLocalServerOnSubnet } from '../src/main/utils/local-server-network';

const iface = (
    address: string,
    netmask = '255.255.255.0',
    overrides: Partial<NetworkInterfaceInfo> = {},
): NetworkInterfaceInfo =>
    ({
        address,
        cidr: null,
        family: 'IPv4',
        internal: false,
        mac: '00:00:00:00:00:00',
        netmask,
        ...overrides,
    }) as NetworkInterfaceInfo;

test('fixed 10.0.0.10 target uses actual masks rather than an IP prefix', () => {
    for (const [address, mask, matches] of [
        ['10.0.0.25', '255.255.255.0', true],
        ['10.0.1.25', '255.255.255.0', false],
        ['192.168.1.25', '255.255.255.0', false],
        ['10.0.1.25', '255.255.0.0', true],
        ['10.1.1.25', '255.0.0.0', true],
        ['10.0.0.129', '255.255.255.128', false],
        ['10.0.0.10', '255.255.255.255', true],
        ['10.0.0.11', '255.255.255.255', false],
    ] as const) {
        expect(isLocalServerOnSubnet({ ethernet: [iface(address, mask)] })).toBe(matches);
    }
});

test('any matching network interface counts, including a VPN', () => {
    expect(
        isLocalServerOnSubnet({
            ethernet: [iface('192.168.1.25')],
            unused: undefined,
            vpn: [iface('10.0.0.25')],
        }),
    ).toBe(true);
    expect(isLocalServerOnSubnet({ vpn: [iface('10.99.0.25')] })).toBe(false);
});

test('loopback, IPv6, invalid addresses and invalid masks cannot match', () => {
    expect(isLocalServerOnSubnet({})).toBe(false);
    for (const entry of [
        iface('10.0.0.25', undefined, { internal: true }),
        iface('::1', 'ffff:ffff:ffff:ffff::', { family: 'IPv6', scopeid: 0 }),
        iface('10.0.0.999'),
        iface('10.0.0.25', 'bad-mask'),
        iface('10.0.0.25', '255.0.255.0'),
        iface('10.0.0.25', '0.0.0.0'),
    ]) {
        expect(isLocalServerOnSubnet({ ethernet: [entry] })).toBe(false);
    }
});
