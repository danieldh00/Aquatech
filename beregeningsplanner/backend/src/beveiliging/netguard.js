// Uitgaande verbindingen naar adressen die een beheerder van een organisatie
// zelf invult (webshop, mailserver) mogen niet naar het eigen netwerk van de
// server: anders kan een tenant via de app het lokale netwerk aftasten.
// Daarom de naam eerst opzoeken en alleen openbare adressen toestaan; de
// verbinding gaat daarna naar precies dat adres.
const dns = require('dns').promises;
const net = require('net');

// Twee lijsten: een IPv6-regel als ::ffff:0:0/96 zou in één lijst ook elk
// IPv4-adres blokkeren.
const blocked4 = new net.BlockList();
const blocked6 = new net.BlockList();
for (const [addr, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
]) blocked4.addSubnet(addr, prefix, 'ipv4');
for (const [addr, prefix] of [
  ['::', 128], ['::1', 128], ['::ffff:0:0', 96], ['64:ff9b::', 96], ['100::', 64], ['2001:db8::', 32],
  ['fc00::', 7], ['fe80::', 10], ['ff00::', 8],
]) blocked6.addSubnet(addr, prefix, 'ipv6');

// ALLOW_PRIVATE_HOSTS=1: ook lokale adressen (alleen voor tests/ontwikkelen).
const privateAllowed = () => process.env.ALLOW_PRIVATE_HOSTS === '1';

function isPublicAddress(ip) {
  const v = net.isIP(ip);
  if (!v) return false;
  return v === 6 ? !blocked6.check(ip, 'ipv6') : !blocked4.check(ip, 'ipv4');
}

class PrivateHostError extends Error {
  constructor(host) {
    super(`${host} is geen openbaar adres.`);
    this.code = 'private_host';
  }
}

/** Zoekt de naam op; geeft het eerste adres terug als álle adressen openbaar zijn. */
async function publicAddress(host, { lookup = dns.lookup } = {}) {
  const name = String(host || '').replace(/^\[|\]$/g, '');
  const addrs = net.isIP(name) ? [name] : (await lookup(name, { all: true, verbatim: true })).map((a) => a.address);
  if (!addrs.length || !addrs.every(isPublicAddress)) throw new PrivateHostError(name);
  return addrs[0];
}

module.exports = { publicAddress, isPublicAddress, privateAllowed, PrivateHostError };
